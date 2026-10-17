//! Small streaming builtins needed by the engine acceptance gate. Utilities here
//! are original adapters except the explicitly attributed grep subset. The full
//! utility/compatibility work is still deferred.
mod grep;
use crate::{
    executor::Budget,
    expand::{Error, Work},
    interpreter::{Context, Flow, JobSelector, Outcome},
    io::{Endpoint, FdTable, OpenOptions},
    state::{SharedState, State, absolute},
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
    matches!(
        name.as_str(),
        "export" | "local" | "readonly" | "declare" | "typeset"
    ) && word
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
            | "declare"
            | "typeset"
            | "cd"
            | "pwd"
            | "set"
            | "exit"
            | "return"
            | "wait"
            | "kill"
            | "unset"
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
    work: &mut Work,
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
                    if let Some(input) = crate::interpreter::device_endpoint(&path, &fds) {
                        copy(input?, &fds, &context).await?;
                        continue;
                    }
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
            let name = name.unwrap_or_else(|| "REPLY".into());
            State::admit_assignment(&state, &name, bytes.len(), &context.cancel, work)
                .await
                .map_err(error_status)?;
            state
                .borrow_mut()
                .assign_parameter(name, String::from_utf8(bytes).map_err(|_| 2)?)?;
            return Ok(Outcome::status(code));
        }
        "export" | "local" | "readonly" | "declare" | "typeset" => {
            return declarations(name, args, &state, &fds, &context, work).await;
        }
        "unset" => return unset(args, &state, &fds, &context, work).await,
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
        "set" => return set(args, &state, &context, work).await,
        "wait" => {
            if args.len() > 1 {
                return Err(2);
            }
            let id = args.first().map(|s| JobSelector::parse(s)).transpose()?;
            return Ok(Outcome::status(context.wait_job(id).await?));
        }
        "kill" => {
            let (action, selector) = match kill_arguments(&args) {
                Ok(value) => value,
                Err(error) => {
                    if let Some(stderr) = fds.get(2) {
                        stderr
                            .write_all(b"kill: ", &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                        stderr
                            .write_all(error.message().as_bytes(), &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                        stderr
                            .write_all(b"\n", &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                    }
                    return Err(error.status());
                }
            };
            let selector = JobSelector::parse(selector)?;
            match action {
                SignalAction::Exists => context.check_job(selector)?,
                SignalAction::Terminate(signal) => context.kill_job(selector, signal)?,
            }
        }
        _ => return Err(127),
    }
    Ok(Outcome::status(0))
}

#[derive(Clone, Copy)]
enum SignalAction {
    Exists,
    Terminate(i32),
}

#[derive(Clone, Copy)]
enum SignalError {
    Invalid,
    Unsupported,
    Usage,
}
impl SignalError {
    fn message(self) -> &'static str {
        match self {
            Self::Invalid | Self::Usage => "invalid signal",
            Self::Unsupported => "unsupported signal action",
        }
    }
    fn status(self) -> i32 {
        match self {
            Self::Invalid => 1,
            Self::Unsupported | Self::Usage => 2,
        }
    }
}

fn kill_arguments(args: &[String]) -> Result<(SignalAction, &str), SignalError> {
    match args {
        [selector] => Ok((SignalAction::Terminate(15), selector)),
        [flag, selector] if flag.starts_with("-s") => {
            let name = flag
                .strip_prefix("-s")
                .filter(|name| !name.is_empty())
                .ok_or(SignalError::Usage)?;
            Ok((parse_signal(name)?, selector))
        }
        [flag, signal, selector] if flag == "-s" => Ok((parse_signal(signal)?, selector)),
        [flag, selector] if flag.starts_with('-') => {
            Ok((parse_signal(flag.trim_start_matches('-'))?, selector))
        }
        _ => Err(SignalError::Usage),
    }
}

fn parse_signal(value: &str) -> Result<SignalAction, SignalError> {
    if let Ok(signal) = value.parse::<i32>() {
        return classify_signal(signal);
    }
    let name = value
        .get(..3)
        .filter(|prefix| ascii_eq_ignore_case(prefix, "SIG"))
        .and_then(|_| value.get(3..))
        .unwrap_or(value);
    for (candidate, signal) in [
        ("HUP", 1),
        ("INT", 2),
        ("QUIT", 3),
        ("KILL", 9),
        ("TERM", 15),
    ] {
        if ascii_eq_ignore_case(name, candidate) {
            return Ok(SignalAction::Terminate(signal));
        }
    }
    if [
        "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "USR1", "USR2", "ALRM", "PIPE",
    ]
    .iter()
    .any(|candidate| ascii_eq_ignore_case(name, candidate))
    {
        return Err(SignalError::Unsupported);
    }
    Err(SignalError::Invalid)
}

fn classify_signal(signal: i32) -> Result<SignalAction, SignalError> {
    match signal {
        0 => Ok(SignalAction::Exists),
        1 | 2 | 3 | 9 | 15 => Ok(SignalAction::Terminate(signal)),
        4..=127 => Err(SignalError::Unsupported),
        _ => Err(SignalError::Invalid),
    }
}

fn ascii_eq_ignore_case(value: &str, expected: &str) -> bool {
    value.len() == expected.len()
        && value
            .bytes()
            .zip(expected.bytes())
            .all(|(value, expected)| value.to_ascii_uppercase() == expected)
}

fn error_status(error: Error) -> i32 {
    match error {
        Error::Status(code) => code,
        _ => 2,
    }
}

/// Original streaming adapter for Bashkit builtins/vars.rs Set. Expanded argv
/// moves into the positional frame; no side-effect vector or argv clone.
async fn set(
    mut args: Vec<String>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if args.is_empty() {
        return Err(2); // Variable/option listing remains unsupported.
    }
    let (mut nounset, mut pipefail) = {
        let state = state.borrow();
        (state.nounset, state.pipefail)
    };
    let mut index = 0;
    let mut explicit = false;
    while let Some(option) = args.get(index) {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if option == "--" || option == "-" {
            explicit = option == "--";
            index += 1;
            break;
        }
        if option == "+" {
            index += 1;
            continue;
        }
        if !option.starts_with(['-', '+']) || option.len() == 1 {
            break;
        }
        let enabled = option.starts_with('-');
        index += 1;
        if matches!(option.as_str(), "-o" | "+o") {
            set_option(
                args.get(index).ok_or(2)?,
                enabled,
                &mut nounset,
                &mut pipefail,
            )?;
            index += 1;
            continue;
        }
        set_short_options(option, enabled, &mut nounset, context, work).await?;
    }
    // All options and work admission complete before any state changes.
    let mut state = state.borrow_mut();
    state.nounset = nounset;
    state.pipefail = pipefail;
    if explicit || index < args.len() {
        args.drain(..index);
        state.replace_positional(args);
    }
    Ok(Outcome::status(0))
}

fn set_option(
    option: &str,
    enabled: bool,
    nounset: &mut bool,
    pipefail: &mut bool,
) -> Result<(), i32> {
    match option {
        "nounset" => *nounset = enabled,
        "pipefail" => *pipefail = enabled,
        _ => return Err(2),
    }
    Ok(())
}

async fn set_short_options(
    option: &str,
    enabled: bool,
    nounset: &mut bool,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    for flag in option[1..].bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if flag != b'u' {
            return Err(2);
        }
        *nounset = enabled;
    }
    Ok(())
}

async fn declarations(
    name: &str,
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut args = args.into_iter().peekable();
    let mut nameref = false;
    if matches!(name, "local" | "declare" | "typeset") {
        nameref = args.next_if(|arg| arg == "-n").is_some();
        args.next_if(|arg| arg == "--");
    }
    if args.peek().is_none() && (nameref || matches!(name, "declare" | "typeset")) {
        return Err(2);
    }
    let mut status = 0;
    for arg in args {
        // A pending reference-IFS classification belongs to the binding before
        // a declaration retargets or shadows it. Finish it before mutation.
        State::admit_scalar_access(state, "IFS", &context.cancel, work)
            .await
            .map_err(error_status)?;
        for _ in arg.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(error_status)?;
        }
        let extended = nameref || matches!(name, "declare" | "typeset");
        if extended {
            work.admit_storage(arg.len()).map_err(error_status)?;
        }
        let (key, value) = arg
            .split_once('=')
            .map(|(key, value)| (key.to_owned(), Some(value.to_owned())))
            .unwrap_or((arg, None));
        if !valid_name(&key) {
            return Err(2);
        }
        let local = name == "local"
            || matches!(name, "declare" | "typeset") && !state.borrow().locals.is_empty();
        if extended {
            let storage = state
                .borrow()
                .declaration_storage(&key, local)
                .map_err(error_status)?;
            work.admit_storage(storage).map_err(error_status)?;
        }
        if nameref {
            let result = nameref_declaration(&key, value, local, state, context, work).await;
            status |= i32::from(result.is_err());
            if let Err(code) = result
                && code == 2
            {
                return Err(2);
            }
            continue;
        }
        if let Some(value) = &value
            && !local
        {
            State::admit_assignment(state, &key, value.len(), &context.cancel, work)
                .await
                .map_err(error_status)?;
        }
        let key = if matches!(name, "export" | "readonly") {
            State::attribute_target(state, &key, name == "readonly", &context.cancel, work)
                .await
                .map_err(error_status)?
        } else {
            key
        };
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

async fn nameref_declaration(
    key: &str,
    value: Option<String>,
    local: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let target = match value {
        Some(value) => value,
        None => {
            let state = state.borrow();
            let target = state
                .namerefs
                .get(key)
                .or_else(|| state.variables.get(key))
                .ok_or(2)?;
            work.admit_storage(target.len()).map_err(error_status)?;
            target.clone()
        }
    };
    for _ in target.bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
    }
    // Array targets, unbound reference declarations and broad attributes are
    // explicit prerequisites for later units, never target-string parsing.
    if !valid_name(&target) || target == "PIPESTATUS" || key == "PIPESTATUS" {
        return Err(2);
    }
    state
        .borrow_mut()
        .declare_nameref(key.to_owned(), target, local)
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
    if name == "export" {
        return state.export(key.to_owned(), value);
    }
    if name == "local" {
        let value = value.unwrap_or_else(|| state.variables.get(key).cloned().unwrap_or_default());
        return state.local(key.to_owned(), value);
    }
    if matches!(name, "declare" | "typeset") && !state.locals.is_empty() {
        return state.local(key.to_owned(), value.unwrap_or_default());
    }
    if let Some(value) = value {
        state.assign_parameter(key.to_owned(), value)?;
    }
    Ok(())
}

/// `unset [-f] [-v] [-n] [--] name...`. Bash 5.3 ignores names that are not
/// identifiers. Without `-v` a name with no variable unsets a function.
/// `-n` (namerefs) is not implemented and fails closed.
async fn unset(
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut functions = false;
    let mut variables = false;
    let mut names = args.iter().peekable();
    while let Some(option) = names.next_if(|arg| arg.starts_with('-') && arg.len() > 1) {
        if option == "--" {
            break;
        }
        for flag in option[1..].chars() {
            match flag {
                'f' => functions = true,
                'v' => variables = true,
                'n' => return Err(2),
                _ => {
                    let diagnostic = format!(
                        "/usr/bin/bash: unset: -{flag}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]\n"
                    );
                    diagnose(fds, &diagnostic, context).await?;
                    return Ok(Outcome::status(2));
                }
            }
        }
    }
    if functions && variables {
        diagnose(
            fds,
            "/usr/bin/bash: unset: cannot simultaneously unset a function and a variable\n",
            context,
        )
        .await?;
        return Ok(Outcome::status(1));
    }
    let mut code = 0;
    let mut budget = Budget::default();
    for name in names {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if !valid_name(name) {
            continue;
        }
        if functions {
            state.borrow_mut().functions.remove(name);
            continue;
        }
        State::admit_scalar_access(state, name, &context.cancel, work)
            .await
            .map_err(error_status)?;
        let target_bytes = {
            let state = state.borrow();
            state
                .namerefs
                .contains_key(name)
                .then(|| state.scalar_target(name))
                .transpose()?
                .flatten()
                .map_or(0, str::len)
        };
        work.admit_storage(target_bytes).map_err(error_status)?;
        let removed = state.borrow_mut().unset_variable(name);
        match removed {
            Err(()) => {
                let diagnostic =
                    format!("/usr/bin/bash: unset: {name}: cannot unset: readonly variable\n");
                diagnose(fds, &diagnostic, context).await?;
                code = 1;
            }
            Ok(false) if !variables => {
                state.borrow_mut().functions.remove(name);
            }
            Ok(_) => {}
        }
    }
    Ok(Outcome::status(code))
}

async fn diagnose(fds: &FdTable, diagnostic: &str, context: &Context) -> Result<(), i32> {
    if let Some(stderr) = fds.get(2) {
        stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
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
