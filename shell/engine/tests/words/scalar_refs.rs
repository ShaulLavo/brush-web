//! Original scalar-reference attribute and effective-IFS regression controls.
//! They share the native/WASI fixture and require no host commands or timing.
use super::*;

type Environments = Rc<RefCell<Vec<Vec<Option<String>>>>>;

fn observe_environments(rig: &Rig) -> Environments {
    let environments = Rc::new(RefCell::new(Vec::new()));
    let observed = environments.clone();
    rig.host.register("observe_env", move |request, _| {
        let observed = observed.clone();
        async move {
            let values = request.argv[1..]
                .iter()
                .map(|key| request.env.get(key).cloned())
                .collect();
            observed.borrow_mut().push(values);
            0
        }
        .boxed_local()
    });
    environments
}

#[test]
fn export_aliases_mark_live_target_keys_for_bare_and_valued_declarations() {
    let rig = Rig::new(Limits::default());
    let environments = observe_environments(&rig);
    assert_eq!(rig.run(r#"target=before; declare -n ref=target; declare -n chain=ref; export ref=after; observe_env target ref chain; target=later; export chain; observe_env target ref chain; export chain=''; observe_env target ref chain; plain=ordinary; export plain; observe_env plain ref; args "$ref" "${!ref}" "${!chain}""#), 0);
    assert_eq!(
        *environments.borrow(),
        [
            vec![Some("after".to_owned()), None, None],
            vec![Some("later".to_owned()), None, None],
            vec![Some("".to_owned()), None, None],
            vec![Some("ordinary".to_owned()), None],
        ]
    );
    assert_eq!(*rig.calls.borrow(), [vec!["", "target", "target"]]);
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn bare_export_does_not_set_an_unset_reference_target() {
    let rig = Rig::new(Limits::default());
    let environments = observe_environments(&rig);
    assert_eq!(rig.run(r#"set -u; declare -n ref=target; export ref; observe_env target ref; args "${ref+set}"; ref=created; observe_env target ref; args "$ref""#), 0);
    assert_eq!(
        *environments.borrow(),
        [vec![None, None], vec![Some("created".to_owned()), None]]
    );
    assert_eq!(*rig.calls.borrow(), [vec![""], vec!["created"]]);
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn readonly_aliases_guard_the_target_through_alias_and_direct_writes() {
    for declaration in ["readonly ref", "readonly ref=locked"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "target=locked; declare -n ref=target; {declaration}"
            )),
            0
        );
        assert_eq!(rig.run("ref=changed"), 1, "{declaration}");
        assert_eq!(rig.run("target=changed"), 1, "{declaration}");
        assert_eq!(rig.run(r#"args "$ref" "$target" "${!ref}""#), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["locked", "locked", "target"]]);
        assert!(rig.shell.state().borrow().readonly.contains("target"));
        assert!(!rig.shell.state().borrow().readonly.contains("ref"));
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("target: readonly variable")
        );
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("declare -n ref=target; readonly ref"), 0);
    assert_eq!(rig.run("target=value"), 1);
    assert_eq!(rig.run(r#"args "${ref+set}" "${target+set}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["", ""]]);
}

#[test]
fn rejected_attribute_values_keep_target_state_and_later_declarations() {
    let rig = Rig::new(Limits::default());
    let environments = observe_environments(&rig);
    assert_eq!(rig.run(r#"target=kept; declare -n ref=target; readonly ref; export ref=bad other=good; args "$?" "$ref" "$other"; readonly ref=bad next=good; args "$?" "$ref" "$next"; export ref; observe_env target ref other"#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["1", "kept", "good"], vec!["1", "kept", "good"]]
    );
    assert_eq!(
        *environments.borrow(),
        [vec![Some("kept".to_owned()), None, Some("good".to_owned())]]
    );
    let errors = String::from_utf8(rig.errors.bytes()).unwrap();
    assert!(errors.contains("export: target: readonly variable"));
    assert!(errors.contains("readonly: target: readonly variable"));
}

#[test]
fn resolved_attributes_restore_with_the_target_local_frame() {
    let rig = Rig::new(Limits::default());
    let environments = observe_environments(&rig);
    assert_eq!(rig.run(r#"target=global; declare -n ref=target; f() { local target=local; export ref; readonly ref; g() { local target=inner; ref=changed; observe_env target ref; }; g; ((target=9)); args "$?" "$ref"; observe_env target ref; }; f; target=after; observe_env target ref; args "$ref""#), 0);
    assert_eq!(
        *environments.borrow(),
        [
            vec![Some("changed".to_owned()), None],
            vec![Some("local".to_owned()), None],
            vec![None, None]
        ]
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1", "local"], vec!["after"]]);
    assert!(!rig.shell.state().borrow().readonly.contains("target"));
    assert!(!rig.shell.state().borrow().exported.contains("target"));
}

#[test]
fn cancelling_after_resolved_attributes_restores_the_local_target() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("target=global; declare -n ref=target"), 0);
    rig.variable("large", &"x".repeat(300_000));
    let job = rig
        .shell
        .start(
            "f() { local target=local; export ref; readonly ref; ready=yes; args \"$large\"; }; f",
        )
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run(r#"ref=after; args "$ref" "$target""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["after", "after"]]);
    assert!(!rig.shell.state().borrow().readonly.contains("target"));
    assert!(!rig.shell.state().borrow().exported.contains("target"));
}

#[test]
fn effective_ifs_follows_live_nonempty_empty_unset_and_unicode_targets() {
    check_output(
        r#"sep=:; declare -n IFS=sep; value=a:b; printf '<%s>\n' $value"#,
        "<a>\n<b>\n",
    );
    check(
        r#"sep=:; declare -n IFS=sep; value='a:b c'; args $value "$value"; sep=' '; args $value; sep=; args $value; unset sep; args $value; sep=ç; value='çxççyç'; args $value"#,
        &[
            &["a", "b c", "a:b c"],
            &["a:b", "c"],
            &["a:b c"],
            &["a:b", "c"],
            &["", "x", "", "y"],
        ],
    );
}

#[test]
fn effective_ifs_joins_and_splits_stars_in_words_assignments_and_patterns() {
    for (setup, joined, split) in [
        ("sep=:", "a b::c", &["a b", "", "c"][..]),
        ("sep=", "a bc", &["a b", "c"][..]),
        ("unset sep", "a b  c", &["a", "b", "c"][..]),
    ] {
        check(
            &format!(
                r#"set -u; {setup}; declare -n IFS=sep; f() {{ args "$*"; args $*; args "$@"; joined=$*; args "$joined"; case "$joined" in "$*") args matched;; esac; args "${{@:1:2}}"; }}; f 'a b' '' c"#
            ),
            &[
                &[joined],
                split,
                &["a b", "", "c"],
                &[joined],
                &["matched"],
                &["a b", ""],
            ],
        );
    }
}

#[test]
fn parameter_writes_invalidate_ifs_through_its_target_and_other_aliases() {
    for name in ["sep", "alias", "IFS"] {
        check(
            &r#"sep=; declare -n IFS=sep; declare -n alias=sep; args a:b${WRITE:=:}; sep=; args a\:b:c${WRITE:=:}; sep=; value=a:b; args ${value#${WRITE:=:}}; sep=; args "${value/b/${WRITE:=:}}""#.replace("WRITE", name),
            &[&["a", "b"], &["a:b", "c"], &["a", "b"], &["a::"]],
        );
    }
}

#[test]
fn arithmetic_writes_refresh_effective_ifs_before_star_joining_and_splitting() {
    check(
        r#"sep=; declare -n IFS=sep; declare -n alias=sep; f() { args "$((alias=5))$*"; }; f a b; value=a5b; args $value; sep=; args a5b$((IFS=5)); args "$IFS" "$alias""#,
        &[&["5a5b"], &["a", "b"], &["a", "b"], &["5", "5"]],
    );
}

#[test]
fn effective_ifs_tracks_local_targets_and_reference_restoration() {
    check(
        r#"sep=:; declare -n IFS=sep; value='a:b c'; f() { local sep=' '; args $value; }; f; args $value; f() { local IFS=' '; args $value; }; f; args $value; args "${!IFS}""#,
        &[
            &["a:b", "c"],
            &["a", "b c"],
            &["a:b", "c"],
            &["a", "b c"],
            &["sep"],
        ],
    );
}

#[test]
fn effective_ifs_restores_after_fatal_reads_and_cancellation() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("sep=:; declare -n IFS=sep; f() { local sep=' '; set -u; args \"$missing\"; }; f"),
        127
    );
    assert_eq!(rig.run("value=a:b; args $value"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["a", "b"]]);
    rig.variable("large", &"x".repeat(300_000));
    let job = rig
        .shell
        .start("f() { local sep=' '; ready=yes; args \"$large\"; }; f")
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("args $value"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["a", "b"], vec!["a", "b"]]);
}

#[test]
fn implicit_ifs_cycles_are_unset_while_explicit_nounset_reads_still_fail() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("declare -n IFS=sep; declare -n sep=IFS; value='a b'; args $value"),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["a", "b"]]);
    assert_eq!(rig.run("set -u; args \"$IFS\""), 127);
    assert_eq!(*rig.calls.borrow(), [vec!["a", "b"]]);
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("IFS: unbound variable")
    );
}
