//! Original command-substitution controls, checked against GNU Bash 5.3.15
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
        &[&["'$'{x,y}", "$((1+2))"]],
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
