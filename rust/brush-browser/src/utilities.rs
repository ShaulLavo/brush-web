use std::io::{Read, Write};
use std::path::PathBuf;

use brush_core::builtins::{self, ContentOptions, ContentType, SimpleCommand};
use brush_core::{Error, ExecutionContext, ExecutionResult, Shell, ShellExtensions};

use crate::host;

const COMMANDS: &[&str] = &[
    "cat",
    "ls",
    "mkdir",
    "touch",
    "rm",
    "seq",
    "sleep",
    "keydemo",
    "clear",
    "uname",
    "browser-help",
];

pub fn register(shell: &mut Shell) {
    for name in COMMANDS {
        shell.register_builtin(*name, builtins::simple_builtin::<HostCommand, _>());
    }
}

struct HostCommand;

impl SimpleCommand for HostCommand {
    fn get_content(
        _name: &str,
        _kind: ContentType,
        _options: &ContentOptions,
    ) -> Result<String, Error> {
        Ok("Browser host utility. Run browser-help for supported options.\n".to_owned())
    }

    fn execute<SE: ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
        context: ExecutionContext<'_, SE>,
        args: I,
    ) -> Result<ExecutionResult, Error> {
        let args: Vec<String> = args.skip(1).map(|arg| arg.as_ref().to_owned()).collect();
        brush_core::sys::browser::check_cancelled()?;
        if matches!(
            context.command_name.as_str(),
            "keydemo" | "clear" | "uname" | "browser-help"
        ) && !args.is_empty()
        {
            return Err(failure(format!(
                "{}: arguments are unsupported; run browser-help",
                context.command_name
            )));
        }
        match context.command_name.as_str() {
            "cat" => cat(context, &args),
            "ls" => ls(context, &args),
            "mkdir" => mkdir(context, &args),
            "touch" => touch(context, &args),
            "rm" => rm(context, &args),
            "seq" => seq(context, &args),
            "sleep" => sleep(context, &args),
            "keydemo" => keydemo(context),
            "clear" => write_bytes(context, b"\x1b[H\x1b[2J"),
            "uname" => write_bytes(context, b"Browser WASI (no native processes)\n"),
            "browser-help" => help(context),
            _ => unreachable!("registered browser utility"),
        }
    }
}

fn failure(message: impl Into<String>) -> Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into()).into()
}

fn reject_options(args: &[String]) -> Result<(), Error> {
    if let Some(option) = args
        .iter()
        .find(|arg| arg.starts_with('-') && arg.as_str() != "-")
    {
        return Err(failure(format!(
            "unsupported option {option}; run browser-help"
        )));
    }
    Ok(())
}

fn copy(mut input: impl Read, mut output: impl Write) -> Result<(), Error> {
    let mut buffer = [0u8; 8192];
    loop {
        brush_core::sys::browser::check_cancelled()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok(());
        }
        output.write_all(&buffer[..count])?;
        output.flush()?;
    }
}

fn cat(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    reject_options(args)?;
    if args.is_empty() {
        copy(context.stdin(), context.stdout())?;
        return Ok(ExecutionResult::success());
    }
    for path in args {
        cat_path(&context, path)?;
    }
    Ok(ExecutionResult::success())
}

fn cat_path(context: &ExecutionContext<'_, impl ShellExtensions>, path: &str) -> Result<(), Error> {
    if path == "-" {
        return copy(context.stdin(), context.stdout());
    }
    copy(
        std::fs::File::open(context.shell.absolute_path(path))?,
        context.stdout(),
    )
}

fn ls(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    reject_options(args)?;
    let paths = if args.is_empty() {
        vec![".".to_owned()]
    } else {
        args.to_vec()
    };
    for path in paths {
        list_path(context.shell.absolute_path(&path), &mut context.stdout())?;
    }
    Ok(ExecutionResult::success())
}

fn list_path(path: PathBuf, output: &mut impl Write) -> Result<(), Error> {
    if !path.metadata()?.is_dir() {
        writeln!(
            output,
            "{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )?;
        return Ok(());
    }
    let mut entries = std::fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        brush_core::sys::browser::check_cancelled()?;
        writeln!(
            output,
            "{}{}",
            entry.file_name().to_string_lossy(),
            if entry.file_type()?.is_dir() { "/" } else { "" }
        )?;
    }
    Ok(())
}

fn mkdir(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    let parents = args.first().is_some_and(|arg| arg == "-p");
    let paths = if parents { &args[1..] } else { args };
    reject_options(paths)?;
    if paths.is_empty() {
        return Err(failure("mkdir: expected directory"));
    }
    for path in paths {
        create_directory(context.shell.absolute_path(path), parents)?;
    }
    Ok(ExecutionResult::success())
}

fn create_directory(path: PathBuf, parents: bool) -> Result<(), Error> {
    if parents {
        std::fs::create_dir_all(path)?;
        return Ok(());
    }
    std::fs::create_dir(path)?;
    Ok(())
}

fn touch(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    reject_options(args)?;
    if args.is_empty() {
        return Err(failure("touch: expected file"));
    }
    for path in args {
        std::fs::File::options()
            .create(true)
            .append(true)
            .open(context.shell.absolute_path(path))?;
    }
    Ok(ExecutionResult::success())
}

fn rm(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    reject_options(args)?;
    if args.is_empty() {
        return Err(failure(
            "rm: expected file; directories and recursive removal are unsupported",
        ));
    }
    for path in args {
        std::fs::remove_file(context.shell.absolute_path(path))?;
    }
    Ok(ExecutionResult::success())
}

fn parse_number(value: &str) -> Result<i64, Error> {
    value
        .parse()
        .map_err(|_| failure(format!("invalid integer {value}")))
}

fn seq(
    context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    let (start, step, end) = match args {
        [end] => (1, 1, parse_number(end)?),
        [start, end] => (parse_number(start)?, 1, parse_number(end)?),
        [start, step, end] => (
            parse_number(start)?,
            parse_number(step)?,
            parse_number(end)?,
        ),
        _ => return Err(failure("seq: expected END, START END, or START STEP END")),
    };
    if step == 0 {
        return Err(failure("seq: step cannot be zero"));
    }
    let mut current = start;
    let mut output = context.stdout();
    while (step > 0 && current <= end) || (step < 0 && current >= end) {
        brush_core::sys::browser::check_cancelled()?;
        writeln!(output, "{current}")?;
        output.flush()?;
        current = current
            .checked_add(step)
            .ok_or_else(|| failure("seq: integer overflow"))?;
    }
    Ok(ExecutionResult::success())
}

fn sleep(
    _context: ExecutionContext<'_, impl ShellExtensions>,
    args: &[String],
) -> Result<ExecutionResult, Error> {
    let [seconds] = args else {
        return Err(failure("sleep: expected seconds"));
    };
    let seconds = seconds
        .parse::<f64>()
        .map_err(|_| failure("sleep: invalid seconds"))?;
    if !seconds.is_finite() || !(0.0..=86400.0).contains(&seconds) {
        return Err(failure("sleep: seconds must be between 0 and 86400"));
    }
    host::sleep_ms((seconds * 1000.0).round() as u32)?;
    Ok(ExecutionResult::success())
}

fn write_bytes(
    context: ExecutionContext<'_, impl ShellExtensions>,
    bytes: &[u8],
) -> Result<ExecutionResult, Error> {
    let mut output = context.stdout();
    output.write_all(bytes)?;
    output.flush()?;
    Ok(ExecutionResult::success())
}

fn help(context: ExecutionContext<'_, impl ShellExtensions>) -> Result<ExecutionResult, Error> {
    write_bytes(context, b"Brush runs entirely in this browser worker.\n\
Native Brush builtins include echo, printf, read, cd, pwd, aliases, functions, arrays, history, completion and shell control flow.\n\
Browser utilities: cat [FILE...], ls [PATH...], mkdir [-p] DIR..., touch FILE..., rm FILE..., seq [START [STEP]] END, sleep SECONDS, clear, uname, keydemo.\n\
keydemo draws a small key/resize panel; press q or Ctrl+C to leave.\n\
Files live in memory for this session. Native processes, packages and networking are unsupported.\n\
Try: mkdir demo; cd demo; printf 'hello\\n' > note; cat note\n\
Try: greet() { echo \"hello $1\"; }; greet browser\n")
}

fn keydemo(context: ExecutionContext<'_, impl ShellExtensions>) -> Result<ExecutionResult, Error> {
    let mut output = context.stdout();
    let _raw = host::RawGuard::new();
    output.write_all(b"\x1b[?2004l\x1b[?1049h\x1b[?25l")?;
    let result = run_keydemo(&mut output);
    output.write_all(b"\x1b[?25h\x1b[?1049l")?;
    output.flush()?;
    result?;
    Ok(ExecutionResult::success())
}

fn run_keydemo(output: &mut impl Write) -> Result<(), Error> {
    let mut last = "none".to_owned();
    let mut bytes = [0u8; 256];
    loop {
        draw_keydemo(output, &last)?;
        brush_core::sys::browser::check_cancelled()?;
        let count = host::read_bytes(&mut bytes)?;
        if count == 0 || bytes[..count].contains(&b'q') {
            return Ok(());
        }
        last = bytes[..count]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
    }
}

fn draw_keydemo(output: &mut impl Write, last: &str) -> Result<(), Error> {
    let (columns, rows) = host::size();
    write!(
        output,
        "\x1b[H\x1b[2J\x1b[36mBrush browser key demo\x1b[0m\n\nSize: {columns} columns × {rows} rows\n\nPress keys, resize, then q to leave. Ctrl+C also exits.\n\nLast bytes: {last}\n"
    )?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_options() {
        assert!(reject_options(&["--recursive".into()]).is_err());
        assert!(reject_options(&["-".into()]).is_ok());
    }

    #[test]
    fn rejects_invalid_integer() {
        assert!(parse_number("1.5").is_err());
        assert_eq!(parse_number("-12").unwrap(), -12);
    }
}
