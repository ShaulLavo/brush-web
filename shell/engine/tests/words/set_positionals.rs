//! Positional controls adapted from Bashkit builtins/vars.rs Set and
//! spec_cases/bash/word-split.test.sh at 491c3281f668b76d64b15210b8f5d7bf97244be0.
//! Function restoration and admission/cancellation controls are original.
use super::*;

#[test]
fn set_operands_keep_the_measured_ifs_matrix_and_restore_res() {
    check_output(
        r#"res=0
sum() {
  set $@ $res
  res=$(($1 + $2))
  echo "$1 + $2 = $res"
  res=$3
}
unset IFS
sum 12 30
IFS=' '
sum 12 30
IFS=
sum 12 30
IFS=''
sum 12 30
set -u
IFS=
sum 12 30
"#,
        &"12 + 30 = 42\n".repeat(5),
    );
    for ifs in ["unset IFS", "IFS=' '", "IFS=", "IFS=''", "IFS=:"] {
        check(
            &format!("{ifs}; f() {{ set $@ tail; args \"$#\" \"$@\"; }}; f one two"),
            &[&["3", "one", "two", "tail"]],
        );
    }
}

#[test]
fn set_preserves_quoted_empty_operands_and_explicitly_clears() {
    check(
        r#"set -- 'a b' '' c; args "$#" "$1" "$2" "$3" "$@"; set "$@" ''; args "$#" "$@"; set --; args "$#" "$@"; set -- '' ''; args "$#" "$@""#,
        &[
            &["3", "a b", "", "c", "a b", "", "c"],
            &["4", "a b", "", "c", ""],
            &["0"],
            &["2", "", ""],
        ],
    );
}

#[test]
fn set_options_validate_before_installing_options_or_positionals() {
    check(
        r#"set -- caller ''; set -u; args "$#" "$@"; set +u -o pipefail -- -u '' '+value'; args "$#" "$@"; set -u +u ordinary ''; args "$#" "$@"; set -o unsupported changed; args "$?" "$#" "$@"; set -uz changed; args "$?" "$#" "$@" "$missing""#,
        &[
            &["2", "caller", ""],
            &["3", "-u", "", "+value"],
            &["2", "ordinary", ""],
            &["2", "2", "ordinary", ""],
            &["2", "2", "ordinary", "", ""],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -- present; set --; set -u; args \"$1\"; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn set_function_frames_restore_after_return_and_fatal_expansion() {
    check(
        r#"set -- outer ''; f() { set -- inner ''; g() { set nested; args "$@"; }; g; args "$@"; set --; return; }; f argument; args "$#" "$@""#,
        &[&["nested"], &["inner", ""], &["2", "outer", ""]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -- outer ''; f() { set changed; set -u; args \"$2\"; }; f argument"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run(r#"args "$#" "$@""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["2", "outer", ""]]);
}

#[test]
fn set_reuses_admitted_argv_and_rejected_growth_keeps_the_frame() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16,
        arguments: 4,
        ..Limits::default()
    });
    assert_eq!(rig.run("set -- a ''"), 0);
    assert_eq!(rig.run("set -- a b c"), 2);
    assert_eq!(rig.run(r#"args "$#" "$@""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["2", "a", ""]]);
    rig.variable("large", &"x".repeat(17));
    assert_eq!(rig.run("set -- $large"), 2);
    assert_eq!(rig.run(r#"args "$#" "$@""#), 0);
    assert_eq!(rig.calls.borrow()[1], ["2", "a", ""]);
}

#[test]
fn cancellation_after_set_restores_caller_positionals() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -- outer ''"), 0);
    rig.variable("large", &"x".repeat(300_000));
    let job = rig
        .shell
        .start("f() { set -- changed ''; ready=yes; args \"$large\"; }; f argument")
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run(r#"args "$#" "$@""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["2", "outer", ""]]);
}
