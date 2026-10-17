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
fn reference_ifs_initial_nonempty_empty_unset_and_unicode_targets() {
    check_output(
        r#"sep=:; declare -n IFS=sep; value=a:b; printf '<%s>\n' $value"#,
        "<a>\n<b>\n",
    );
    // Fresh bindings isolate each supported delimiter set. Repeated target
    // mutations produced source/environment-sensitive Bash output in probes.
    for (setup, value, expected) in [
        ("sep=:", "a:b c", &["a", "b c"][..]),
        ("sep=' '", "a:b c", &["a:b", "c"][..]),
        ("sep=", "a:b c", &["a:b c"][..]),
        ("unset sep", "a:b c", &["a:b", "c"][..]),
        ("sep=ç", "çxççyç", &["", "x", "", "y"][..]),
    ] {
        check(
            &format!("{setup}; declare -n IFS=sep; value='{value}'; args $value"),
            &[expected],
        );
    }
    check(
        r#"sep=:; declare -n IFS=sep; value='a:b c'; args $value "$value""#,
        &[&["a", "b c", "a:b c"]],
    );
}

#[test]
fn reference_ifs_keeps_quoted_join_state_after_empty_and_unset_target_writes() {
    // GNU Bash 5.3.15 builtin-only probe: splitting observes the target becoming
    // empty/unset while quoted star keeps the separator established by IFS.
    check_output(
        r#"sep=:; declare -n IFS=sep; value=a:b; printf '<%s>\n' $value; set -- a b; printf 'join:[%s]\n' "$*"; sep=; printf '<%s>\n' $value; printf 'join:[%s]\n' "$*"; unset sep; printf '<%s>\n' $value; printf 'join:[%s]\n' "$*""#,
        "<a>\n<b>\njoin:[a:b]\n<a:b>\njoin:[a:b]\n<a:b>\njoin:[a:b]\n",
    );
}

#[test]
fn direct_ifs_writes_refresh_quoted_join_state() {
    check_output(
        r#"IFS=:; set -- a b; printf 'base:<%s>\n' "$*"; IFS=; printf 'empty:<%s>\n' "$*"; unset IFS; printf 'unset:<%s>\n' "$*""#,
        "base:<a:b>\nempty:<ab>\nunset:<a b>\n",
    );
}

#[test]
fn reference_join_state_restores_local_ifs_and_refreshes_function_return() {
    check_output(
        r#"sep=:; declare -n IFS=sep; set -- a b; f() { local sep=; printf 'target:<%s>\n' "$*"; }; f x y; f() { local IFS=; printf 'direct:<%s>\n' "$*"; }; f x y; printf 'restored:<%s>\n' "$*"; f() { sep=; }; f; printf 'returned:<%s>\n' "$*""#,
        "target:<x:y>\ndirect:<xy>\nrestored:<a:b>\nreturned:<ab>\n",
    );
}

#[test]
fn reference_star_joins_in_scalar_words_and_case_patterns_keep_the_snapshot() {
    check_output(
        r#"sep=:; declare -n IFS=sep; set -- a b; sep=; joined=$*; printf 'quoted:<%s>\nscalar:<%s>\n' "$*" "$joined"; case a:b in "$*") printf 'quoted-pattern\n';; esac; case a:b in $*) printf 'pattern\n';; esac; unset sep; joined=$*; printf 'unset:<%s>\nscalar:<%s>\n' "$*" "$joined""#,
        "quoted:<a:b>\nscalar:<a:b>\nquoted-pattern\npattern\nunset:<a:b>\nscalar:<a:b>\n",
    );
    check_output(
        r#"sep=:; other=,; declare -n IFS=sep; set -- a b; sep=; declare -n IFS=other; printf 'retarget:<%s>\n' "$*"; other=; printf 'empty:<%s>\n' "$*"; IFS=; printf 'reference:<%s>\n' "$*"; unset IFS; printf 'unset:<%s>\n' "$*""#,
        "retarget:<a,b>\nempty:<a,b>\nreference:<a,b>\nunset:<a b>\n",
    );
}

#[test]
fn ordinary_ifs_alias_writes_refresh_splitting_and_literal_classification() {
    check_output(
        r#"IFS=; declare -n alias=IFS; printf '<%s>\n' a:b${alias:=:}; printf '<%s>\n' a:b$((0)); set -- a b; alias=,; printf '<%s>\n' "$*"; value=a,b; printf '<%s>\n' $value"#,
        "<a>\n<b>\n<a:b0>\n<a,b>\n<a>\n<b>\n",
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
fn parameter_writes_keep_reference_ifs_classification_through_all_aliases() {
    for name in ["sep", "alias", "IFS"] {
        check(
            &r#"sep=; declare -n IFS=sep; declare -n alias=sep; f() { local sep=; args a:b${WRITE:=:}; sep=; args a\:b:c${WRITE:=:}; sep=; value=a:b; args ${value#${WRITE:=:}}; sep=; args "${value/b/${WRITE:=:}}"; args "$sep" "$alias" "$IFS"; }; f; args "$sep""#.replace("WRITE", name),
            // Keep the captured binding alive while all three supported write
            // names mutate its local shadow. Repeated global-mutation probes
            // varied with source/environment; this 3-by-4 matrix was stable.
            &[
                &["a:b:"],
                &["a:b:c:"],
                &["a:b"],
                &["a::"],
                &[":", ":", ":"],
                &[""],
            ],
        );
    }
}

#[test]
fn arithmetic_target_writes_keep_the_join_separator_until_function_return() {
    check(
        r#"sep=; declare -n IFS=sep; declare -n alias=sep; f() { args "$((alias=5))$*"; }; f a b; value=a5b; args $value; sep=; args a5b$((IFS=5)); args "$IFS" "$alias""#,
        // Actual GNU Bash 5.3.15 probe: the first write is through the target,
        // so star remains empty-joined until returning from f refreshes IFS.
        &[&["5ab"], &["a", "b"], &["a5b"], &["5", "5"]],
    );
    check_output(
        r#"sep=; declare -n IFS=sep; declare -n alias=sep; f() { printf '<%s>\n' "$((alias=5))$*"; }; f a b; value=a5b; printf '<%s>\n' $value; sep=; printf '<%s>\n' a5b$((IFS=5)); printf '<%s>\n' "$IFS" "$alias""#,
        "<5ab>\n<a>\n<b>\n<a5b>\n<5>\n<5>\n",
    );
}

#[test]
fn effective_ifs_tracks_local_targets_and_reference_restoration() {
    check(
        r#"sep=:; declare -n IFS=sep; value='a:b c'; f() { local sep=' '; args $value; }; f; args $value; f() { local IFS=' '; args $value; }; f; args $value; args "${!IFS}""#,
        &[
            &["a", "b c"],
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
