//! Small streaming builtins needed by the engine acceptance gate. Utilities here
//! are original adapters except the explicitly attributed grep subset. The full
//! utility/compatibility work is still deferred.
mod grep;
use crate::{
    executor::Budget,
    interpreter::{Context, Flow, Outcome},
    io::{Endpoint, FdTable, OpenOptions},
    state::{SharedState, absolute},
};
use shell_parser::parser::{Word, WordPart};
use std::fmt::Write as _;

/// Bashkit's is_decl_keyword starts with the command's syntax, not the name
/// produced by expansion. Quoting also prevents declaration-keyword syntax.
pub(crate) fn declaration_command(word: &Word) -> bool {
    if word.quoted || word.part_quoted.first().copied().unwrap_or(false) {
        return false;
    }
    let [WordPart::Literal(name)] = word.parts.as_slice() else {
        return false;
    };
    matches!(name.as_str(), "export" | "local" | "readonly")
        && word
            .raw
            .as_deref()
            .is_none_or(|raw| uncontinued(raw).eq(name.bytes()))
}

/// The prefix-only part of Bashkit normalize_raw_word: continuations disappear
/// before recognition. Other escapes and quotes must remain syntax. Callers
/// stop at '=' so quote handling in the assignment value is unaffected.
fn uncontinued(raw: &str) -> impl Iterator<Item = u8> + '_ {
    raw.split("\\\n").flat_map(str::bytes)
}

/// Adapted from Bashkit is_assignment_prefix/is_decl_assignment_word. Only
/// syntactic assignment operands of declaration builtins suppress splitting.
pub(crate) fn assignment_operand(word: &Word) -> bool {
    let prefix_quoted = if word.part_quoted.iter().any(|quoted| *quoted) {
        word.part_quoted.first().copied().unwrap_or(false)
    } else {
        word.quoted
    };
    if prefix_quoted {
        return false;
    }
    let Some(WordPart::Literal(prefix)) = word.parts.first() else {
        return false;
    };
    let Some((name, _)) = prefix.split_once('=') else {
        return false;
    };
    if word.raw.as_deref().is_some_and(|raw| {
        !uncontinued(raw)
            .take(name.len() + 1)
            .eq(prefix[..=name.len()].bytes())
    }) {
        return false;
    }
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
        && bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
}

pub(crate) fn is_builtin(name: &str) -> bool {
    matches!(
        name,
        ":" | "true"
            | "false"
            | "echo"
            | "printf"
            | "cat"
            | "grep"
            | "mkdir"
            | "seq"
            | "read"
            | "export"
            | "local"
            | "readonly"
            | "cd"
            | "pwd"
            | "set"
            | "exit"
            | "return"
            | "wait"
            | "kill"
    )
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
}
fn endpoint(fds: &FdTable, fd: u32) -> Result<Endpoint, i32> {
    fds.get(fd).ok_or(1)
}
async fn write(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), i32> {
    endpoint(fds, 1)?
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|e| e.status())
}
async fn copy(input: Endpoint, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let mut buffer = [0u8; 8192];
    let mut budget = Budget::default();
    loop {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let n = input
            .read_cancelled(&mut buffer, &context.cancel)
            .await
            .map_err(|e| e.status())?;
        if n == 0 {
            return Ok(());
        }
        write(fds, &buffer[..n], context).await?;
    }
}
pub(crate) async fn run(
    name: &str,
    args: Vec<String>,
    state: SharedState,
    fds: FdTable,
    context: Context,
) -> Result<Outcome, i32> {
    match name {
        ":" | "true" => {}
        "false" => return Err(1),
        "exit" | "return" => {
            if args.len() > 1 {
                return Err(2);
            }
            let code = match args.first() {
                Some(s) => s.parse::<i32>().map_err(|_| 2)?.rem_euclid(256),
                None => state.borrow().status,
            };
            if name == "return" && state.borrow().locals.is_empty() {
                return Err(1);
            }
            return Ok(Outcome {
                code,
                flow: if name == "exit" {
                    Flow::Exit
                } else {
                    Flow::Return
                },
            });
        }
        "echo" => {
            for (index, arg) in args.iter().enumerate() {
                if index != 0 {
                    write(&fds, b" ", &context).await?;
                }
                write(&fds, arg.as_bytes(), &context).await?;
            }
            write(&fds, b"\n", &context).await?;
        }
        "printf" => {
            let format = args.first().ok_or(2)?;
            let mut index = 1;
            let mut budget = Budget::default();
            loop {
                let mut chars = format.chars();
                let mut buffer = String::new();
                let mut consumed = false;
                // Stream each format pass instead of creating an unbounded result buffer.
                while let Some(ch) = chars.next() {
                    budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
                    match ch {
                        '%' => match chars.next() {
                            Some('s' | 'd') => {
                                write(&fds, buffer.as_bytes(), &context).await?;
                                buffer.clear();
                                let arg = args.get(index).map(String::as_str).unwrap_or("");
                                index += 1;
                                consumed = true;
                                write(&fds, arg.as_bytes(), &context).await?;
                            }
                            Some('%') => buffer.push('%'),
                            _ => return Err(2),
                        },
                        '\\' => buffer.push(match chars.next() {
                            Some('n') => '\n',
                            Some('r') => '\r',
                            Some('t') => '\t',
                            Some('\\') => '\\',
                            _ => return Err(2),
                        }),
                        _ => buffer.push(ch),
                    }
                    if buffer.len() >= 4096 {
                        write(&fds, buffer.as_bytes(), &context).await?;
                        buffer.clear();
                    }
                }
                write(&fds, buffer.as_bytes(), &context).await?;
                // Bash repeats a format that consumes arguments, but a format with
                // no consuming conversion is emitted only once.
                if !consumed || index >= args.len() {
                    break;
                }
            }
        }
        "cat" => {
            if args.is_empty() {
                copy(endpoint(&fds, 0)?, &fds, &context).await?;
            } else {
                for path in args {
                    let path = absolute(&state.borrow().cwd, &path);
                    let options = OpenOptions::default();
                    let input = context
                        .cancel
                        .run(context.fs().open(&path, &options))
                        .await
                        .map_err(|_| 130)?
                        .map_err(|e| e.status())?;
                    copy(input, &fds, &context).await?;
                }
            }
        }
        "grep" => return grep::run(args, &state, &fds, &context).await,
        "mkdir" => {
            let mut parents = false;
            let mut operands = Vec::new();
            let mut options = true;
            for arg in args {
                match arg.as_str() {
                    "--" if options => options = false,
                    "-p" if options => parents = true,
                    s if options && s.starts_with('-') && s != "-" => return Err(2),
                    _ => operands.push(arg),
                }
            }
            if operands.is_empty() {
                return Err(2);
            }
            let mut status = 0;
            let mut budget = Budget::default();
            for operand in operands {
                budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
                // Empty operands must not turn into the current directory under -p.
                let path = if operand.is_empty() {
                    String::new()
                } else {
                    absolute(&state.borrow().cwd, &operand)
                };
                if let Err(error) = context
                    .cancel
                    .run(context.fs().mkdir(&path, parents))
                    .await
                    .map_err(|_| 130)?
                {
                    status = 1;
                    if let Some(stderr) = fds.get(2) {
                        stderr
                            .write_all(
                                format!("mkdir: {operand}: {error}\n").as_bytes(),
                                &context.cancel,
                            )
                            .await
                            .map_err(|error| error.status())?;
                    }
                }
            }
            return Ok(Outcome::status(status));
        }
        "seq" => {
            let (start, end) = match args.as_slice() {
                [end] => (1, end.parse::<i64>().map_err(|_| 2)?),
                [start, end] => (
                    start.parse::<i64>().map_err(|_| 2)?,
                    end.parse::<i64>().map_err(|_| 2)?,
                ),
                _ => return Err(2),
            };
            let mut buffer = String::new();
            let mut budget = Budget::default();
            for n in start..=end {
                budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
                writeln!(&mut buffer, "{n}").map_err(|_| 1)?;
                if buffer.len() >= 8192 {
                    write(&fds, buffer.as_bytes(), &context).await?;
                    buffer.clear();
                }
            }
            write(&fds, buffer.as_bytes(), &context).await?;
        }
        "read" => {
            let mut fd = 0;
            let mut name = None;
            let mut iter = args.iter();
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "-r" => {}
                    "-u" => fd = iter.next().ok_or(2)?.parse().map_err(|_| 2)?,
                    s if s.starts_with('-') => return Err(2),
                    _ => {
                        if name.replace(arg.clone()).is_some() {
                            return Err(2);
                        }
                    }
                }
            }
            let input = endpoint(&fds, fd)?;
            let mut bytes = Vec::new();
            let mut byte = [0];
            let mut budget = Budget::default();
            let code = loop {
                budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
                if input
                    .read_cancelled(&mut byte, &context.cancel)
                    .await
                    .map_err(|e| e.status())?
                    == 0
                {
                    break 1;
                }
                if byte[0] == b'\n' {
                    break 0;
                }
                if bytes.len() >= context.limits().line_bytes {
                    return Err(2);
                }
                bytes.push(byte[0]);
            };
            state.borrow_mut().assign_parameter(
                name.unwrap_or_else(|| "REPLY".into()),
                String::from_utf8(bytes).map_err(|_| 2)?,
            )?;
            return Ok(Outcome::status(code));
        }
        "export" | "local" | "readonly" => {
            return declarations(name, args, &state, &fds, &context).await;
        }
        "cd" => {
            if args.len() != 1 {
                return Err(2);
            }
            let cwd = absolute(&state.borrow().cwd, &args[0]);
            state.borrow_mut().cwd = cwd;
        }
        "pwd" => {
            let cwd = state.borrow().cwd.clone();
            write(&fds, format!("{cwd}\n").as_bytes(), &context).await?;
        }
        "set" => match args.as_slice() {
            [flag, option] if option == "pipefail" && matches!(flag.as_str(), "-o" | "+o") => {
                state.borrow_mut().pipefail = flag == "-o"
            }
            _ => return Err(2),
        },
        "wait" => {
            if args.len() > 1 {
                return Err(2);
            }
            let id = args
                .first()
                .map(|s| s.trim_start_matches('%').parse::<u64>().map_err(|_| 2))
                .transpose()?;
            return Ok(Outcome::status(context.wait_job(id).await?));
        }
        "kill" => {
            if args.len() != 1 || !args[0].starts_with('%') {
                return Err(2);
            }
            context.kill_job(args[0][1..].parse().map_err(|_| 2)?)?;
        }
        _ => return Err(127),
    }
    Ok(Outcome::status(0))
}

async fn declarations(
    name: &str,
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    let mut budget = Budget::default();
    let mut status = 0;
    for arg in args {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let (key, value) = arg
            .split_once('=')
            .map(|(key, value)| (key.to_owned(), Some(value.to_owned())))
            .unwrap_or((arg, None));
        if !valid_name(&key) {
            return Err(2);
        }
        if apply_declaration(name, &key, value, &mut state.borrow_mut()).is_ok() {
            continue;
        }
        status = 1;
        if state.borrow().is_readonly(&key) {
            readonly_diagnostic(name, &key, fds, context).await?;
        }
    }
    Ok(Outcome::status(status))
}

fn apply_declaration(
    name: &str,
    key: &str,
    value: Option<String>,
    state: &mut crate::state::State,
) -> Result<(), i32> {
    if name == "readonly" {
        return state.readonly(key.to_owned(), value);
    }
    if name == "local" {
        let value = value.unwrap_or_else(|| state.variables.get(key).cloned().unwrap_or_default());
        return state.local(key.to_owned(), value);
    }
    if let Some(value) = value {
        state.assign_parameter(key.to_owned(), value)?;
    }
    state.exported.insert(key.to_owned());
    Ok(())
}

async fn readonly_diagnostic(
    builtin: &str,
    key: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    let diagnostic = format!("{builtin}: {key}: readonly variable\n");
    if let Some(stderr) = fds.get(2) {
        stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}
