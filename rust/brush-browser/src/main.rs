mod host;
mod utilities;

use std::path::PathBuf;
use std::sync::Arc;

use brush_core::{ProfileLoadBehavior, RcLoadBehavior, Shell, ShellVariable};
use brush_interactive::{InteractiveOptions, InteractiveShell, VtInputBackend};
use tokio::sync::Mutex;

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("create the single-threaded Brush runtime");
    let status = match runtime.block_on(run()) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("brush-browser: {error}");
            1
        }
    };
    host::announce_exit(status);
    std::process::exit(i32::from(status));
}

async fn run() -> Result<u8, Box<dyn std::error::Error>> {
    let mut shell = Shell::builder()
        .interactive(true)
        .working_dir(PathBuf::from("/home/guest"))
        .shell_name("brush".to_owned())
        .profile(ProfileLoadBehavior::Skip)
        .rc(RcLoadBehavior::Skip)
        .disable_option("monitor")
        .builtins(brush_builtins::default_builtins(
            brush_builtins::BuiltinSet::BashMode,
        ))
        .var(
            "PS1",
            ShellVariable::new("\\[\\e[36m\\]brush \\w\\[\\e[0m\\] $ "),
        )
        .var("PS2", ShellVariable::new("... "))
        .var("HOME", ShellVariable::new("/home/guest"))
        .var("HISTFILE", ShellVariable::new(""))
        .var("HISTSIZE", ShellVariable::new("1000"))
        .var("PATH", ShellVariable::new(""))
        .var("TERM", ShellVariable::new("xterm-256color"))
        .build()
        .await?;
    utilities::register(&mut shell);
    let mut input = VtInputBackend::new(host::BrowserTerminal);
    input.install_key_bindings(&mut shell);
    let shell = Arc::new(Mutex::new(shell));
    let mut interactive =
        InteractiveShell::new(&shell, &mut input, &InteractiveOptions::default())?;
    interactive.run_interactively().await?;
    Ok(shell.lock().await.last_exit_status())
}
