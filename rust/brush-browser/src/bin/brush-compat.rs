//! Non-interactive compatibility driver for `npm run compat`.
//!
//! It builds the same Brush shell as the browser binary (same patched
//! `brush-core` with `browser-host`, Bash-mode builtins and browser utilities),
//! then runs one script the way `bash -c` does. Only the interactive VT front
//! end is absent. Two Oils spec-test helpers, `argv.py` and `printenv.py`, are
//! registered as builtins so every engine receives identical helper behavior.

#[path = "../host.rs"]
#[allow(dead_code)]
mod host;
#[path = "../utilities.rs"]
mod utilities;

use std::io::Write;
use std::path::PathBuf;

use brush_core::builtins::{self, ContentOptions, ContentType, SimpleCommand};
use brush_core::{
    Error, ExecutionContext, ExecutionResult, ProfileLoadBehavior, RcLoadBehavior, Shell,
    ShellExtensions,
};

/// The workspace linker flags export this symbol from every WASI binary.
#[unsafe(no_mangle)]
pub extern "C" fn browser_scalar_width(_codepoint: u32) -> u32 {
    0
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("create the single-threaded Brush runtime");
    let status = match runtime.block_on(run()) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("brush-compat: {error}");
            2
        }
    };
    let _ = std::io::stdout().flush();
    std::process::exit(i32::from(status));
}

async fn run() -> Result<u8, Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("expected a script path")?;
    let script = std::fs::read_to_string(path)?;
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".to_owned());
    let mut shell = Shell::builder()
        .interactive(false)
        .command_string_mode(true)
        .working_dir(PathBuf::from(cwd))
        .shell_name("bash".to_owned())
        .profile(ProfileLoadBehavior::Skip)
        .rc(RcLoadBehavior::Skip)
        .builtins(brush_builtins::default_builtins(
            brush_builtins::BuiltinSet::BashMode,
        ))
        .build()
        .await?;
    utilities::register(&mut shell);
    for name in ["argv.py", "printenv.py"] {
        shell.register_builtin(name, builtins::simple_builtin::<Helper, _>());
    }
    shell.run_dash_c_command(script).await?;
    Ok(shell.last_exit_status())
}

struct Helper;

impl SimpleCommand for Helper {
    fn get_content(
        _name: &str,
        _kind: ContentType,
        _options: &ContentOptions,
    ) -> Result<String, Error> {
        Ok("Oils spec-test helper.\n".to_owned())
    }

    fn execute<SE: ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
        context: ExecutionContext<'_, SE>,
        args: I,
    ) -> Result<ExecutionResult, Error> {
        let args: Vec<String> = args.skip(1).map(|arg| arg.as_ref().to_owned()).collect();
        let text = if context.command_name == "argv.py" {
            python_list(&args)
        } else {
            args.iter()
                .map(|name| match context.shell.env().get(name) {
                    Some((_, variable)) if variable.is_exported() => {
                        format!("{}\n", variable.value().to_cow_str(context.shell))
                    }
                    _ => "None\n".to_owned(),
                })
                .collect()
        };
        context.stdout().write_all(text.as_bytes())?;
        Ok(ExecutionResult::success())
    }
}

/// Formats arguments like Python 2's `print(sys.argv[1:])`.
fn python_list(args: &[String]) -> String {
    let items: Vec<String> = args.iter().map(|arg| python_repr(arg.as_bytes())).collect();
    format!("[{}]\n", items.join(", "))
}

fn python_repr(bytes: &[u8]) -> String {
    let quote = if bytes.contains(&b'\'') && !bytes.contains(&b'"') {
        '"'
    } else {
        '\''
    };
    let mut text = String::from(quote);
    for &byte in bytes {
        match byte {
            b'\\' => text.push_str("\\\\"),
            b'\n' => text.push_str("\\n"),
            b'\r' => text.push_str("\\r"),
            b'\t' => text.push_str("\\t"),
            b'\'' if quote == '\'' => text.push_str("\\'"),
            0x20..=0x7e => text.push(char::from(byte)),
            _ => text.push_str(&format!("\\x{byte:02x}")),
        }
    }
    text.push(quote);
    text
}
