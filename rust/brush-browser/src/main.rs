mod host;
mod utilities;

use std::path::PathBuf;
use std::sync::Arc;

use brush_core::{ProfileLoadBehavior, RcLoadBehavior, Shell, ShellVariable};
use brush_interactive::{InteractiveOptions, InteractiveShell, VtInputBackend};
use tokio::sync::Mutex;
use unicode_width::UnicodeWidthChar;

#[unsafe(no_mangle)]
pub extern "C" fn browser_scalar_width(codepoint: u32) -> u32 {
    char::from_u32(codepoint)
        .and_then(UnicodeWidthChar::width)
        .unwrap_or(0) as u32
}

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

#[cfg(test)]
mod tests {
    use super::browser_scalar_width;

    #[test]
    fn scalar_widths_match_the_terminal_contract() {
        for (scalar, width) in [
            ('©', 1),
            ('❤', 1),
            ('界', 2),
            ('😀', 2),
            ('🏽', 2),
            ('\u{200d}', 0),
            ('\u{fe0f}', 0),
            ('\u{301}', 0),
        ] {
            assert_eq!(browser_scalar_width(u32::from(scalar)), width, "{scalar}");
        }
    }

    #[test]
    fn joined_emoji_keep_scalar_cell_width_with_mode_2027_off() {
        for (text, width) in [("👩‍💻", 4), ("👍🏽", 4), ("e\u{301}", 1)] {
            let actual: u32 = text
                .chars()
                .map(|scalar| browser_scalar_width(u32::from(scalar)))
                .sum();
            assert_eq!(actual, width, "{text}");
        }
    }

    #[test]
    fn invalid_scalars_have_no_cells() {
        assert_eq!(browser_scalar_width(0xd800), 0);
        assert_eq!(browser_scalar_width(0x110000), 0);
    }
}
