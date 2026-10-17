//! Original regression tests for ordinary builtin prefix assignment scope.
use super::*;

#[test]
fn read_keeps_its_result_and_restores_only_prefix_values() {
    let rig = Rig::new(Limits::default());
    rig.fs
        .write_file("/home/guest/input", b"  first\\tail  \n")
        .unwrap();
    assert_eq!(rig.run(r#"IFS=:; export IFS; IFS= temporary=inside read -r line < input; args "$?" "$line" "$IFS" "${temporary+set}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["0", "  first\\tail  ", ":", ""]]);
    let state = rig.shell.state();
    let state = state.borrow();
    assert!(state.exported.contains("IFS"));
    assert!(!state.exported.contains("temporary"));
    assert!(!state.readonly.contains("IFS"));
}

#[test]
fn read_cannot_leak_writes_to_a_prefixed_destination() {
    let rig = Rig::new(Limits::default());
    rig.fs.write_file("/home/guest/input", b"inside\n").unwrap();
    assert_eq!(rig.run(r#"line=outer; line=temporary read -r line < input; args "$?" "$line"; fresh=temporary read -r fresh < input; args "$?" "${fresh+set}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["0", "outer"], vec!["0", ""]]);
}

#[test]
fn duplicate_prefixes_and_argument_expansion_keep_caller_scope() {
    check(
        r#"value=outer; value=first value=second printf '%s\n' "$value"; args "$?" "$value"; value=temporary false; args "$?" "$value""#,
        &[&["0", "outer"], &["1", "outer"]],
    );
}

#[test]
fn builtin_prefixes_preserve_local_export_and_readonly_rules() {
    let rig = Rig::new(Limits::default());
    rig.fs.write_file("/home/guest/input", b"result\n").unwrap();
    assert_eq!(rig.run(r#"IFS=global; f() { local IFS=local; export IFS; IFS= read -r line < input; args "$?" "$IFS" "$line"; }; f; args "$IFS" "$line"; readonly locked=kept; IFS= read locked < input; args "$?" "$IFS" "$locked""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["0", "local", "result"],
            vec!["global", "result"],
            vec!["1", "global", "kept"]
        ]
    );
    assert!(!rig.shell.state().borrow().exported.contains("IFS"));
    assert!(rig.shell.state().borrow().readonly.contains("locked"));
    assert_eq!(rig.run("IFS=temporary locked=changed read line < input"), 1);
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("IFS")
            .map(String::as_str),
        Some("global")
    );
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("locked")
            .map(String::as_str),
        Some("kept")
    );
}

#[test]
fn builtin_prefixes_restore_after_read_failure() {
    let rig = Rig::new(Limits::default());
    rig.fs.write_file("/home/guest/input", b"partial").unwrap();
    assert_eq!(rig.run(r#"IFS=:; IFS= read -r line < input; args "$?" "$IFS" "$line"; IFS= read -z; args "$?" "$IFS""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["1", ":", "partial"], vec!["2", ":"]]
    );
}

#[test]
fn builtin_prefixes_restore_after_cancellation() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = shell_engine::io::pipe();
    let mut fds = FdTable::default();
    fds.insert(0, reader);
    let (out, _) = capture(1024);
    fds.insert(1, out.clone());
    fds.insert(2, out);
    rig.shell.set_descriptors(fds).unwrap();
    rig.variable("IFS", ":");
    let job = rig
        .shell
        .start("IFS= temporary=inside read -r line")
        .unwrap();
    rig.drive_until_variable("temporary", "inside");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    let state = rig.shell.state();
    let state = state.borrow();
    assert_eq!(state.variables.get("IFS").map(String::as_str), Some(":"));
    assert!(!state.variables.contains_key("temporary"));
    assert!(!state.variables.contains_key("line"));
    drop(writer);
}

#[test]
fn acceptance_ifs_read_pipeline_preserves_sigpipe_and_handled_epipe() {
    for (name, expected) in [("endless", 141), ("handled", 23)] {
        let rig = Rig::new(Limits::default());
        rig.host.register(name, move |request, cancel| {
            async move {
                let output = request.fds.get(1).unwrap();
                loop {
                    if let Err(error) = output.write_all(b"first\n", &cancel).await {
                        return if name == "handled"
                            && error == shell_engine::io::IoError::BrokenPipe
                        {
                            23
                        } else {
                            error.status()
                        };
                    }
                }
            }
            .boxed_local()
        });
        assert_eq!(rig.run(&format!(r#"set -o pipefail; {name} | {{ IFS= read -r line; echo "$line"; }}; printf 'STATUS:%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#)), 0);
        assert_eq!(
            rig.output.bytes(),
            format!("first\nSTATUS:{expected}:{expected} 0\n").as_bytes()
        );
        assert!(rig.errors.bytes().is_empty());
        assert_eq!(rig.host.active_count(), 0);
    }
}
