//! Original command-substitution controls, checked against GNU Bash 5.3.15
//! (`/usr/bin/bash -c`). They run unchanged natively and on wasm32-wasip1.
use super::*;

#[test]
fn output_streams_into_fields_with_trailing_newlines_removed() {
    check(
        r#"args "$(printf 'a\n\n\nb\n\n')" $(printf 'a b\n\n') "$(true)" x$(true)y"#,
        &[&["a\n\n\nb", "a", "b", "", "xy"]],
    );
    check(
        r#"args "$(echo "$(echo inner)")" `echo tick` "`printf '%s' "a  b"`""#,
        &[&["inner", "tick", "a  b"]],
    );
}

#[test]
fn bodies_run_in_a_copy_of_the_shell_state() {
    check(
        r#"v=outer; args "$(v=inner; echo $v)" "$v"; f() { echo "f:$1"; }; args "$(f arg)""#,
        &[&["inner", "outer"], &["f:arg"]],
    );
}

#[test]
fn status_follows_each_substitution_and_empty_commands() {
    // Bash: `$?` changes as soon as a substitution ends; a command with no
    // words left takes the last substitution's status (words, then
    // redirects and assignments); a named command keeps its own status.
    check(
        r#"false; args $(exit 3) $?; args $(exit 4)$?; x=$(exit 5); args $?; x=$(exit 5) $(exit 6); args $?; $(exit 7); args $?; x=$(exit 3) true; args $?"#,
        &[&["3"], &["4"], &["5"], &["5"], &["7"], &["0"]],
    );
}

#[test]
fn operands_and_arithmetic_run_substitutions_lazily() {
    check(
        r#"unset u; v=set; args "${u:-$(echo picked)}" "${v:-$(echo skipped)}" "${u:-`echo tick`}" $((1 + $(echo 2))) "${u:-$((0 + `echo 3`))}""#,
        &[&["picked", "set", "tick", "3", "3"]],
    );
    check(
        r#"unset u; args "${u:=$(echo assigned)}" "$u""#,
        &[&["assigned", "assigned"]],
    );
}

#[test]
fn unparsed_and_backtick_syntax_errors_fail_only_the_substitution() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"args "<$((: ) word)>" "<`fi`>"; x=$((: ) word); args $?"#),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["<>", "<>"], vec!["2"]]);
}

#[test]
fn null_bytes_are_dropped_with_a_warning() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"args "$(printf 'a\0b')""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["ab"]]);
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("ignored null byte")
    );
}

#[test]
fn output_beyond_the_expansion_bound_fails_explicitly() {
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    assert_eq!(rig.run("args $(seq 1 1000); args after"), 2);
    assert_eq!(*rig.calls.borrow(), [vec!["after"]]);
}

#[test]
fn interrupt_cancels_a_running_body() {
    let rig = Rig::new(Limits::default());
    let job = rig.shell.start("x=$(while :; do :; done); args never").unwrap();
    for _ in 0..200 {
        rig.ex.drive(16);
    }
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn deeply_nested_substitutions_run_as_separate_tasks() {
    let depth = 40;
    let source = format!(
        "args {}x{}",
        "\"$(echo ".repeat(depth),
        ")\"".repeat(depth)
    );
    check(&source, &[&["x"]]);
}

#[test]
fn unset_removes_variables_functions_and_reveals_caller_locals() {
    check(
        r#"x=1; unset x; args "${x-unset}"; f() { :; }; unset f; f 2>/dev/null; args $?; g() { local y=1; unset y; args "${y-unset}"; }; y=G; g; args "$y"; h() { unset y; }; k() { local y=L; h; args "$y"; }; k; unset 1 a-b; args $?"#,
        &[&["unset"], &["127"], &["unset"], &["G"], &["G"], &["0"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("readonly r=1; unset r; args $? $r"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["1", "1"]]);
}
