//! Original session-lifecycle and parser-interruption regressions.
use super::*;
use shell_engine::{
    interpreter::StartError,
    process::{GroupId, ProcessError, ProcessHost, ProcessId, SpawnRequest},
};
use std::cell::Cell;

#[test]
fn fatal_expansion_aborts_the_script_without_requesting_session_exit() {
    for source in [
        "echo ${missing:?required}; echo forbidden",
        "echo ${missing:?required}\necho forbidden",
        "f() { local scope=inside; echo ${missing:?required}; echo forbidden; }; f; echo forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("scope", "outside");
        assert_eq!(rig.run(source), 127, "{source}");
        assert!(!rig.shell.exit_requested(), "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("missing: required")
        );
        assert_eq!(rig.run(r#"args "$?" "$scope" recovered"#), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["127", "outside", "recovered"]]);
        assert!(!rig.shell.exit_requested());
    }
}

#[test]
fn explicit_exit_still_requests_session_shutdown() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("exit 7; echo forbidden"), 7);
    assert!(rig.shell.exit_requested());
    assert!(rig.output.bytes().is_empty());
}

struct ParseInterruptHost {
    inner: InProcessHost,
    probes: Cell<usize>,
    interrupt_at: Cell<usize>,
    groups: Cell<usize>,
}
impl ProcessHost for ParseInterruptHost {
    fn allocate_group(&self) -> GroupId {
        self.groups.set(self.groups.get() + 1);
        self.inner.allocate_group()
    }
    fn interrupted(&self) -> bool {
        let probes = self.probes.get() + 1;
        self.probes.set(probes);
        probes >= self.interrupt_at.get()
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
        self.inner.spawn(request)
    }
    fn wait(
        &self,
        pid: ProcessId,
    ) -> futures::future::LocalBoxFuture<'static, Result<i32, ProcessError>> {
        self.inner.wait(pid)
    }
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        self.inner.kill(pid, signal)
    }
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
        self.inner.kill_group(group, signal)
    }
    fn wait_group(
        &self,
        group: GroupId,
    ) -> futures::future::LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.inner.wait_group(group)
    }
    fn abandon_group(&self, group: GroupId, signal: i32) {
        self.inner.abandon_group(group, signal);
    }
}

#[test]
fn cancellation_during_parsing_has_interrupt_status_without_starting_a_job() {
    let rig = Rig::new(Limits::default());
    let host = Rc::new(ParseInterruptHost {
        inner: rig.host.clone(),
        probes: Cell::new(0),
        interrupt_at: Cell::new(24),
        groups: Cell::new(0),
    });
    let shell = Session::new(
        rig.ex.clone(),
        host.clone(),
        Rc::new(rig.fs.clone()),
        Limits::default(),
    );
    let error = shell
        .start(&":; ".repeat(256))
        .err()
        .expect("interrupt must stop parsing");
    assert_eq!(error, StartError::Interrupted);
    assert_eq!(error.status(), 130);
    assert!(host.probes.get() >= 24);
    assert_eq!(host.groups.get(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert!(!shell.exit_requested());
    host.interrupt_at.set(usize::MAX);
    assert_eq!(rig.finish(shell.start(":").unwrap()), 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(shell.shutdown().now_or_never(), Some(()));
}

#[test]
fn syntax_and_source_rejections_keep_status_two() {
    let rig = Rig::new(Limits::default());
    let error = rig
        .shell
        .start(")")
        .err()
        .expect("unmatched token must fail parsing");
    assert!(matches!(error, StartError::Invalid(_)));
    assert_eq!(error.status(), 2);
    assert_eq!(rig.run(":"), 0);
    let error = rig
        .shell
        .start(&" ".repeat(Limits::default().source_bytes + 1))
        .err()
        .expect("source limit must reject input");
    assert_eq!(error.status(), 2);
    assert_eq!(error.to_string(), "shell source limit exceeded");
    assert!(!rig.shell.exit_requested());
}
