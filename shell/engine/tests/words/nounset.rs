//! Original bounded scalar nounset controls checked against GNU Bash 5.3.15.
//! General arrays, bare arithmetic names and other special parameters are not
//! part of this scalar option adapter.
use super::*;

#[test]
fn nounset_is_disabled_by_default_and_both_option_spellings_toggle_it() {
    check(
        r#"args "$missing"; set -u; empty=; args "$empty"; set +u; args "$missing"; set -o nounset; args "$empty"; set +o nounset; args "$missing""#,
        &[&[""], &[""], &[""], &[""], &[""]],
    );
    for option in ["-u", "-o nounset"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("set {option}; args \"$missing\"; args forbidden")),
            127
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 1: missing: unbound variable\n",
        );
    }
}

#[test]
fn lazy_targets_are_exempt_and_unselected_operands_are_not_read() {
    check(
        r#"set -u; empty=; full=ok; args "${missing-fallback}" "${missing:-fallback}" "${missing+unused}" "${missing:+$other}" "${full:-$other}" "${full-$other}" "${empty-$other}" "${empty:+$other}" "${empty:-fallback}" "${full:?$other}" "${full:=$other}"; args "${missing:=assigned}" "$missing"; unset missing; args "${missing=again}" "$missing""#,
        &[
            &[
                "fallback", "fallback", "", "", "ok", "ok", "", "", "fallback", "ok", "ok",
            ],
            &["assigned", "assigned"],
            &["again", "again"],
        ],
    );
}

#[test]
fn selected_lazy_operands_still_enforce_plain_variable_reads() {
    for expression in [
        "${missing-$other}",
        "${missing:-$other}",
        "${missing=$other}",
        "${missing:=$other}",
        "${missing?$other}",
        "${missing:?$other}",
        "${full+$other}",
        "${full:+$other}",
        "${empty:-$other}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -u; full=ok; empty=; args \"{expression}\" following; args forbidden"
            )),
            127,
            "{expression}",
        );
        assert!(rig.calls.borrow().is_empty(), "{expression}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 1: other: unbound variable\n",
            "{expression}"
        );
        assert!(!rig.shell.state().borrow().variables.contains_key("missing"));
    }
}

#[test]
fn indirect_nounset_distinguishes_an_unset_pointer_from_an_unset_target() {
    for (command, status, message) in [
        (r#"args "${!p}""#, 1, "p: invalid indirect expansion"),
        (
            r#"args "${!p:-fallback}""#,
            1,
            "p: invalid indirect expansion",
        ),
        (r#"p=missing; args "${!p}""#, 127, "!p: unbound variable"),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("set -u; {command}; args forbidden")),
            status,
            "{command}"
        );
        assert!(rig.calls.borrow().is_empty(), "{command}");
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line 1: {message}\n").as_bytes()
        );
    }
}

#[test]
fn indirect_nounset_keeps_empty_values_and_lazy_target_exemptions() {
    check(
        r#"p=missing; args "${!p}"; set -u; args "${!p:-fallback}" "${!p:+$other}" "${!p+unused}"; missing=; args "${!p}" "${!p-$other}" "${!p:+$other}"; missing=ok; args "${!p}" "${!p:-$other}" "${!p:=$other}" "${!p:?$other}"; unset missing; args "${!p:=assigned}" "$missing""#,
        &[
            &[""],
            &["fallback", "", ""],
            &["", "", ""],
            &["ok", "ok", "ok", "ok"],
            &["assigned", "assigned"],
        ],
    );
    for command in [
        r#"p=missing; args "${!p:-$other}""#,
        r#"p=missing; missing=ok; args "${!p:+$other}""#,
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("set -u; {command}; args forbidden")),
            127,
            "{command}"
        );
        assert!(rig.calls.borrow().is_empty(), "{command}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 1: other: unbound variable\n"
        );
    }
}

#[test]
fn explicit_error_operators_keep_their_own_messages() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -u; args ${missing:?custom}; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: missing: custom\n"
    );
}

#[test]
fn plain_reads_and_scalar_transformations_fail_before_dispatch() {
    for expression in [
        "$missing",
        "${missing}",
        "${#missing}",
        "${missing:0}",
        "${missing%x}",
        "${missing#x}",
        "${missing/x/y}",
        "${missing^^}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -u\nargs before \"{expression}\" after\nargs forbidden\n"
            )),
            127,
            "{expression}",
        );
        assert!(rig.calls.borrow().is_empty(), "{expression}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 2: missing: unbound variable\n",
            "{expression}"
        );
    }
}

#[test]
fn empty_bindings_are_readable_and_positional_lists_remain_exempt() {
    check(
        r#"set -u; empty=; args "$empty" "${#empty}" "${empty:0}" "${empty%x}" "${empty/x/y}" "${empty^^}" "$@" "$*" "$#" "$?"; f() { args "$1" "$2" "$@"; }; f one ''"#,
        &[
            &["", "0", "", "", "", "", "", "0", "0"],
            &["one", "", "one", ""],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -u; args \"$1\"; args forbidden"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: 1: unbound variable\n"
    );
}

#[test]
fn heredoc_nounset_aborts_only_its_command_and_preserves_following_status() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -u\ncat <<EOF\n$unset_var\nEOF\necho \"should not print\"\nargs \"$?\"\n"),
        0,
    );
    assert_eq!(rig.output.bytes(), b"should not print\n");
    assert_eq!(*rig.calls.borrow(), [vec!["0"]]);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 2: unset_var: unbound variable\n"
    );
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -u; args before <<EOF; args \"$?\" after\n$missing\nEOF\n"),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["127", "after"]]);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: missing: unbound variable\n"
    );
}

#[test]
fn builtin_and_function_heredoc_nounset_is_fatal_in_the_current_shell() {
    for command in ["echo before", ":", "f"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("f() {{ args forbidden; }}; set -u\n{command} <<EOF\n$missing\nEOF\nargs forbidden\n")), 127, "{command}");
        assert!(rig.calls.borrow().is_empty());
        assert!(rig.output.bytes().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 2: missing: unbound variable\n"
        );
    }
}

#[test]
fn unnamed_heredoc_nounset_aborts_only_the_redirection_with_status_one() {
    for command in ["", "value=ok"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -u\n{command} <<EOF\n$missing\nEOF\nargs \"$?\" after\n"
            )),
            0,
            "{command}"
        );
        assert_eq!(*rig.calls.borrow(), [vec!["1", "after"]]);
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 2: missing: unbound variable\n"
        );
    }
}

#[test]
fn quoted_heredocs_do_not_read_parameters() {
    check_output(
        "set -u\ncat <<'EOF'\n$missing\nEOF\necho after\n",
        "$missing\nafter\n",
    );
}

#[test]
fn prefix_rhs_failure_is_fatal_even_when_the_command_has_a_heredoc() {
    for command in [
        "TEMP=inside value=$missing args",
        "TEMP=inside value=$missing args <<EOF\nbody\nEOF\n",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("TEMP", "before");
        assert_eq!(
            rig.run(&format!("set -u\n{command}\nargs forbidden\n")),
            127
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 2: missing: unbound variable\n"
        );
        assert_eq!(
            rig.shell
                .state()
                .borrow()
                .variables
                .get("TEMP")
                .map(String::as_str),
            Some("before")
        );
        assert!(!rig.shell.state().borrow().variables.contains_key("value"));
    }
    let rig = Rig::new(Limits::default());
    let observed = rig.calls.clone();
    rig.host.register("observe", move |request, _| {
        let observed = observed.clone();
        async move {
            observed.borrow_mut().push(vec![
                request.env["first"].clone(),
                request.env["second"].clone(),
            ]);
            0
        }
        .boxed_local()
    });
    assert_eq!(
        rig.run(
            r#"set -u; first=one second=$first observe; args "${first-unset}" "${second-unset}""#
        ),
        0
    );
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["one", "one"], vec!["unset", "unset"]]
    );
}

#[test]
fn command_substitutions_inherit_nounset_but_fail_only_the_child() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"set -u; args "$(args "$missing"; echo forbidden)" "$?"; value=$(args "$missing"); args "$?" "$value"; args after"#),
        0,
    );
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["", "1"], vec!["1", ""], vec!["after"]]
    );
    assert_eq!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .matches("missing: unbound variable")
            .count(),
        2
    );
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn isolated_option_changes_do_not_leak_to_the_parent() {
    check(
        r#"set -u; args "$(set +u; echo "$missing")"; (set +u; args "$missing"); args "${missing-fallback}""#,
        &[&[""], &[""], &["fallback"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -u; (set +u); args \"$missing\"; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn nounset_diagnostic_storage_failure_does_not_dispatch_or_print_partial_errors() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    assert_eq!(rig.run("set -u"), 0);
    assert_eq!(rig.run("args $missing"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn cancellation_before_a_later_unbound_read_has_no_partial_dispatch_or_diagnostic() {
    let rig = Rig::new(Limits::default());
    rig.variable("TEMP", "before");
    assert_eq!(rig.run("set -u"), 0);
    let source = format!(
        "TEMP=inside value=${{missing:-{}}} later=$missing args",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    rig.drive_until_variable("TEMP", "inside");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("TEMP")
            .map(String::as_str),
        Some("before")
    );
    assert!(!rig.shell.state().borrow().variables.contains_key("value"));
}

#[test]
fn failed_command_local_heredoc_readers_discard_their_parameter_effects() {
    for (command, status) in [("cat", "127"), ("", "1"), ("value=kept", "1")] {
        for body in ["${x:=changed}$missing", "${x:=changed}${missing:?oops}"] {
            let rig = Rig::new(Limits::default());
            let source = format!(
                "unset x; set -u\n{command} <<EOF\n{body}\nEOF\nargs \"$?\" \"${{x-unset}}\"\n"
            );
            assert_eq!(rig.run(&source), 0, "{source}");
            assert_eq!(*rig.calls.borrow(), [vec![status, "unset"]], "{source}");
            assert!(rig.output.bytes().is_empty(), "{source}");
            assert!(!rig.errors.bytes().is_empty(), "{source}");
            assert_eq!(rig.host.active_count(), 0);
            assert_eq!(rig.host.retained_count(), 0);
        }
    }
}

#[test]
fn command_local_heredoc_arithmetic_failure_does_not_discard_the_caller_read_unit() {
    for command in ["cat", "", "value=kept"] {
        let rig = Rig::new(Limits::default());
        let source = format!(
            "unset x\n{command} <<EOF; args \"$?\" \"${{x-unset}}\"\n${{x:=changed}}$((1/0))\nEOF\n"
        );
        assert_eq!(rig.run(&source), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), [vec!["1", "unset"]], "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
    }
}

#[test]
fn successful_command_local_heredocs_share_state_only_within_their_reader() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("unset x\ncat <<EOF\n${x:=reader}:$x\nEOF\nargs \"${x-unset}\"\n"),
        0
    );
    assert_eq!(rig.output.bytes(), b"reader:reader\n");
    assert_eq!(*rig.calls.borrow(), [vec!["unset"]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("unset x\ncat <<A <<B\n${x:=first}\nA\n${x-unset}\nB\nargs \"${x-unset}\"\n"),
        0
    );
    assert_eq!(rig.output.bytes(), b"first\n");
    assert_eq!(*rig.calls.borrow(), [vec!["unset"]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("unset x; set -u\ncat <<A <<B\n${x:=first}\nA\n${x:?reader lost}:$x\nB\nargs \"${x-unset}\"\n"), 0);
    assert_eq!(rig.output.bytes(), b"first:first\n");
    assert_eq!(*rig.calls.borrow(), [vec!["unset"]]);
    assert!(rig.errors.bytes().is_empty());

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "unset x\nvalue=kept <<EOF\n${x:=reader}:$x\nEOF\nargs \"${x-unset}\" \"$value\"\n"
        ),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["unset", "kept"]]);
}

#[test]
fn successful_builtin_heredocs_keep_current_shell_parameter_effects() {
    check(
        "unset x\n: <<EOF\n${x:=caller}:$x\nEOF\nargs \"$x\"\n",
        &[&["caller"]],
    );
}
