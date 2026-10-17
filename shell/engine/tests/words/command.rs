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

fn drive_eval_progress(rig: &Rig, job: &JoinHandle<i32>, goal: usize) -> usize {
    let mut progress = 0;
    for _ in 0..100_000 {
        rig.ex.drive(64);
        assert!(!job.is_finished(), "eval loop stopped before interruption");
        progress = rig.shell.state().borrow().variables["n"]
            .parse::<usize>()
            .unwrap();
        if progress >= goal {
            break;
        }
    }
    progress
}

fn fill_eval_reader_storage(rig: &Rig, source: &str) -> usize {
    let mut admitted = 0;
    for _ in 0..64 {
        let status = rig.run(source);
        if status != 0 {
            assert_eq!(status, 2, "{source}");
            break;
        }
        admitted += 1;
    }
    admitted
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
fn repeated_numeric_wait_reuses_retained_completion_without_restoring_percent_job() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            r#"false & pid=$!; wait "$pid"; first=$?; wait "$pid"; again=$?; wait %1; job=$?; args "$first" "$again" "$job""#
        ),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1", "1", "127"]]);
    assert_eq!(rig.shell.background_jobs(), 0);
    assert_eq!(rig.run(r#"kill -TERM "$pid"; args $?; wait "$pid""#), 1);
    assert_eq!(rig.calls.borrow()[1], ["1"]);
    assert_eq!(rig.run(r#"wait; wait "$pid""#), 127);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn bounded_wait_history_evicts_completed_handles_without_evicting_pending_jobs() {
    let rig = Rig::new(Limits {
        jobs: 2,
        ..Limits::default()
    });
    let _release = register_status_gate(&rig, "status_gate", 9);
    assert_eq!(rig.run("status_gate & pending=$!"), 0);
    let mut oldest = String::new();
    for round in 0..32 {
        assert_eq!(rig.run(r#"false & pid=$!; wait "$pid"; wait "$pid""#), 1);
        if round == 0 {
            oldest = rig.shell.state().borrow().variables["pid"].clone();
        }
        assert_eq!(rig.shell.background_jobs(), 1);
        assert_eq!(rig.host.active_count(), 1);
    }
    rig.variable("oldest", &oldest);
    assert_eq!(rig.run(r#"wait "$oldest""#), 127);
    assert_eq!(rig.run(r#"(wait "$pid"); args $?; wait "$pid""#), 1);
    assert_eq!(*rig.calls.borrow(), [vec!["127"]]);
    assert_eq!(rig.run(r#"kill %1; wait "$pending"; wait "$pending""#), 143);
    assert_eq!(rig.shell.background_jobs(), 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
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
fn braced_async_identity_is_empty_before_launch_and_readable_under_nounset_after_launch() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"args "$!" "${!}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["", ""]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"args "${!+set}""#), 0);
    assert_eq!(*rig.calls.borrow(), [vec![""]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"false & pid=$!; set -u; args "$!" "${!}" "${u:-${!}}"; wait "$pid""#),
        1
    );
    let pid = rig.shell.state().borrow().variables["pid"].clone();
    assert_eq!(*rig.calls.borrow(), [vec![pid.clone(), pid.clone(), pid]]);

    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"set -u; args "${!}"; args forbidden"#), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: !: unbound variable\n"
    );
}

#[test]
fn async_scalar_operators_test_presence_lazily_in_direct_and_nested_operands() {
    for option in ["+u", "-u"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!(
            r#"set {option}; args "${{!-fallback}}" "${{!:-fallback}}" "${{!+set}}" "${{!:+set}}" "${{u:-${{!+set}}}}" "${{u:-${{!:-fallback}}}}""#
        )), 0);
        assert_eq!(
            *rig.calls.borrow(),
            [vec!["fallback", "fallback", "", "", "", "fallback"]]
        );
        assert_eq!(rig.run(
            r#"false & pid=$!; args "${!-fallback}" "${!:-fallback}" "${!+set}" "${!:+set}" "${u:-${!+set}}" "${!:=unused}" "${!:?$missing}"; wait "$pid""#
        ), 1);
        let pid = rig.shell.state().borrow().variables["pid"].clone();
        assert_eq!(
            rig.calls.borrow()[1],
            [
                pid.clone(),
                pid.clone(),
                "set".into(),
                "set".into(),
                "set".into(),
                pid.clone(),
                pid
            ]
        );
        assert!(rig.errors.bytes().is_empty());
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"args "${!:=fallback}"; args forbidden"#), 1);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: $!: cannot assign in this way\n"
    );
    assert!(!rig.shell.state().borrow().variables.contains_key("!"));
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
    assert_eq!(*rig.calls.borrow(), [vec!["143"]]);
    assert_eq!(rig.shell.background_jobs(), 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn job_signal_forms_preserve_term_int_and_invalid_statuses() {
    for (kill, expected) in [
        ("kill %1", "143"),
        ("kill -s TERM %1", "143"),
        ("kill -15 %1", "143"),
        ("kill -s INT %1", "130"),
        ("kill -2 %1", "130"),
    ] {
        let rig = Rig::new(Limits::default());
        let _release = register_status_gate(&rig, "status_gate", 0);
        assert_eq!(
            rig.run(&format!("status_gate & {kill}; wait %1; args $?")),
            0,
            "{kill}"
        );
        assert_eq!(*rig.calls.borrow(), [vec![expected.to_owned()]], "{kill}");
        assert_eq!(rig.host.active_count(), 0, "{kill}");
        assert_eq!(rig.host.retained_count(), 0, "{kill}");
    }
    let rig = Rig::new(Limits::default());
    let _release = register_status_gate(&rig, "status_gate", 0);
    assert_eq!(
        rig.run("status_gate & kill -s INVALID %1; args $?; kill -TERM %1; wait %1; args $?"),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["1"], vec!["143"]]);
    assert_eq!(rig.errors.bytes(), b"kill: invalid signal\n");
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn unsupported_signals_and_signal_zero_do_not_cancel_owned_pending_jobs() {
    for (signal, diagnostic, status) in [
        ("CONT", "unsupported signal action", "2"),
        ("STOP", "unsupported signal action", "2"),
        ("CHLD", "unsupported signal action", "2"),
        ("64", "unsupported signal action", "2"),
        ("128", "invalid signal", "1"),
        ("SIGCONT", "unsupported signal action", "2"),
    ] {
        let rig = Rig::new(Limits::default());
        let _release = register_status_gate(&rig, "status_gate", 0);
        assert_eq!(
            rig.run(&format!(
                "status_gate & kill -s {signal} %1; args $?; kill -TERM %1; wait %1; args $?"
            )),
            0,
            "{signal}"
        );
        assert_eq!(*rig.calls.borrow(), [vec![status], vec!["143"]], "{signal}");
        assert_eq!(
            rig.errors.bytes(),
            format!("kill: {diagnostic}\n").as_bytes(),
            "{signal}"
        );
        assert_eq!(rig.host.active_count(), 0, "{signal}");
        assert_eq!(rig.host.retained_count(), 0, "{signal}");
    }
    let rig = Rig::new(Limits::default());
    let _release = register_status_gate(&rig, "status_gate", 0);
    assert_eq!(
        rig.run("status_gate & kill -0 %1; args $?; kill -TERM %1; wait %1; args $?"),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["0"], vec!["143"]]);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn invalid_signal_preserves_a_finite_background_job_and_wait_status() {
    for kill in [
        "kill -s INVALID %1",
        "kill -INVALID %1",
        "kill -sINVALID %1",
        "kill -128 %1",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "i=0; while ((i < 1000)); do ((i += 1)); done & {kill}; kill_status=$?; wait %1; args \"$kill_status\" \"$?\" \"$i\""
            )),
            0,
            "{kill}",
        );
        assert_eq!(*rig.calls.borrow(), [vec!["1", "0", "0"]], "{kill}");
        assert_eq!(rig.errors.bytes(), b"kill: invalid signal\n", "{kill}");
        assert_eq!(rig.ex.drive(64).pending, 0);
        assert_eq!(rig.host.active_count(), 0);
        assert_eq!(rig.host.retained_count(), 0);
    }
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
fn completed_process_substitution_numeric_waits_remain_repeatable_until_wait_all() {
    check(
        r#": <(exit 7); pid=$!; wait "$pid"; args $?; wait "$pid"; args $?; wait; wait "$pid"; args $?"#,
        &[&["7"], &["7"], &["127"]],
    );
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
fn long_running_loop_remains_interruptible_after_cumulative_work_would_exhaust() {
    let rig = Rig::new(Limits::default());
    let release = register_status_gate(&rig, "status_gate", 9);
    assert_eq!(rig.run("status_gate & background=$!"), 0);
    let job = rig.shell.start("while :; do :; done").unwrap();
    for _ in 0..20_000 {
        rig.ex.drive(64);
        assert!(
            !job.is_finished(),
            "elapsed loop work must not terminate the job"
        );
    }
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.shell.background_jobs(), 1);
    assert_eq!(rig.host.active_count(), 1);
    release.cancel();
    assert_eq!(rig.run(r#"wait "$background""#), 9);
    assert_eq!(rig.run("wait"), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn sustained_arithmetic_replay_yields_cancels_and_preserves_background() {
    let rig = Rig::new(Limits::default());
    let release = register_status_gate(&rig, "status_gate", 9);
    assert_eq!(rig.run("status_gate & background=$!"), 0);
    rig.variable("n", "0");
    let job = rig.shell.start("while ((1)); do ((n += 1)); done").unwrap();
    let peer = rig.ex.spawn(async { 7 });
    let progress = drive_eval_progress(&rig, &job, 8192);
    assert!(progress >= 8192, "replay stopped at {progress}");
    assert_eq!(peer.now_or_never(), Some(7), "replay must yield to peers");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.shell.background_jobs(), 1);
    assert_eq!(rig.host.active_count(), 1);
    release.cancel();
    assert_eq!(rig.run(r#"wait "$background""#), 9);
    assert_eq!(rig.run("wait; args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn repeated_pipeline_subshell_and_capture_tasks_release_execution_admission() {
    for body in [": | :", "(:)", "value=$(true)"] {
        let rig = Rig::new(Limits::default());
        let job = rig
            .shell
            .start(&format!("while :; do {body}; done"))
            .unwrap();
        for _ in 0..5000 {
            rig.ex.drive(64);
            assert!(!job.is_finished(), "elapsed task work terminated {body}");
        }
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130, "{body}");
        shutdown_and_check(&rig);
    }
}

#[test]
fn nameref_assignment_failure_discards_only_the_current_physical_read_unit() {
    let mut setup = String::from("target=value\n");
    for index in (1..=9).rev() {
        let target = if index == 9 {
            "target".to_owned()
        } else {
            format!("n{}", index + 1)
        };
        setup.push_str(&format!("declare -n n{index}={target}\n"));
    }

    let rig = Rig::new(Limits::default());
    let same_line = format!(
        "{setup}n1=changed; code=$?; printf '<%s>|<%s>|<%s>\\n' \"$code\" \"$target\" \"$n1\"\n"
    );
    assert_eq!(rig.run(&same_line), 1);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.shell.state().borrow().variables["target"], "value");

    let rig = Rig::new(Limits::default());
    let next_line = format!(
        "{setup}n1=changed\ncode=$?\nprintf '<%s>|<%s>|<%s>\\n' \"$code\" \"$target\" \"$n1\"\n"
    );
    assert_eq!(rig.run(&next_line), 0);
    assert_eq!(rig.output.bytes(), b"<1>|<value>|<>\n");

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(&format!(
            "{setup}eval 'n1=changed; printf INNER_BAD'; printf 'AFTER:%s\\n' \"$?\"\n"
        )),
        0
    );
    assert_eq!(rig.output.bytes(), b"AFTER:1\n");
    assert_eq!(rig.shell.state().borrow().variables["target"], "value");

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(&format!(
            "{setup}eval 'n1=changed\nfi'; printf 'AFTER:%s\\n' \"$?\"\n"
        )),
        0
    );
    assert_eq!(rig.output.bytes(), b"AFTER:2\n");
    assert_eq!(rig.shell.state().borrow().variables["target"], "value");
}

#[test]
fn failed_builtin_prefix_admission_restores_existing_and_absent_bindings() {
    for (existing, budget) in [
        (false, 64),
        (true, 64),
        (true, 128 * std::mem::size_of::<usize>()),
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: budget,
            ..Limits::default()
        });
        if existing {
            rig.variable("a", "before_a");
            rig.variable("b", "before_b");
        }
        assert_eq!(rig.run("a=1 b=2 true"), 2);
        let state = rig.shell.state();
        let state = state.borrow();
        assert_eq!(
            state.variables.get("a").map(String::as_str),
            existing.then_some("before_a")
        );
        assert_eq!(
            state.variables.get("b").map(String::as_str),
            existing.then_some("before_b")
        );
        assert!(rig.calls.borrow().is_empty());
    }
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
fn returned_evals_release_storage_before_later_function_calls() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024,
        function_depth: 32,
        ..Limits::default()
    });
    assert_eq!(
        rig.run(r#"n=0; f() { eval 'n=$((n+1))'; case $n in 32) :;; *) f;; esac; }; f"#),
        0,
    );
    let progress = rig.shell.state().borrow().variables["n"]
        .parse::<usize>()
        .unwrap();
    // Earlier evals returned before the next function call. Their discarded
    // source/AST copies must not consume this call's live-memory admission.
    assert_eq!(progress, 32);
    assert_eq!(rig.run(r#"n=0; g() { eval 'n=$((n+1))'; g; }; g"#), 2);
    assert_eq!(rig.shell.state().borrow().variables["n"], "32");
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn deep_function_calls_preserve_function_and_execution_depth_bounds() {
    // The top-level list consumes one execution level; each simple call
    // and its case body consume two more. Call 127's leaf fits at level 256.
    // Call 128 reaches 256, then rejects its case body before incrementing n.
    // Requesting 300 cannot bypass that guard, even with function_depth 512.
    for (function_depth, goal, status, admitted) in
        [(127, 127, 0, 127), (127, 128, 2, 127), (512, 300, 2, 127)]
    {
        let rig = Rig::new(Limits {
            function_depth,
            ..Limits::default()
        });
        rig.variable("goal", &goal.to_string());
        assert_eq!(
            rig.run(r#"n=0; f() case $((n=n+1)) in "$goal") :;; *) f;; esac; f"#),
            status,
            "function limit {function_depth}, requested depth {goal}",
        );
        assert_eq!(
            rig.shell.state().borrow().variables["n"],
            admitted.to_string()
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.ex.drive(64).pending, 0);
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
    }
}

#[test]
fn interrupting_deep_function_tasks_restores_frames_and_drains_the_leaf() {
    let rig = Rig::new(Limits {
        function_depth: 512,
        ..Limits::default()
    });
    let (_release, progress) = register_gated(&rig, b"unused", false);
    let job = rig
        .shell
        .start("set -- caller; n=0; f() case $((n=n+1)) in 127) gated;; *) f inner;; esac; f outer")
        .unwrap();
    for _ in 0..2000 {
        rig.ex.drive(64);
        if rig.host.active_count() == 1 {
            break;
        }
    }
    assert_eq!(rig.host.active_count(), 1, "the deepest leaf must start");
    assert_eq!(rig.shell.state().borrow().variables["n"], "127");
    assert!(!job.is_finished());
    assert!(!progress.get());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.run(r#"args "$1" recovered"#), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["caller", "recovered"]]);
}

#[test]
fn sequential_eval_loops_cross_the_former_allowance_and_interrupt_without_killing_background() {
    for body in ["n=$((n+1))", "eval_saved() { :; }; n=$((n+1))"] {
        let limits = Limits::default();
        // Every old reader reservation included at least 4096 metadata bytes.
        // 2048 completed inputs exceed that old cumulative cap eightfold.
        assert!(2048 * 4096 >= 8 * limits.expansion_bytes);
        let rig = Rig::new(limits);
        let release = register_status_gate(&rig, "status_gate", 9);
        assert_eq!(rig.run("status_gate & background=$!"), 0);
        rig.variable("n", "0");
        let job = rig
            .shell
            .start(&format!("while :; do eval '{body}'; done"))
            .unwrap();
        let progress = drive_eval_progress(&rig, &job, 2048);
        assert!(
            progress >= 2048,
            "eval effects stopped at {progress}: {body}"
        );
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert_eq!(rig.shell.background_jobs(), 1);
        assert_eq!(rig.host.active_count(), 1);
        release.cancel();
        assert_eq!(rig.run(r#"wait "$background""#), 9);
        assert_eq!(rig.run("wait; unset -f eval_saved; eval ':'"), 0);
        shutdown_and_check(&rig);
    }
}

#[test]
fn eval_descendants_keep_storage_after_return_and_release_it_when_reaped() {
    for (source, background) in [
        ("eval 'status_gate &'", true),
        ("eval ': <(status_gate)'", false),
        (
            "eval 'eval_saved() { status_gate & };' && eval_saved && unset -f eval_saved",
            true,
        ),
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 128 * 1024,
            ..Limits::default()
        });
        let release = register_status_gate(&rig, "status_gate", 9);
        let admitted = fill_eval_reader_storage(&rig, source);
        // Live reader storage fills before the independent 128-job ceiling.
        assert!(
            admitted > 0 && admitted < 64,
            "admitted {admitted}: {source}"
        );
        rig.ex.drive(128);
        assert_eq!(
            rig.shell.background_jobs(),
            if background { admitted } else { 0 }
        );
        assert_eq!(rig.host.active_count(), admitted);
        release.cancel();
        assert_eq!(rig.run("wait"), 0);
        assert_eq!(rig.host.active_count(), 0);
        assert_eq!(rig.host.retained_count(), 0);
        assert_eq!(rig.run(source), 0, "reaping must return storage: {source}");
        assert_eq!(rig.run("wait"), 0);
        shutdown_and_check(&rig);
    }
}

#[test]
fn stored_eval_functions_and_isolated_snapshots_keep_their_live_storage() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128 * 1024,
        ..Limits::default()
    });
    let release = register_status_gate(&rig, "status_gate", 9);
    let mut admitted = 0;
    for index in 0..64 {
        rig.variable("definition", &format!("kept{index}() {{ :; }}"));
        let status = rig.run(r#"eval "$definition""#);
        if status != 0 {
            assert_eq!(status, 2);
            break;
        }
        admitted += 1;
    }
    assert!(
        admitted > 0 && admitted < 64,
        "stored {admitted} definitions"
    );
    assert_eq!(rig.shell.state().borrow().functions.len(), admitted);
    assert_eq!(rig.run("status_gate & background=$!"), 0);
    let names = (0..admitted)
        .map(|index| format!("kept{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(rig.run(&format!("unset -f {names}")), 0);
    assert!(rig.shell.state().borrow().functions.is_empty());
    // The child snapshot still owns the same immutable bodies and admission.
    assert_eq!(rig.run(r#"eval "$definition""#), 2);
    release.cancel();
    assert_eq!(rig.run(r#"wait "$background""#), 9);
    assert_eq!(rig.run("wait"), 0);
    assert_eq!(rig.run(r#"eval "$definition""#), 0);
    assert_eq!(rig.run(&format!("unset -f kept{admitted}")), 0);
    shutdown_and_check(&rig);
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
