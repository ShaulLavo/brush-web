//! Original command-substitution controls targeting GNU Bash 5.3.15
//! (`/usr/bin/bash -c`). They run unchanged natively and on wasm32-wasip1.
use super::*;
use shell_engine::executor::Cancel;
use std::cell::Cell;

// Host fixtures provide exact bytes without depending on the shell's printf
// escape subset or the CLI-only compatibility commands.
fn register_output(rig: &Rig, name: &str, bytes: Vec<u8>) -> Rc<Cell<usize>> {
    let bytes = Rc::new(bytes);
    let written = Rc::new(Cell::new(0));
    let observed = written.clone();
    rig.host.register(name, move |req, cancel| {
        let bytes = bytes.clone();
        let written = observed.clone();
        async move {
            let output = req.fds.get(1).unwrap();
            for chunk in bytes.chunks(1024) {
                if let Err(error) = output.write_all(chunk, &cancel).await {
                    return error.status();
                }
                written.set(written.get() + chunk.len());
            }
            0
        }
        .boxed_local()
    });
    written
}

fn register_copy(rig: &Rig) {
    rig.host.register("copy", |req, cancel| {
        async move {
            let input = req.fds.get(0).unwrap();
            let output = req.fds.get(1).unwrap();
            let mut bytes = [0; 1024];
            loop {
                match input.read_cancelled(&mut bytes, &cancel).await {
                    Ok(0) => return 0,
                    Ok(count) => {
                        if let Err(error) = output.write_all(&bytes[..count], &cancel).await {
                            return error.status();
                        }
                    }
                    Err(error) => return error.status(),
                }
            }
        }
        .boxed_local()
    });
}

// A separate cancellation token acts only as an event gate controlled by the
// test. The process host still owns the real child-cancellation token.
fn register_gated(rig: &Rig, bytes: &'static [u8], linger: bool) -> (Cancel, Rc<Cell<bool>>) {
    let release = Cancel::new();
    let progress = Rc::new(Cell::new(false));
    let gate = release.clone();
    let observed = progress.clone();
    rig.host.register("gated", move |req, cancel| {
        let gate = gate.clone();
        let progress = observed.clone();
        async move {
            let descriptors = req.fds;
            gate.cancelled().await;
            if let Err(error) = descriptors.get(1).unwrap().write_all(bytes, &cancel).await {
                return error.status();
            }
            progress.set(true);
            if linger {
                futures::future::pending::<()>().await;
            }
            drop(descriptors);
            0
        }
        .boxed_local()
    });
    (release, progress)
}

fn register_status_gate(rig: &Rig, name: &str, status: i32) -> Cancel {
    let release = Cancel::new();
    let gate = release.clone();
    rig.host.register(name, move |_, _| {
        let gate = gate.clone();
        async move {
            gate.cancelled().await;
            status
        }
        .boxed_local()
    });
    release
}

fn shutdown_and_check(rig: &Rig) {
    let shutdown = rig.shell.shutdown();
    futures::pin_mut!(shutdown);
    for _ in 0..1000 {
        rig.ex.drive(64);
        if shutdown.as_mut().now_or_never().is_some() {
            assert_eq!(rig.ex.drive(64).pending, 0);
            assert_eq!(rig.host.active_count(), 0);
            assert_eq!(rig.host.retained_count(), 0);
            return;
        }
    }
    panic!("substitution shutdown did not finish");
}

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
    let rig = Rig::new(Limits::default());
    // Prefix assignments on builtins are not supported yet. An external
    // fixture tests named-command status independently of that restriction.
    rig.host.register("okay", |_, _| async { 0 }.boxed_local());
    assert_eq!(
        rig.run(r#"false; args $(exit 3) $?; args $(exit 4)$?; x=$(exit 5); args $?; x=$(exit 5) $(exit 6); args $?; $(exit 7); args $?; x=$(exit 3) okay; args $?"#),
        0,
    );
    assert_eq!(
        *rig.calls.borrow(),
        &[
            vec!["3"],
            vec!["4"],
            vec!["5"],
            vec!["5"],
            vec!["7"],
            vec!["0"]
        ],
    );
}

#[test]
fn operands_and_arithmetic_run_substitutions_lazily() {
    check("args \"$((0 + $( (# (\nprintf x) )))\"", &[&["0"]]);
    check(
        r#"unset u; args "${u:-'$'{x,y}}" "${u:-"$"((1+2))}""#,
        &[&["'$'{x,y}", "3"]],
    );
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
fn backtick_bodies_do_not_close_surrounding_parameter_operands() {
    check(
        r#"v=set; unset u; args "${v:-`f() { :; }; f`}" "${u:-`f() { :; }; f`}" "${v:-`'open`}" "${u:-`"open`}" "${v:-`$(open`}""#,
        &[&["set", "", "set", "", "set"]],
    );
}

#[test]
fn fused_process_text_in_quoted_defaults_keeps_raw_heredoc_boundaries() {
    check(
        "v=set; unset u; args \"${v:-<((: <<EOF\nbody\nEOF))}\" \"${u:-<((: <<EOF\nbody\nEOF))}\"",
        &[&["set", "<((: <<EOF\nbody\nEOF))"]],
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
    let written = register_output(&rig, "nul_bytes", b"a\0\0b\0".to_vec());
    assert_eq!(rig.run(r#"args "$(nul_bytes)""#), 0);
    assert_eq!(written.get(), 5);
    assert_eq!(*rig.calls.borrow(), [vec!["ab"]]);
    let diagnostic = String::from_utf8(rig.errors.bytes()).unwrap();
    assert_eq!(diagnostic.matches("ignored null byte").count(), 1);
}

#[test]
fn output_beyond_the_expansion_bound_fails_explicitly() {
    let rig = Rig::new(Limits {
        // Admit the capture's 8195-byte scratch first, so failure happens
        // while streaming output rather than before starting the producer.
        expansion_bytes: 16 * 1024,
        ..Limits::default()
    });
    let written = register_output(&rig, "oversized", vec![b'x'; 64 * 1024]);
    assert_eq!(rig.run("args $(oversized)"), 2);
    assert!(written.get() > 0, "the producer must run before overflow");
    assert!(written.get() < 64 * 1024, "overflow must stop the producer");
    assert!(
        rig.calls.borrow().is_empty(),
        "never dispatch partial output"
    );
    assert_eq!(rig.run("args after"), 0, "the session must recover");
    assert_eq!(*rig.calls.borrow(), [vec!["after"]]);
    shutdown_and_check(&rig);
}

#[test]
fn process_substitution_redirect_supplies_a_live_input_descriptor() {
    let rig = Rig::new(Limits::default());
    register_copy(&rig);
    assert_eq!(rig.run("copy < <(echo value)"), 0);
    assert_eq!(rig.output.bytes(), b"value\n");
    assert!(rig.errors.bytes().is_empty());
    shutdown_and_check(&rig);
}

#[test]
fn word_substitution_precedes_command_redirections() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"args 2>errors "$(echo diagnostic >&2; echo value)""#),
        0,
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["value"]]);
    assert!(rig.fs.read_file("/home/guest/errors").unwrap().is_empty());
    assert_eq!(rig.errors.bytes(), b"diagnostic\n");
}

#[test]
fn later_redirect_substitution_inherits_an_earlier_stderr_redirect() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(": 2>errors >$(echo target; echo diagnostic >&2)"),
        0,
    );
    assert_eq!(
        rig.fs.read_file("/home/guest/errors").unwrap(),
        b"diagnostic\n"
    );
    assert!(rig.fs.read_file("/home/guest/target").unwrap().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn interrupt_process_substitution_redirect_drains_reader_and_body() {
    let rig = Rig::new(Limits::default());
    register_copy(&rig);
    let job = rig.shell.start("copy < <(while :; do :; done)").unwrap();
    for _ in 0..200 {
        rig.ex.drive(16);
    }
    assert!(!job.is_finished());
    assert_eq!(rig.host.active_count(), 1, "copy must be waiting for input");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    shutdown_and_check(&rig);
}

#[test]
fn background_writers_finish_before_substitution_capture_closes() {
    check(r#"x=$(echo value &); args "$x""#, &[&["value"]]);
}

#[test]
fn nested_background_writers_keep_inherited_capture_stdout() {
    for source in [
        r#"x=$( { echo value & } & ); args "$x""#,
        r#"x=$( (echo value &) ); args "$x""#,
        r#"x=$( { (echo ignored >/dev/null 2>/dev/null & echo value &); } & ); args "$x""#,
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), &[vec!["value"]], "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert!(rig.errors.bytes().is_empty(), "{source}");
        shutdown_and_check(&rig);
    }
}

#[test]
fn capture_waits_for_a_gated_background_writer() {
    for (source, active) in [
        (r#"x=$(gated &); args "$x""#, 1),
        (r#"x=$( { gated & } & ); args "$x""#, 1),
        (r#"x=$( (gated &) ); args "$x""#, 1),
        (r#"x=$( { gated & } | copy ); args "$x""#, 2),
    ] {
        let rig = Rig::new(Limits::default());
        register_copy(&rig);
        let (release, progress) = register_gated(&rig, b"value\n", false);
        let job = rig.shell.start(source).unwrap();
        for _ in 0..200 {
            rig.ex.drive(16);
        }
        assert_eq!(rig.host.active_count(), active, "{source}");
        assert!(
            !job.is_finished(),
            "a live capture writer must postpone EOF: {source}"
        );
        assert!(!progress.get(), "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        release.cancel();
        assert_eq!(rig.finish(job), 0, "{source}");
        assert!(
            progress.get(),
            "the writer must run, not be cancelled: {source}"
        );
        assert_eq!(*rig.calls.borrow(), &[vec!["value"]], "{source}");
        shutdown_and_check(&rig);
    }
}

#[test]
fn redirected_background_loop_does_not_postpone_capture_eof() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"x=$(while :; do :; done >/dev/null &); args "$x" after"#),
        0,
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["", "after"]]);
    assert!(
        rig.ex.drive(0).pending > 0,
        "the descendant is still running"
    );
    shutdown_and_check(&rig);
}

#[test]
fn noncapture_descendant_keeps_running_after_capture_eof_until_shutdown() {
    let rig = Rig::new(Limits::default());
    let (release, progress) = register_gated(&rig, b"", true);
    assert_eq!(rig.run(r#"x=$(gated >/dev/null &); args "$x" after"#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["", "after"]]);
    assert_eq!(rig.host.active_count(), 1);
    assert!(!progress.get(), "the side effect must wait for its gate");

    // Release only after foreground completion proves capture EOF. A child
    // incorrectly cancelled on EOF cannot make this observable progress.
    release.cancel();
    for _ in 0..200 {
        rig.ex.drive(16);
        if progress.get() {
            break;
        }
    }
    assert!(progress.get(), "the detached descendant must survive EOF");
    assert_eq!(rig.host.active_count(), 1, "shutdown still owns the child");
    shutdown_and_check(&rig);
}

#[test]
fn interrupt_cancels_a_running_body() {
    let rig = Rig::new(Limits::default());
    let job = rig
        .shell
        .start("x=$(while :; do :; done); args never")
        .unwrap();
    for _ in 0..200 {
        rig.ex.drive(16);
    }
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn interrupt_cancels_transitively_transferred_background_descendants() {
    let rig = Rig::new(Limits::default());
    let job = rig
        .shell
        .start("x=$( { { while :; do :; done & } & } & ); args never")
        .unwrap();
    for _ in 0..200 {
        rig.ex.drive(16);
    }
    assert!(
        !job.is_finished(),
        "the descendant still owns capture stdout"
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.ex.drive(64).pending,
        0,
        "interrupt must drain the entire subtree before shutdown"
    );
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    shutdown_and_check(&rig);
}

#[test]
fn deeply_nested_substitutions_run_as_separate_tasks() {
    let depth = 40;
    let source = format!("args {}x{}", "\"$(echo ".repeat(depth), ")\"".repeat(depth));
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

#[test]
fn internal_substitutions_do_not_take_background_job_numbers() {
    for prefix in [
        "value=$(true)",
        ": <(true)",
        ": >(true)",
        "value=$(false & wait %1)",
    ] {
        check(&format!("{prefix}; false & wait %1; args $?"), &[&["1"]]);
    }
    check(
        "false & value=$(true); : <(true) >(true); true & wait %1; args $?; wait %2; args $?",
        &[&["1"], &["0"]],
    );
    check(
        "false & wait; args $?; false & wait %1; args $?",
        &[&["0"], &["1"]],
    );
}

#[test]
fn async_identity_starts_empty_replaces_the_last_launch_and_survives_wait() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"args "$!"; false & first=$!; true & second=$!; args "$first" "$second" "$!"; wait %1; args $?; wait "$second"; args $?; args "$!"; wait; args $?"#), 0);
    let calls = rig.calls.borrow();
    assert_eq!(calls[0], [""]);
    let ids = &calls[1];
    assert_eq!(ids.len(), 3);
    assert!(ids[0].parse::<u64>().is_ok_and(|id| id > 0));
    assert!(ids[1].parse::<u64>().is_ok_and(|id| id > 0));
    assert_ne!(ids[0], ids[1]);
    assert_eq!(ids[1], ids[2]);
    assert_eq!(calls[2], ["1"]);
    assert_eq!(calls[3], ["0"]);
    assert_eq!(calls[4], [ids[1].clone()]);
    assert_eq!(calls[5], ["0"]);
    assert_eq!(rig.shell.background_jobs(), 0);
}

#[test]
fn async_identity_obeys_nounset_before_launch_and_is_bound_after_completion() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -u; args \"$!\"; args forbidden"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: !: unbound variable\n"
    );
    assert_eq!(rig.run(r#"false & pid=$!; wait "$pid"; args "$?" "$!""#), 0);
    let pid = rig.shell.state().borrow().variables["pid"].clone();
    assert_eq!(*rig.calls.borrow(), [vec!["1".to_owned(), pid]]);
}

#[test]
fn numeric_async_handles_select_pending_children_independently_of_job_numbers() {
    let rig = Rig::new(Limits::default());
    let first = register_status_gate(&rig, "first", 5);
    let second = register_status_gate(&rig, "second", 7);
    let job = rig.shell.start(r#"first & one=$!; second & two=$!; ready=yes; wait "$two"; args second "$?"; wait %1; args first "$?"; args "$!""#).unwrap();
    rig.drive_until_variable("ready", "yes");
    assert_eq!(rig.host.active_count(), 2);
    let one = rig.shell.state().borrow().variables["one"].clone();
    let two = rig.shell.state().borrow().variables["two"].clone();
    assert_ne!(one, two);
    second.cancel();
    for _ in 0..200 {
        rig.ex.drive(16);
        if !rig.calls.borrow().is_empty() {
            break;
        }
    }
    assert_eq!(*rig.calls.borrow(), [vec!["second", "7"]]);
    assert!(
        !job.is_finished(),
        "waiting for %1 must leave the first child pending"
    );
    assert_eq!(rig.host.active_count(), 1);
    first.cancel();
    assert_eq!(rig.finish(job), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["second".to_owned(), "7".to_owned()],
            vec!["first".to_owned(), "5".to_owned()],
            vec![two]
        ]
    );
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn substitutions_do_not_alias_async_handles_to_visible_job_numbers() {
    for prefix in ["value=$(true)", ": <(true)", ": >(true)"] {
        check(
            &format!(
                "{prefix}; false & first=$!; true & second=$!; wait \"$first\"; args $?; wait %2; args $?; wait; args $?"
            ),
            &[&["1"], &["0"], &["0"]],
        );
    }
}

#[test]
fn async_identity_expands_in_nested_operands_and_arithmetic_without_reparsing_a_handle() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"false & pid=$!; args "${u:-$!}" "${u:-${!}}" "$(( $! > 0 ))"; wait "$pid""#),
        1
    );
    let pid = rig.shell.state().borrow().variables["pid"].clone();
    assert_eq!(
        *rig.calls.borrow(),
        [vec![pid.clone(), pid, "1".to_owned()]]
    );
}

#[test]
fn numeric_kill_uses_only_an_async_handle_owned_by_the_current_scope() {
    let rig = Rig::new(Limits::default());
    let _release = register_status_gate(&rig, "status_gate", 0);
    assert_eq!(rig.run("status_gate & pid=$!"), 0);
    for _ in 0..200 {
        rig.ex.drive(16);
        if rig.host.active_count() == 1 {
            break;
        }
    }
    assert_eq!(rig.host.active_count(), 1);
    assert_eq!(rig.run(r#"(kill "$pid")"#), 1);
    assert_eq!(rig.host.active_count(), 1);
    assert_eq!(rig.run(r#"kill "$pid"; wait "$pid"; args $?"#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["130"]]);
    assert_eq!(rig.shell.background_jobs(), 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn isolated_readers_inherit_async_identity_without_changing_the_caller() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"false & parent=$!; capture=$(wait "$parent"; status=$?; true & child=$!; wait %1; printf '%s:%s:%s' "$status" "$parent" "$!"); args "$parent" "$!" "$capture"; (args "$!"; wait "$parent"; args $?; false & local=$!; args "$local" "$!"; wait "$local"; args $?); args "$!"; args "$!" | :; wait "$parent"; args $?"#), 0);
    let parent = rig.shell.state().borrow().variables["parent"].clone();
    let calls = rig.calls.borrow();
    assert_eq!(calls.len(), 8);
    assert_eq!(calls[0][0], parent);
    assert_eq!(calls[0][1], parent);
    let capture: Vec<_> = calls[0][2].split(':').collect();
    assert_eq!(capture.len(), 3);
    assert_eq!(capture[0], "127");
    assert_eq!(capture[1], parent);
    assert_ne!(capture[2], parent);
    assert_eq!(calls[1], [parent.clone()]);
    assert_eq!(calls[2], ["127"]);
    assert_eq!(calls[3][0], calls[3][1]);
    assert_ne!(calls[3][0], parent);
    assert_eq!(calls[4], ["1"]);
    assert_eq!(calls[5], [parent.clone()]);
    assert_eq!(calls[6], [parent]);
    assert_eq!(calls[7], ["1"]);
    assert!(!rig.shell.state().borrow().variables.contains_key("local"));
    assert!(!rig.shell.state().borrow().variables.contains_key("child"));
}

#[test]
fn background_children_inherit_the_previous_async_identity() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"false & previous=$!; args "$!" & current=$!; wait "$current"; args "$!"; wait "$previous"; args $?"#), 0);
    let state = rig.shell.state();
    let state = state.borrow();
    assert_ne!(state.variables["previous"], state.variables["current"]);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec![state.variables["previous"].clone()],
            vec![state.variables["current"].clone()],
            vec!["1".to_owned()]
        ]
    );
}

#[test]
fn process_substitution_handles_retain_status_without_taking_job_numbers() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#": <(false); input=$!; : >(true); output=$!; false & background=$!; wait "$input"; args $?; wait "$output"; args $?; wait %1; args $?; args "$!"; wait; args $?"#), 0);
    let state = rig.shell.state();
    let state = state.borrow();
    assert_ne!(state.variables["input"], state.variables["output"]);
    assert_ne!(state.variables["output"], state.variables["background"]);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["1".to_owned()],
            vec!["0".to_owned()],
            vec!["1".to_owned()],
            vec![state.variables["background"].clone()],
            vec!["0".to_owned()]
        ]
    );
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn process_substitution_inherits_the_callers_previous_async_identity() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"false & previous=$!; : <(printf '%s' "$!" > inherited); process=$!; wait "$process"; args "$?" "$!"; wait "$previous""#), 1);
    let state = rig.shell.state();
    let state = state.borrow();
    assert_ne!(state.variables["previous"], state.variables["process"]);
    assert_eq!(
        rig.fs.read_file("/home/guest/inherited").unwrap(),
        state.variables["previous"].as_bytes()
    );
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["0".to_owned(), state.variables["process"].clone()]]
    );
}

#[test]
fn waiting_for_a_pending_process_substitution_observes_its_status() {
    let rig = Rig::new(Limits::default());
    let release = register_status_gate(&rig, "status_gate", 9);
    let job = rig
        .shell
        .start(r#": <(status_gate); pid=$!; ready=yes; wait "$pid"; args $?"#)
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert_eq!(rig.host.active_count(), 1);
    assert!(!job.is_finished());
    assert!(rig.calls.borrow().is_empty());
    release.cancel();
    assert_eq!(rig.finish(job), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["9"]]);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn interrupting_a_numeric_process_substitution_wait_drains_the_child() {
    let rig = Rig::new(Limits::default());
    let _release = register_status_gate(&rig, "status_gate", 9);
    let job = rig
        .shell
        .start(r#": <(status_gate); pid=$!; ready=yes; wait "$pid"; args forbidden"#)
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    assert_eq!(rig.host.active_count(), 1);
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    shutdown_and_check(&rig);
}

#[test]
fn recursive_eval_has_an_execution_depth_bound_and_recovers() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16 * 1024 * 1024,
        ..Limits::default()
    });
    assert_eq!(
        rig.run(r#"n=0; s='n=$((n+1)); case $n in 160) :;; *) eval "$s";; esac'; eval "$s""#),
        2,
    );
    assert_eq!(rig.shell.state().borrow().variables["n"], "16");
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run("args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
}

// Each source contains one command per brace, so every brace and eval adds
// exactly one execute frame. The last source replaces eval with the leaf.
fn eval_chain(rig: &Rig, levels: usize, groups: usize, leaf: &str) {
    for index in 0..levels {
        let count = groups / levels + usize::from(index < groups % levels);
        let body = if index + 1 == levels {
            leaf.to_owned()
        } else {
            format!("eval \"$e{}\"", index + 1)
        };
        rig.variable(
            &format!("e{index}"),
            &format!("{}{body}{}", "{ ".repeat(count), "; }".repeat(count)),
        );
    }
}

#[test]
fn eval_accepts_sixteen_active_readers_and_rejects_the_seventeenth() {
    for (levels, status) in [(16, 0), (17, 2)] {
        let rig = Rig::new(Limits {
            expansion_bytes: 16 * 1024 * 1024,
            ..Limits::default()
        });
        eval_chain(&rig, levels, 0, "reached=yes");
        assert_eq!(rig.run("eval \"$e0\""), status, "eval levels {levels}");
        assert_eq!(
            rig.shell.state().borrow().variables.contains_key("reached"),
            status == 0,
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.ex.drive(64).pending, 0);
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
    }
}

#[test]
fn compound_eval_accepts_execution_depth_256_and_rejects_257() {
    // One outer eval + 16 evaluated commands + 239 braces = 256 frames.
    for (groups, status) in [(239, 0), (240, 2)] {
        let rig = Rig::new(Limits {
            expansion_bytes: 128 * 1024 * 1024,
            ..Limits::default()
        });
        eval_chain(&rig, 16, groups, "reached=yes");
        assert_eq!(rig.run("eval \"$e0\""), status, "brace count {groups}");
        assert_eq!(
            rig.shell.state().borrow().variables.contains_key("reached"),
            status == 0,
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.ex.drive(64).pending, 0);
        assert_eq!(rig.run("args recovered"), 0);
    }
}

#[test]
fn interrupting_the_deepest_compound_eval_drains_the_execution_chain() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024 * 1024,
        ..Limits::default()
    });
    let (_release, progress) = register_gated(&rig, b"unused", false);
    eval_chain(&rig, 16, 239, "gated");
    let job = rig.shell.start("eval \"$e0\"").unwrap();
    for _ in 0..2000 {
        rig.ex.drive(64);
        if rig.host.active_count() == 1 {
            break;
        }
    }
    assert_eq!(rig.host.active_count(), 1, "the deepest leaf must start");
    assert!(!job.is_finished());
    assert!(!progress.get());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn eval_inside_compound_commands_bounds_the_actual_execution_chain() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024 * 1024,
        ..Limits::default()
    });
    let body = format!(
        "{}n=$((n+1)); case $n in 32) :;; *) eval \"$s\";; esac{}",
        "{ ".repeat(24),
        "; }".repeat(24),
    );
    rig.variable("s", &body);
    assert_eq!(rig.run("n=0; eval \"$s\""), 2);
    let progress = rig.shell.state().borrow().variables["n"]
        .parse::<usize>()
        .unwrap();
    assert!(
        progress > 0 && progress < 16,
        "execution depth must stop before the eval-only ceiling: {progress}"
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn successive_evals_share_cumulative_script_admission() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024,
        function_depth: 32,
        ..Limits::default()
    });
    assert_eq!(
        rig.run(r#"n=0; f() { eval 'n=$((n+1))'; case $? in 0) f;; *) :;; esac; }; f"#),
        0,
    );
    let progress = rig.shell.state().borrow().variables["n"]
        .parse::<usize>()
        .unwrap();
    assert!(
        progress > 0 && progress < 32,
        "a fresh allowance per eval would reach the function ceiling: {progress}"
    );
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn eval_admits_parsed_storage_before_execution_and_keeps_empty_eval_valid() {
    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    assert_eq!(
        rig.run("value=before; eval 'value=after; args forbidden'"),
        2
    );
    assert_eq!(rig.shell.state().borrow().variables["value"], "before");
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("eval; eval ''"), 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn interrupting_nested_eval_unwinds_admission_without_undoing_completed_effects() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16 * 1024 * 1024,
        ..Limits::default()
    });
    rig.variable(
        "s",
        r#"n=$((n+1)); case $n in 160) :;; *) eval "$s";; esac"#,
    );
    let job = rig.shell.start("n=0; eval \"$s\"").unwrap();
    for _ in 0..2000 {
        rig.ex.drive(1);
        let progressed = rig
            .shell
            .state()
            .borrow()
            .variables
            .get("n")
            .is_some_and(|n| n != "0");
        if progressed {
            break;
        }
    }
    assert!(
        !job.is_finished(),
        "the fixture must interrupt an admitted eval chain"
    );
    assert_ne!(rig.shell.state().borrow().variables["n"], "0");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn interrupting_a_command_local_heredoc_discards_reader_effects_and_drains_children() {
    let rig = Rig::new(Limits::default());
    let (_release, progress) = register_gated(&rig, b"value\n", false);
    let job = rig
        .shell
        .start("unset x; set -u\ncat <<EOF\n${x:=reader}$(gated)$missing\nEOF\n")
        .unwrap();
    for _ in 0..2000 {
        rig.ex.drive(1);
        if rig.host.active_count() == 1 {
            break;
        }
    }
    assert_eq!(rig.host.active_count(), 1);
    assert!(!progress.get());
    assert!(!job.is_finished());
    assert!(!rig.shell.state().borrow().variables.contains_key("x"));
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(!rig.shell.state().borrow().variables.contains_key("x"));
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.run("args \"${x-unset}\" recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["unset", "recovered"]]);
}
