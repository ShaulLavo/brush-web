//! GNU Bash 5.3.15 readonly scalar declarations and mutation boundaries.
use super::*;

#[test]
fn readonly_unset_global_rejects_local_without_creating_a_value() {
    check_output(
        "f() { readonly y; local x=1 y=$(( x )); echo y=$y; }; f; echo y=$y",
        "y=\ny=\n",
    );
    check(
        r#"readonly x; readonly x; export x; args "${x+set}" "${x-fallback}"; f() { local x=2 y=3; args "$?" "$x" "$y"; }; f; args "$y""#,
        &[&["", "fallback"], &["1", "", "3"], &[""]],
    );
}

#[test]
fn readonly_declaration_operands_keep_scalar_expansion_and_continue_after_rejection() {
    check(
        r#"v='a b'; readonly x=$v; readonly x=changed y=$v; args "$?" "$x" "$y"; export x=changed z=kept; args "$?" "$x" "$z""#,
        &[&["1", "a b", "a b"], &["1", "a b", "kept"]],
    );
}

#[test]
fn nested_local_can_shadow_outer_local_readonly_and_restores_its_attribute() {
    check(
        r#"x=outer; f() { local x=1; readonly x; g() { local x=2; ((x=3)); args "$?" "$x"; }; g; ((x=4)); args "$?" "$x"; local x=5 y=6; args "$?" "$x" "$y"; }; f; x=after; args "$x" "$y""#,
        &[&["0", "3"], &["1", "1"], &["1", "1", "6"], &["after", ""]],
    );
}

#[test]
fn arithmetic_readonly_errors_preserve_rhs_effects_and_skip_unselected_writes() {
    for expression in ["x=2", "x+=2", "x++", "++x", "--x", "x--", "x=(saved=3)"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "readonly x=1; (({expression})); args \"$?\" \"$x\""
            )),
            0
        );
        assert_eq!(*rig.calls.borrow(), [vec!["1", "1"]], "{expression}");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("x: readonly variable")
        );
        let expected = if expression.contains("saved") {
            Some("3")
        } else {
            None
        };
        assert_eq!(
            rig.shell
                .state()
                .borrow()
                .variables
                .get("saved")
                .map(String::as_str),
            expected
        );
    }
    check(
        r#"readonly x=1; args "$((0&&(x=2)))" "$((1||(x=2)))" "$((0?x++:4))" "$x"; let 'x=3'; args "$?" "$x""#,
        &[&["0", "1", "4", "1"], &["1", "1"]],
    );
}

#[test]
fn selected_scalar_assignment_errors_abort_and_restore_function_and_prefix_frames() {
    for body in [
        "x=2",
        "args $((x=2))",
        "args ${x:=2}",
        "TEMP=inner RESULT=${x:=2} args",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("scope", "outer");
        rig.variable("TEMP", "before");
        assert_eq!(rig.run(&format!("readonly x; f() {{ local scope=inside; {body}; args forbidden; }}; f argument; args forbidden")), 1, "{body}");
        assert!(rig.calls.borrow().is_empty(), "{body}");
        assert_eq!(rig.run(r#"args "$scope" "$TEMP" "$#" "${x+set}""#), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["outer", "before", "0", ""]]);
    }
}

#[test]
fn read_cannot_modify_readonly_scalars() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("readonly x=kept; read x < missing"), 1);
    assert_eq!(
        rig.run("printf 'changed\\n' > input; read x < input; args \"$?\" \"$x\""),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1", "kept"]]);
}

#[test]
fn isolated_shells_copy_readonly_attributes_without_leaking_new_ones() {
    check(
        r#"readonly fixed=1; ( ((fixed=2)); args "$?" "$fixed"; readonly child=3 ); child=4; args "$fixed" "$child"; f() { readonly piped=5; }; f | cat; piped=6; args "$piped""#,
        &[&["1", "1"], &["1", "4"], &["6"]],
    );
}

#[test]
fn cancelled_expansion_restores_local_attributes_and_preserves_global_readonly() {
    let rig = Rig::new(Limits::default());
    rig.variable("scope", "outer");
    let source = format!(
        "f() {{ local scope=inner; readonly scope; readonly kept=7; TEMP=inside value=${{long:-{}}} args; }}; f argument",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    rig.drive_until_variable("TEMP", "inside");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.run(r#"scope=after; ((kept=9)); args "$?" "$scope" "$kept" "${TEMP+set}" "$#""#),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1", "after", "7", "", "0"]]);
}

#[test]
fn resource_failure_restores_local_attributes_after_completed_declarations() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16384,
        ..Limits::default()
    });
    rig.variable("scope", "outer");
    rig.variable("large", &"x".repeat(32768));
    assert_eq!(
        rig.run(
            "f() { local scope=inner; readonly scope; readonly kept=7; args $large; }; f argument"
        ),
        2
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.run(r#"scope=after; ((kept=9)); args "$?" "$scope" "$kept" "$#""#),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1", "after", "7", "0"]]);
}

#[test]
fn rejected_writes_discard_the_read_unit_and_keep_readonly_state() {
    for command in ["x=2", "args $((x=2))", "args ${x:=2}"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "readonly x; {command}; args forbidden\nargs after=$? ${{x-unset}}"
            )),
            0
        );
        assert_eq!(*rig.calls.borrow(), [vec!["after=1", "unset"]]);
        assert!(rig.shell.state().borrow().readonly.contains("x"));
    }
}
