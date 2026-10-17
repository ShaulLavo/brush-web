//! Scalar cases adapted from Bashkit spec_cases/bash/nameref.test.sh at
//! 491c3281f668b76d64b15210b8f5d7bf97244be0. Empty/unset, resource, cancellation
//! and restoration matrices are original semantic-reference adapter controls.
use super::*;

#[test]
fn scalar_namerefs_read_live_nonempty_and_set_empty_targets_under_nounset() {
    check_output(
        "set -u; target=\"\"; declare -n ref=target; echo \"ref: '$ref'\"; echo survived",
        "ref: ''\nsurvived\n",
    );
    check(
        r#"set -u; target=before; declare -n ref=target; args "$ref" "${ref+set}" "${ref:-fallback}"; target=after; args "$ref"; target=; args "$ref" "${ref+set}" "${ref-fallback}" "${ref:-fallback}" "${ref:+unused}"; target=again; args "$ref""#,
        &[
            &["before", "set", "before"],
            &["after"],
            &["", "set", "", "fallback", ""],
            &["again"],
        ],
    );
}

#[test]
fn unset_reference_targets_remain_unset_for_presence_checks_and_nounset() {
    check(
        r#"declare -n ref=target; args "$ref" "${ref+set}" "${ref-default}"; set -u; args "${ref+set}" "${ref:-fallback}" "${ref:+$missing}"; target=; args "$ref" "${ref+set}"; unset target; args "${ref+set}" "${ref-default}""#,
        &[
            &["", "", "default"],
            &["", "fallback", ""],
            &["", "set"],
            &["", "default"],
        ],
    );
    for expression in [
        "$ref",
        "${#ref}",
        "${ref:0}",
        "${ref%x}",
        "${ref/x/y}",
        "${ref^^}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -u; declare -n ref=target; args \"{expression}\"; args forbidden"
            )),
            127,
            "{expression}"
        );
        assert!(rig.calls.borrow().is_empty(), "{expression}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 1: ref: unbound variable\n",
            "{expression}"
        );
        assert!(!rig.shell.state().borrow().variables.contains_key("target"));
    }
}

#[test]
fn scalar_alias_writes_reach_the_target_and_ordinary_assignments_stay_ordinary() {
    check(
        r#"target=before; declare -n ref=target; ref=after; args "$target" "$ref"; target=; args "${ref:=default}" "$target"; unset target; args "${ref=created}" "$target"; export ref=exported; args "$target" "$ref"; plain=ref; plain=ordinary; args "$plain" "$target"; declare -n chain=ref; chain=chained; args "$target" "$ref" "$chain"; unset ref; args "${target+set}" "${ref+set}"; target=back; args "$ref""#,
        &[
            &["after", "after"],
            &["default", "default"],
            &["created", "created"],
            &["exported", "exported"],
            &["ordinary", "exported"],
            &["chained", "chained", "chained"],
            &["", ""],
            &["back"],
        ],
    );
    check(
        r#"declare -n ref=target; printf 'read-value\n' > input; read ref < input; args "$target" "$ref"; ref=3; args "$((ref+2))"; ((ref=7)); args "$target"; readonly target; ref=changed
args "$?" "$target""#,
        &[&["read-value", "read-value"], &["5"], &["7"], &["1", "7"]],
    );
}

#[test]
fn aliases_share_scalar_transformations_and_name_indirection() {
    check(
        r#"target=abcde; declare -n ref=target; declare -n chain=ref; args "${#ref}" "${ref:1:2}" "${ref#a}" "${ref%e}" "${ref/b/X}" "${ref^^}" "${!ref}" "${!chain}"; ref=other; args "$target"; other=value; declare -n ref=other; args "$ref" "$target""#,
        &[
            &[
                "5", "bc", "bcde", "abcd", "aXcde", "ABCDE", "target", "target",
            ],
            &["other"],
            &["value", "other"],
        ],
    );
    check(
        r#"target='a b'; ref=target; typeset -n ref; args "$ref"; target=changed; args "$ref""#,
        &[&["a b"], &["changed"]],
    );
}

#[test]
fn local_reference_frames_restore_both_values_and_reference_metadata() {
    check(
        r#"target=outer; other=global; declare -n ref=target; f() { local -n ref=other; ref=changed; args "$ref"; g() { local ref=plain; args "$ref"; }; g; args "$ref"; }; f; args "$ref" "$target" "$other"; f() { declare -n temporary=target; temporary=updated; }; f; args "${temporary+set}" "$ref"; f() { local target=inner; args "$ref"; }; f; args "$ref"; plain=ordinary; f() { declare -n plain=target; args "$plain"; }; f; args "$plain""#,
        &[
            &["changed"],
            &["plain"],
            &["changed"],
            &["outer", "outer", "changed"],
            &["", "updated"],
            &["inner"],
            &["updated"],
            &["updated"],
            &["ordinary"],
        ],
    );
    check(
        r#"target=outer; declare -n ref=target; (ref=child; args "$ref"); args "$ref"; args "$(ref=capture; printf '%s' "$ref")" "$ref""#,
        &[&["child"], &["outer"], &["capture", "outer"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("target=outer; other=before; declare -n ref=target; f() { local -n ref=other; ref=written; set -u; args \"$missing\"; }; f"), 127);
    assert_eq!(rig.run(r#"args "$ref" "$other""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["outer", "written"]]);
}

#[test]
fn isolated_execution_snapshots_keep_live_references_and_local_restoration() {
    check(
        r#"target=parent; other=kept; declare -n ref=target; (ref=subshell; args "$ref"); args "$ref"; ref=pipeline | args; args "$ref"; ref=background & wait %1; args "$ref"; f() { local -n ref=other; ref=child & wait %1; args "$ref"; }; f; args "$ref" "$other""#,
        &[
            &["subshell"],
            &["parent"],
            &[],
            &["parent"],
            &["parent"],
            &["kept"],
            &["parent", "kept"],
        ],
    );
}

#[test]
fn pipeline_snapshots_share_admission_before_any_stage_is_launched() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024,
        ..Limits::default()
    });
    rig.variable("target_name", &"t".repeat(32 * 1024));
    assert_eq!(rig.run("declare -n ref=$target_name"), 0);
    assert_eq!(rig.run("args forbidden | args also_forbidden"), 2);
    assert!(
        rig.calls.borrow().is_empty(),
        "an admitted earlier stage must not launch before later snapshots finish"
    );
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run(r#"args "${ref+set}" recovered"#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["", "recovered"]]);
}

#[test]
fn rejected_isolated_state_copies_keep_the_last_async_identity_and_caller_state() {
    for source in [
        "args forbidden & exit $?",
        "(args forbidden)",
        "args forbidden | args also_forbidden",
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 32 * 1024,
            ..Limits::default()
        });
        assert_eq!(rig.run(r#"true & saved=$!; wait "$saved""#), 0);
        let saved = rig.shell.state().borrow().variables["saved"].clone();
        rig.variable("large", &"x".repeat(64 * 1024));
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert_eq!(rig.host.active_count(), 0, "{source}");
        assert_eq!(rig.ex.drive(64).pending, 0, "{source}");
        assert_eq!(rig.run(r#"args "$!" recovered"#), 0);
        assert_eq!(*rig.calls.borrow(), [vec![saved, "recovered".to_owned()]]);
    }
}

#[test]
fn cancelling_isolated_state_admission_launches_no_child_and_restores_the_caller() {
    for source in [
        "args forbidden & exit $?",
        "(args forbidden)",
        "args forbidden | args also_forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(r#"true & saved=$!; wait "$saved""#), 0);
        let saved = rig.shell.state().borrow().variables["saved"].clone();
        rig.variable("large", &"x".repeat(300_000));
        let job = rig.shell.start(source).unwrap();
        for _ in 0..32 {
            rig.ex.drive(1);
        }
        assert!(!job.is_finished(), "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert_eq!(rig.host.active_count(), 0, "{source}");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert_eq!(rig.host.retained_count(), 0, "{source}");
        assert_eq!(rig.ex.drive(64).pending, 0, "{source}");
        assert_eq!(rig.run(r#"args "$!" recovered"#), 0);
        assert_eq!(*rig.calls.borrow(), [vec![saved, "recovered".to_owned()]]);
    }
}

#[test]
fn reference_cycles_are_bounded_and_unset_under_nounset() {
    check(
        r#"declare -n a=b; declare -n b=a; args "$a" "${a+set}" "${a-fallback}"; a=blocked; args "$?" "${a+set}"; plain=kept; args "$plain""#,
        &[&["", "", "fallback"], &["1", ""], &["kept"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("declare -n a=b; declare -n b=a; set -u; args \"$a\"; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: a: unbound variable\n"
    );
    check(
        r#"ordinary=kept; declare -n ordinary=ordinary; args "$?" "$ordinary""#,
        &[&["1", "kept"]],
    );
}

#[test]
fn nameref_depth_eight_resolves_but_nine_reads_as_unset_without_resource_failure() {
    let mut source = String::from("final_target=deep_value\n");
    for index in (1..=8).rev() {
        let target = if index == 8 {
            "final_target".to_owned()
        } else {
            format!("c{}", index + 1)
        };
        source.push_str(&format!("declare -n c{index}={target}\n"));
    }
    source.push_str(
        "args \"$c1\" \"${c1+set}\"\nc8=changed\nargs \"$final_target\" \"$c1\"\ndeclare -n c1=final_target\nargs \"$c1\"\n",
    );
    check(
        &source,
        &[
            &["deep_value", "set"],
            &["changed", "changed"],
            &["changed"],
        ],
    );

    let mut source = String::from("final_target=deep_value\n");
    for index in (1..=9).rev() {
        let target = if index == 9 {
            "final_target".to_owned()
        } else {
            format!("c{}", index + 1)
        };
        source.push_str(&format!("declare -n c{index}={target}\n"));
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(&source), 0);
    assert_eq!(rig.run(r#"args "$c1" "${c1+set}" "${c1-default}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["", "", "default"]]);
    assert_eq!(rig.run("c1=blocked"), 1);
    assert_eq!(rig.calls.borrow().len(), 1);
    assert_eq!(rig.run(r#"args "$?" "$final_target" "$c1""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["", "", "default"], vec!["1", "deep_value", ""]]
    );
    assert_eq!(rig.run("declare -n c1=final_target"), 0);
    assert_eq!(rig.run(r#"args "$c1""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["", "", "default"],
            vec!["1", "deep_value", ""],
            vec!["deep_value"],
        ]
    );
}

#[test]
fn nameref_depth_overflow_stays_distinct_from_cycles_under_nounset() {
    let mut source = String::from("final_target=deep_value\n");
    for index in (1..=9).rev() {
        let target = if index == 9 {
            "final_target".to_owned()
        } else {
            format!("c{}", index + 1)
        };
        source.push_str(&format!("declare -n c{index}={target}\n"));
    }
    source.push_str("set -u\nargs \"$c1\"\nargs forbidden\n");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(&source), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 12: c1: unbound variable\n"
    );

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("declare -n a=b; declare -n b=a; set -u; args \"$a\"; args forbidden"),
        127
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: a: unbound variable\n"
    );
}

#[test]
fn unsupported_reference_shapes_do_not_create_a_binding_or_target() {
    for operand in [
        "ref=array[0]",
        "ref=1",
        "ref=",
        "ref=PIPESTATUS",
        "ref=not-a-name",
        "-a ref=target",
        "-nx ref=target",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("declare -n {operand}")), 2, "{operand}");
        assert_eq!(rig.run(r#"args "${ref+set}" "${target+set}""#), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["", ""]], "{operand}");
    }
}

#[test]
fn reference_metadata_admission_and_function_cancellation_preserve_bindings() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    assert_eq!(rig.run("declare -n ref=target"), 2);
    assert_eq!(rig.run(r#"args "${ref+set}" "${target+set}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["", ""]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("target=outer; other=inner; declare -n ref=target"),
        0
    );
    rig.variable("large", &"x".repeat(300_000));
    let job = rig
        .shell
        .start("f() { local -n ref=other; ready=yes; args \"$large\"; }; f")
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run(r#"args "$ref" "$other""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["outer", "inner"]]);
}
