//! Scalar indirect cases adapted from Bashkit 491c3281's indirect-expansion
//! spec, with original GNU Bash 5.3.15 C.UTF-8 and engine-bound controls.
use super::*;

#[test]
fn indirect_adapted_defaults_and_assignment() {
    check_output(
        r#"name=TARGET; export TARGET=value; echo "${!name:-fallback}"; name=MISSING_VAR; echo "${!name:-fallback}"; name=EMPTY_VAR; export EMPTY_VAR=; echo "${!name:-fallback}"; name=UNSET_TARGET; echo "${!name:=assigned}"; echo "$UNSET_TARGET""#,
        "value\nfallback\nfallback\nassigned\nassigned\n",
    );
}

#[test]
fn indirect_is_one_level_dynamic_and_quote_aware() {
    check(
        r#"p=x; x=y; y=last; args "${!p}"; p=y; args "${!p}"; p=x; x=' a:b c '; IFS=:; args ${!p} "${!p}"; result=${!p}; args "$result"; x=; args ${!p} "${!p}"; p=missing; args ${!p} "${!p}""#,
        &[
            &["y"],
            &["last"],
            &[" a", "b c ", " a:b c "],
            &[" a:b c "],
            &[""],
            &[""],
        ],
    );
}

#[test]
fn indirect_lazy_operators_write_the_target_and_keep_pointer() {
    check(
        r#"p=x; args "${!p-default}" "${!p:-default}" "${!p+alt}" "${!p:+alt}"; x=; args "${!p-default}" "${!p:-default}" "${!p+alt}" "${!p:+alt}"; args "${!p=skip}" "${!p:=new value}" "$p" "$x"; args "${!p:-$(args forbidden)}" "${!p+${written:=yes}}"; args "$written" "${u:-${!p}}"; p=IFS; args pre:post ${!p:=:} tail:end"#,
        &[
            &["default", "default", "", ""],
            &["", "default", "alt", ""],
            &["", "new value", "x", "new value"],
            &["new value", "yes"],
            &["yes", "new value"],
            &["pre:post", "tail:end"],
        ],
    );
}

#[test]
fn indirect_invalid_pointer_is_fatal_and_does_not_dispatch() {
    for (setup, name, message) in [
        ("", "p", "invalid indirect expansion"),
        ("p=;", "", "invalid variable name"),
        ("p=bad-name;", "bad-name", "invalid variable name"),
        ("p='x:-oops';", "x:-oops", "invalid variable name"),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("{setup}\nargs ${{!p:-fallback}}; args after")),
            1
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line 2: {name}: {message}\n").as_bytes()
        );
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["recovered"]]);
    }
}

#[test]
fn indirect_selected_error_uses_pointer_spelling_and_existing_fatal_scope() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("p=missing;\nargs ${!p:?oops}; args after"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 2: !p: oops\n");
    check(
        "p=; (args ${!p}; args forbidden); args after",
        &[&["after"]],
    );
    check(
        "p=missing; (args ${!p:?oops}; args forbidden); args after",
        &[&["after"]],
    );
}

#[test]
fn indirect_selected_errors_preserve_nested_names_and_completed_effects() {
    for (source, status, diagnostic) in [
        (
            "p=x; args ${!p:?${other:?inner}}; args forbidden",
            127,
            "other: inner",
        ),
        (
            "p=x; args ${!p:-${other:?inner}}; args forbidden",
            127,
            "other: inner",
        ),
        (
            "p=x; args ${!p:?${side:=written}}; args forbidden",
            127,
            "!p: written",
        ),
        (
            "p=x; args ${!p?}; args forbidden",
            127,
            "!p: parameter not set",
        ),
        (
            "p=x; x=; args ${!p:?}; args forbidden",
            127,
            "!p: parameter null or not set",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line 1: {diagnostic}\n").as_bytes()
        );
        if source.contains("side:=") {
            assert_eq!(
                rig.shell.state().borrow().variables.get("side").unwrap(),
                "written"
            );
        }
    }
    check(
        r#"p=x; args "${!p:=${x:=inner}}" "$p" "$x""#,
        &[&["inner", "x", "inner"]],
    );
}

#[test]
fn indirect_selected_syntax_fails_closed_and_skipped_operands_stay_lazy() {
    for expression in [
        "${!p#x}",
        "${!p%%x}",
        "${!p^^}",
        "${!p/a/b}",
        "${!p:1}",
        "${!p@Q}",
        "${!p*}",
        "${!p@}",
        "${!a[0]}",
        "${!a[@]}",
        "${!PIPESTATUS}",
        "${!1}",
        "${!#}",
        "${!!p}",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("p", "missing");
        assert_eq!(rig.run(&format!("args {expression}")), 2, "{expression}");
        assert!(rig.calls.borrow().is_empty(), "{expression}");
    }
    for target in [
        "1",
        "0001",
        "?",
        "#",
        "@",
        "*",
        "-",
        "PIPESTATUS",
        "a[0]",
        "a[$(args forbidden)]",
        "a[0]:-${!p}]",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("p", target);
        assert_eq!(rig.run("args ${!p:-${side:=forbidden}}"), 2, "{target}");
        assert!(rig.calls.borrow().is_empty());
        assert!(!rig.shell.state().borrow().variables.contains_key("side"));
    }
    check(
        r#"p=missing; args "${!p:-$(args selected; echo value)}" "${!p:-`args backtick; echo tick`}"; args "${missing-unset}"; args "${!p:=$(echo assigned)}" "$missing" "$p""#,
        &[
            &["selected"],
            &["backtick"],
            &["value", "tick"],
            &["unset"],
            &["assigned", "assigned", "missing"],
        ],
    );
    check(
        r#"p=x; x=ok; args "${!p:-${bad:?forbidden}}" "${!p:-${!bad}}" "${!p:-$(args forbidden)}" "${missing+${!bad}}" "${missing+${!p#x}}""#,
        &[&["ok", "ok", "ok", "", ""]],
    );
}

#[test]
fn indirect_composes_through_scalar_operand_pattern_diagnostic_and_declaration_paths() {
    check(
        r#"p=x; x='a b'; export a=${!p}; f() { local b=${u:-${!p}}; args "$b"; }; f; args "$a"; p=cut; cut='a*'; v=abc; args "${v#${!p}}"; p=command; command='args promoted'; ${!p} tail; p=file; file='out file'; args redirected >"${!p}""#,
        &[
            &["a b"],
            &["a b"],
            &["bc"],
            &["promoted", "tail"],
            &["redirected"],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("p=x; x='a  b'; args ${bad:?${!p}}"), 127);
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: bad: a b\n");
    assert!(rig.calls.borrow().is_empty());
    check(
        r#"p=IFS; IFS=; args pre:post ${!p:=:} tail:end; args pre:post ${!p:=unused} tail:end; p=x; x=; args ${!p:="a b"} "${!p}""#,
        &[
            &["pre:post", "", "tail:end"],
            &["pre:post", "", "tail:end"],
            &["a b", "a b"],
        ],
    );
}

#[test]
fn indirect_failures_are_contained_and_frames_restore() {
    for body in ["args ${!p}", "args ${!p:?oops}"] {
        let rig = Rig::new(Limits::default());
        rig.variable("scope", "outside");
        assert_eq!(rig.run(&format!("p=; f() {{ local scope=inside; {body}; args forbidden; }}; f argument; args forbidden")), 1);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "$scope" "$#" "$1""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["outside", "0", ""]]);
    }
    check("p=; args ${!p} | :; args after", &[&["after"]]);
    check("p=; args ${!p} & wait; args after", &[&["after"]]);
    for source in [
        "p=; args ${!p} || args forbidden; args forbidden",
        "p=; while args ${!p}; do args forbidden; done; args forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1);
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn indirect_error_routing_and_multiline_anchor_use_the_preparation_layer() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("p=x;\nargs ok 2>errors >${!p:?bad}; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(
        rig.fs.read_file("/home/guest/errors").unwrap(),
        b"/usr/bin/bash: line 2: !p: bad\n"
    );
}

#[test]
fn indirect_shares_fields_storage_and_prior_assignment_reservations() {
    for source in ["args ${!p}", "A=x args ${!p}", "args before ${!p}"] {
        let rig = Rig::new(Limits {
            arguments: 3,
            ..Limits::default()
        });
        rig.variable("p", "target");
        rig.variable("target", "a b c");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run("args recovered"), 0);
    }
    // Two pointer snapshots alone exceed the allowance, even with no emitted value.
    let rig = Rig::new(Limits {
        expansion_bytes: 64,
        ..Limits::default()
    });
    let name = "x".repeat(40);
    rig.variable("p", &name);
    assert_eq!(rig.run("args ${!p} ${!p}"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args ${!p}"), 0);
    assert_eq!(*rig.calls.borrow(), &[Vec::<String>::new()]);

    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        arguments: 8,
        ..Limits::default()
    });
    rig.variable("p", "missing");
    rig.variable("parts", &":".repeat(150));
    rig.variable("IFS", ":");
    assert_eq!(rig.run("args ${!p:?$parts}"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn indirect_scans_and_value_emission_yield_cancel_and_restore_function_frames() {
    for (pointer, value) in [
        ("x".repeat(120_000), "value".to_owned()),
        ("x".to_owned(), "a".repeat(120_000)),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("p", &pointer);
        rig.variable(&pointer, &value);
        rig.variable("scope", "outside");
        let job = rig
            .shell
            .start("f() { local scope=inside; args ${!p}; }; f argument")
            .unwrap();
        rig.drive_until_variable("scope", "inside");
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished());
        assert!(!job.is_finished());
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "$scope" "$#" "$1""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["outside", "0", ""]]);
    }
}

#[test]
fn indirect_rhs_cancellation_keeps_completed_effects_and_restores_prefixes() {
    let rig = Rig::new(Limits::default());
    rig.variable("p", "x");
    rig.variable("long", &"a".repeat(120_000));
    rig.variable("result", "outside");
    let job = rig
        .shell
        .start("TEMP=value result=${!p:=${started:=yes}$long} args")
        .unwrap();
    rig.drive_until_variable("started", "yes");
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    rig.variable("peer", "ran");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.run(r#"args "${TEMP-unset}" "$result" "$started" "${x-unset}" "$#""#),
        0
    );
    assert_eq!(
        *rig.calls.borrow(),
        &[vec!["unset", "outside", "yes", "unset", "0"]]
    );
}

#[test]
fn indirect_diagnostics_keep_exact_remaining_field_limits() {
    for (source, rejected, admitted) in [
        ("args before ${!p:?$parts}", 4, 5),
        ("A=x args before ${!p:?$parts}", 5, 6),
        ("export first=value next=${!p:?$parts}", 4, 5),
    ] {
        for (arguments, expected) in [(rejected, 2), (admitted, 127)] {
            let rig = Rig::new(Limits {
                arguments,
                expansion_bytes: 4096,
                ..Limits::default()
            });
            rig.variable("p", "missing");
            rig.variable("parts", "a:b:c");
            rig.variable("IFS", ":");
            assert_eq!(rig.run(source), expected, "{source}, {arguments}");
            assert!(rig.calls.borrow().is_empty());
            if expected == 127 {
                assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: !p: a b c\n");
            } else {
                assert!(rig.errors.bytes().is_empty());
            }
        }
    }
}

#[test]
fn indirect_assignment_admits_the_resolved_key_before_a_selected_write() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64,
        ..Limits::default()
    });
    let target = "x".repeat(40);
    rig.variable("p", &target);
    assert_eq!(rig.run("args ${!p:=v}"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert!(!rig.shell.state().borrow().variables.contains_key(&target));
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn indirect_adapted_plain_scalar_fixed_cases() {
    check_output(
        r#"x=hello; ref=x; echo ${!ref}; A=world; B=A; echo "${!B}"; A=hello; B=A; echo ${!B}; X=value; ref=X; echo ${!ref}"#,
        "hello\nworld\nhello\nvalue\n",
    );
}

#[test]
fn indirect_pointer_and_value_limits_reject_before_dispatch_and_recover() {
    for (pointer, value) in [
        ("x".repeat(65), String::new()),
        ("x".into(), "v".repeat(65)),
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 64,
            ..Limits::default()
        });
        rig.variable("p", &pointer);
        rig.variable(&pointer, &value);
        assert_eq!(rig.run("args ${!p}"), 2);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["recovered"]]);
    }
}

#[test]
fn indirect_selected_tokens_retain_shared_parser_and_depth_admission() {
    let rig = Rig::new(Limits::default());
    rig.variable("p", "x");
    assert_eq!(
        rig.run(&format!("args ${{u:-${{!p:-{}}}}}", "a".repeat(4200))),
        2
    );
    assert!(rig.calls.borrow().is_empty());
    let mut source = "ok".to_owned();
    for _ in 0..33 {
        source = format!("${{!p:-{source}}}");
    }
    assert_eq!(rig.run(&format!("args {source}")), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args ${!p:-${!p:-ok}}"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["ok"]]);
}
