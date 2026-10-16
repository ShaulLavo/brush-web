use std::process::Command;

#[test]
fn cli_keeps_stderr_separate_and_returns_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "printf out; printf err >&2; exit 7"])
        .output()
        .unwrap();
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");
    assert_eq!(output.status.code(), Some(7));
}

#[test]
fn cli_printf_reuses_consuming_formats_for_extra_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args([
            "-c",
            "printf '<%s>' a b; printf '<%s:%s>' a b c; printf fixed a b; printf '%%' a b",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"<a><b><a:b><c:>fixed%");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_printf_reuses_formats_after_field_splitting() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "values='a b'; printf '<%s>\\n' $values"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"<a>\n<b>\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_drains_both_bounded_streams() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "seq 20000 >&2; printf done"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"done");
    assert!(output.stderr.starts_with(b"1\n2\n"));
    assert!(output.stderr.ends_with(b"20000\n"));
}

#[test]
fn cli_installs_shared_compatibility_helpers_and_environment() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "argv.py a 'b c'; printenv.py HOME MISSING"])
        .env("HOME", "/home/fixture")
        .env_remove("MISSING")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"['a', 'b c']\n/home/fixture\nNone\n");
    assert!(output.stderr.is_empty());
}
