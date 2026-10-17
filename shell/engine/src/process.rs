//! Process-host boundary. No OS subprocesses: the stand-in runs registered futures
//! on the shell executor, with the same descriptor and lifecycle contract as workers.
use crate::{
    executor::{Cancel, Executor, JoinHandle},
    io::FdTable,
};
use futures::future::LocalBoxFuture;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

pub type ProcessId = u64;
pub type GroupId = u64;
#[derive(Clone)]
pub struct SpawnRequest {
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub fds: FdTable,
    pub group: GroupId,
    pub parent: Option<ProcessId>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    UnknownCommand(String),
    UnknownProcess(ProcessId),
    GroupClosed(GroupId),
    InvalidParent(ProcessId),
    InvalidSignal,
    ProcessLimit,
    Runtime(i32),
}
impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownCommand(name) => write!(f, "command not found: {name}"),
            Self::UnknownProcess(pid) => write!(f, "unknown process: {pid}"),
            Self::GroupClosed(group) => write!(f, "process group is closing: {group}"),
            Self::InvalidParent(pid) => write!(f, "invalid process parent: {pid}"),
            Self::InvalidSignal => f.write_str("invalid signal"),
            Self::Runtime(errno) => write!(f, "runtime process error: errno {errno}"),
            Self::ProcessLimit => f.write_str("unreaped process limit exceeded"),
        }
    }
}
impl std::error::Error for ProcessError {}
/// All entry points are nonblocking. Waiting must register wake notifications, not
/// poll or sleep. Kill includes descendants; completion means the host has observed
/// their actual exits and released process-owned descriptors. EPIPE is an I/O error,
/// NOT a reason for the host to overwrite a guest's chosen exit status with 141.
pub trait ProcessHost {
    /// Allocate a group ID synchronously, without running command work. IDs are
    /// unique for the lifetime of this host, including through shared handles and
    /// after groups are reaped. Independent clients sharing a host must use this
    /// allocator. Explicit numeric IDs remain supported, but their caller owns
    /// avoiding aliases with other clients, including allocated IDs.
    fn allocate_group(&self) -> GroupId;
    fn allocate_background_group(&self) -> GroupId {
        self.allocate_group()
    }
    /// Nonblocking signal checkpoint. Only foreground cancellation consumes it.
    fn interrupted(&self) -> bool {
        false
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError>;
    fn wait(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<i32, ProcessError>>;
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError>;
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError>;
    /// Wait for and reap every process in the group, including descendants
    /// spawned while waiting. Use `wait` for an individual process's exit code.
    fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>>;
    /// Transfer cleanup ownership to the host when a caller drops its future.
    /// The host must arrange kill AND confirmed reaping without that future.
    fn abandon_group(&self, group: GroupId, signal: i32);
    /// Collect producers with no logical reader or process owner. Call again
    /// after session descriptors close; live peer readers remain independent.
    /// Hosts without detached I/O have no additional work.
    fn shutdown_io(&self) -> LocalBoxFuture<'static, ()> {
        Box::pin(futures::future::ready(()))
    }
}

struct Child {
    group: GroupId,
    parent: Option<ProcessId>,
    cancel: Cancel,
    signal: Rc<Cell<i32>>,
    exit: JoinHandle<i32>,
}
type Program = dyn Fn(SpawnRequest, Cancel) -> LocalBoxFuture<'static, i32>;
struct HostState {
    executor: Executor,
    registry: RefCell<BTreeMap<String, Rc<Program>>>,
    children: RefCell<BTreeMap<ProcessId, Child>>,
    // Only unreaped groups have entries; true means reject new descendants.
    groups: RefCell<BTreeMap<GroupId, bool>>,
    next: Cell<ProcessId>,
    next_group: Cell<GroupId>,
}
#[derive(Clone)]
pub struct InProcessHost(Rc<HostState>);
impl InProcessHost {
    pub fn new(executor: Executor) -> Self {
        Self(Rc::new(HostState {
            executor,
            registry: RefCell::new(BTreeMap::new()),
            children: RefCell::new(BTreeMap::new()),
            groups: RefCell::new(BTreeMap::new()),
            next: Cell::new(1),
            next_group: Cell::new(1),
        }))
    }
    /// Registry callbacks construct futures; command work belongs inside the future.
    pub fn register(
        &self,
        name: impl Into<String>,
        program: impl Fn(SpawnRequest, Cancel) -> LocalBoxFuture<'static, i32> + 'static,
    ) {
        self.0
            .registry
            .borrow_mut()
            .insert(name.into(), Rc::new(program));
    }
    pub fn active_count(&self) -> usize {
        self.0
            .children
            .borrow()
            .values()
            .filter(|child| !child.exit.is_finished())
            .count()
    }
    pub fn retained_count(&self) -> usize {
        self.0.children.borrow().len()
    }
    fn reap(&self, pid: ProcessId) {
        let mut children = self.0.children.borrow_mut();
        if let Some(removed) = children.remove(&pid) {
            // Preserve subtree ancestry when an intermediate process has already
            // exited and been waited before its descendants finish.
            for child in children
                .values_mut()
                .filter(|child| child.parent == Some(pid))
            {
                child.parent = removed.parent;
            }
            if !children.values().any(|child| child.group == removed.group) {
                self.0.groups.borrow_mut().remove(&removed.group);
            }
        }
    }
    fn signal_valid(signal: i32) -> Result<(), ProcessError> {
        if (1..=127).contains(&signal) {
            Ok(())
        } else {
            Err(ProcessError::InvalidSignal)
        }
    }
    fn cancel(child: &Child, signal: i32) {
        if !child.cancel.is_cancelled() {
            child.signal.set(signal);
            child.cancel.cancel();
        }
    }
}
impl ProcessHost for InProcessHost {
    fn allocate_group(&self) -> GroupId {
        let group = self.0.next_group.get();
        self.0
            .next_group
            .set(group.checked_add(1).expect("process group id exhausted"));
        group
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
        if self.retained_count() >= 4096 {
            return Err(ProcessError::ProcessLimit);
        }
        let name = request.argv.first().cloned().unwrap_or_default();
        let program = self
            .0
            .registry
            .borrow()
            .get(&name)
            .cloned()
            .ok_or_else(|| ProcessError::UnknownCommand(name))?;
        let group = request.group;
        let parent = request.parent;
        if self.0.groups.borrow().get(&group) == Some(&true) {
            return Err(ProcessError::GroupClosed(group));
        }
        if let Some(parent) = parent {
            let children = self.0.children.borrow();
            if !children.get(&parent).is_some_and(|child| {
                child.group == group && !child.exit.is_finished() && !child.cancel.is_cancelled()
            }) {
                return Err(ProcessError::InvalidParent(parent));
            }
        }
        let pid = self.0.next.get();
        self.0
            .next
            .set(pid.checked_add(1).expect("process id exhausted"));
        let cancel = Cancel::new();
        let child_cancel = cancel.clone();
        let signal = Rc::new(Cell::new(15));
        let child_signal = signal.clone();
        // Construct inside the task: a cancelled, never-polled child must not run
        // registry code, and its inherited endpoints must still be dropped.
        let exit = self.0.executor.spawn(async move {
            if child_cancel.is_cancelled() {
                return 128 + child_signal.get();
            }
            let future = program(request, child_cancel.clone());
            match child_cancel.run(future).await {
                Ok(status) => status,
                Err(_) => 128 + child_signal.get(),
            }
        });
        self.0.groups.borrow_mut().entry(group).or_insert(false);
        self.0.children.borrow_mut().insert(
            pid,
            Child {
                group,
                parent,
                cancel,
                signal,
                exit,
            },
        );
        Ok(pid)
    }
    fn wait(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<i32, ProcessError>> {
        let exit = self
            .0
            .children
            .borrow()
            .get(&pid)
            .map(|child| child.exit.clone());
        let host = self.clone();
        Box::pin(async move {
            let status = exit.ok_or(ProcessError::UnknownProcess(pid))?.await;
            host.reap(pid);
            Ok(status)
        })
    }
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        Self::signal_valid(signal)?;
        let children = self.0.children.borrow();
        if !children.contains_key(&pid) {
            return Err(ProcessError::UnknownProcess(pid));
        }
        // Walk ancestry, not only immediate children. Groups are independent, but
        // every child must inherit its parent's group at spawn.
        for (candidate, child) in children.iter() {
            let mut ancestor = Some(*candidate);
            while let Some(current) = ancestor {
                if current == pid {
                    Self::cancel(child, signal);
                    break;
                }
                ancestor = children.get(&current).and_then(|child| child.parent);
            }
        }
        Ok(())
    }
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
        Self::signal_valid(signal)?;
        if let Some(closed) = self.0.groups.borrow_mut().get_mut(&group) {
            *closed = true;
        }
        for child in self
            .0
            .children
            .borrow()
            .values()
            .filter(|child| child.group == group)
        {
            Self::cancel(child, signal);
        }
        Ok(())
    }
    fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        // Capture eagerly so another waiter may reap records without stealing
        // these joins. Subsequent waves include descendants spawned while waiting.
        let first: Vec<_> = self
            .0
            .children
            .borrow()
            .iter()
            .filter(|(_, child)| child.group == group)
            .map(|(&pid, child)| (pid, child.exit.clone()))
            .collect();
        let host = self.clone();
        Box::pin(async move {
            let mut batch = first;
            loop {
                for (pid, exit) in batch {
                    exit.await;
                    host.reap(pid);
                }
                batch = host
                    .0
                    .children
                    .borrow()
                    .iter()
                    .filter(|(_, child)| child.group == group)
                    .map(|(&pid, child)| (pid, child.exit.clone()))
                    .collect();
                if batch.is_empty() {
                    break;
                }
            }
            Ok(())
        })
    }
    fn abandon_group(&self, group: GroupId, signal: i32) {
        if self.kill_group(group, signal).is_ok() {
            let wait = self.wait_group(group);
            self.0.executor.spawn(async move {
                let _ = wait.await;
            });
        }
    }
}

/// An owned job lifetime. Await terminate on interrupts/shutdown; Drop transfers
/// unfinished cleanup to the process host, which must outlive the executor drain.
pub struct ProcessGroup {
    host: Rc<dyn ProcessHost>,
    id: GroupId,
    terminated: bool,
    signal: Option<Rc<Cell<Option<i32>>>>,
    abandon_signal: i32,
}
impl ProcessGroup {
    pub fn new(host: Rc<dyn ProcessHost>, id: GroupId) -> Self {
        Self {
            host,
            id,
            terminated: false,
            signal: None,
            abandon_signal: 15,
        }
    }
    pub fn with_signal(mut self, signal: Rc<Cell<Option<i32>>>) -> Self {
        self.signal = Some(signal);
        self
    }
    /// Confirm natural completion and release cleanup ownership without a signal.
    /// If this future is dropped before completion, Drop still abandons the group.
    pub async fn finish(&mut self) -> Result<(), ProcessError> {
        self.host.wait_group(self.id).await?;
        self.terminated = true;
        Ok(())
    }
    pub async fn terminate(&mut self, signal: i32) -> Result<(), ProcessError> {
        if !(1..=64).contains(&signal) {
            return Err(ProcessError::InvalidSignal);
        }
        self.abandon_signal = signal;
        if let Some(reason) = &self.signal {
            reason.set(Some(signal));
        }
        self.host.kill_group(self.id, signal)?;
        self.finish().await
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if !self.terminated {
            self.host.abandon_group(
                self.id,
                self.signal
                    .as_ref()
                    .and_then(|signal| signal.get())
                    .unwrap_or(self.abandon_signal),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::{IoError, pipe};
    use futures::FutureExt;
    fn request(name: &str, group: GroupId) -> SpawnRequest {
        SpawnRequest {
            argv: vec![name.to_owned()],
            env: BTreeMap::new(),
            cwd: "/".into(),
            fds: FdTable::default(),
            group,
            parent: None,
        }
    }
    #[test]
    fn group_allocator_is_shared_and_never_reuses_reaped_ids() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let other = host.clone();
        host.register("exit", |_, _| Box::pin(async { 0 }));
        let first = host.allocate_group();
        let second = other.allocate_group();
        assert_ne!(first, second);
        host.spawn(request("exit", first)).unwrap();
        other.spawn(request("exit", second)).unwrap();
        ex.drive(10);
        assert_eq!(host.wait_group(first).now_or_never(), Some(Ok(())));
        assert_eq!(other.wait_group(second).now_or_never(), Some(Ok(())));
        assert!(host.0.groups.borrow().is_empty());
        let third = other.allocate_group();
        let fourth = host.allocate_group();
        let mut ids = vec![first, second, third, fourth];
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 4);
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn explicit_numeric_groups_do_not_require_allocation() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("exit", |_, _| Box::pin(async { 17 }));
        // Explicit IDs are a caller-managed namespace, not allocator reservations.
        for group in [0, 123, GroupId::MAX] {
            let pid = host.spawn(request("exit", group)).unwrap();
            ex.drive(10);
            assert_eq!(host.wait(pid).now_or_never(), Some(Ok(17)));
        }
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn finish_confirms_natural_exit_without_cancelling() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("exit", |_, _| Box::pin(async { 17 }));
        let group = host.allocate_group();
        let pid = host.spawn(request("exit", group)).unwrap();
        let wait = host.wait(pid);
        let mut guard = ProcessGroup::new(Rc::new(host.clone()), group);
        assert_eq!(guard.finish().now_or_never(), None);
        assert!(!guard.terminated);
        ex.drive(10);
        assert_eq!(guard.finish().now_or_never(), Some(Ok(())));
        assert_eq!(wait.now_or_never(), Some(Ok(17)));
        assert!(guard.terminated);
        drop(guard);
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn dropped_pending_finish_preserves_abandon_cleanup() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("wait", |_, _| Box::pin(futures::future::pending()));
        let group = host.allocate_group();
        let pid = host.spawn(request("wait", group)).unwrap();
        let wait = host.wait(pid);
        let mut guard = ProcessGroup::new(Rc::new(host.clone()), group);
        assert_eq!(guard.finish().now_or_never(), None);
        drop(guard);
        ex.drive(20);
        assert_eq!(wait.now_or_never(), Some(Ok(143)));
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn group_wait_reaps_successive_descendant_waves() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let weak_host = Rc::downgrade(&host.0);
        let remaining = Rc::new(Cell::new(8192));
        let count = remaining.clone();
        host.register("chain", move |request, _| {
            let host = InProcessHost(weak_host.upgrade().unwrap());
            let count = count.clone();
            Box::pin(async move {
                if count.get() > 0 {
                    count.set(count.get() - 1);
                    host.spawn(request).unwrap();
                }
                0
            })
        });
        let group = host.allocate_group();
        host.spawn(request("chain", group)).unwrap();
        let wait = host.wait_group(group);
        let joined = ex.spawn(wait);
        ex.drive(100_000);
        assert_eq!(joined.now_or_never(), Some(Ok(())));
        assert_eq!(remaining.get(), 0);
        assert_eq!(host.retained_count(), 0);
        assert!(host.0.groups.borrow().is_empty());
    }
    #[test]
    fn exits_notify_joiners_and_reap_fds() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("write", |request, cancel| {
            Box::pin(async move {
                request
                    .fds
                    .get(13)
                    .unwrap()
                    .write_all(b"ok", &cancel)
                    .await
                    .unwrap();
                7
            })
        });
        let (read, write) = pipe();
        let mut req = request("write", 1);
        req.fds.insert(13, write);
        let pid = host.spawn(req).unwrap();
        let wait = host.wait(pid);
        let other = host.wait(pid);
        ex.drive(10);
        assert_eq!(host.active_count(), 0);
        assert_eq!(wait.now_or_never(), Some(Ok(7)));
        assert_eq!(other.now_or_never(), Some(Ok(7)));
        let mut bytes = [0; 8];
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(2)));
        assert_eq!(&bytes[..2], b"ok");
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(0)));
        assert_eq!(host.retained_count(), 0);
        assert!(host.0.groups.borrow().is_empty());
    }
    #[test]
    fn handled_broken_pipe_status_is_not_overwritten() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("handle", |req, _| {
            Box::pin(async move {
                assert_eq!(
                    req.fds.get(1).unwrap().write(b"x").await,
                    Err(IoError::BrokenPipe)
                );
                23
            })
        });
        let (read, write) = pipe();
        drop(read);
        let mut req = request("handle", 1);
        req.fds.insert(1, write);
        let pid = host.spawn(req).unwrap();
        ex.drive(10);
        assert_eq!(host.wait(pid).now_or_never(), Some(Ok(23)));
    }
    #[test]
    fn group_cancellation_confirms_subtree_without_background() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("wait", |_, _| Box::pin(futures::future::pending()));
        let root = host.spawn(request("wait", 1)).unwrap();
        let mut req = request("wait", 1);
        req.parent = Some(root);
        let child = host.spawn(req).unwrap();
        let mut req = request("wait", 1);
        req.parent = Some(child);
        let grandchild = host.spawn(req).unwrap();
        let background = host.spawn(request("wait", 2)).unwrap();
        let root_wait = host.wait(root);
        let child_wait = host.wait(child);
        let grandchild_wait = host.wait(grandchild);
        ex.drive(10);
        host.kill(root, 2).unwrap();
        ex.drive(10);
        assert_eq!(host.active_count(), 1);
        assert_eq!(host.wait_group(1).now_or_never(), Some(Ok(())));
        assert_eq!(root_wait.now_or_never(), Some(Ok(130)));
        assert_eq!(child_wait.now_or_never(), Some(Ok(130)));
        assert_eq!(grandchild_wait.now_or_never(), Some(Ok(130)));
        assert_eq!(host.retained_count(), 1);
        host.kill_group(2, 15).unwrap();
        assert!(matches!(
            host.spawn(request("wait", 2)),
            Err(ProcessError::GroupClosed(2))
        ));
        let wait = host.wait(background);
        ex.drive(10);
        assert_eq!(wait.now_or_never(), Some(Ok(143)));
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn cancellation_before_first_poll_drops_inherited_endpoints() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let called = Rc::new(Cell::new(false));
        let invocation = called.clone();
        host.register("never", move |_, _| {
            invocation.set(true);
            Box::pin(async { 0 })
        });
        let (read, write) = pipe();
        let mut req = request("never", 1);
        req.fds.insert(77, write);
        host.spawn(req).unwrap();
        host.abandon_group(1, 2);
        ex.drive(10);
        assert!(!called.get());
        assert_eq!(host.retained_count(), 0);
        assert_eq!(read.read(&mut [0; 1]).now_or_never(), Some(Ok(0)));
    }
    #[test]
    fn subtree_kill_survives_intermediate_reaping() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("wait", |_, _| Box::pin(futures::future::pending()));
        let gate = crate::executor::Event::default();
        let event = gate.clone();
        host.register("exit", move |_, _| {
            let wait = event.listen();
            Box::pin(async move {
                wait.await;
                0
            })
        });
        let root = host.spawn(request("wait", 1)).unwrap();
        let mut req = request("exit", 1);
        req.parent = Some(root);
        let middle = host.spawn(req).unwrap();
        let mut req = request("wait", 1);
        req.parent = Some(middle);
        let leaf = host.spawn(req).unwrap();
        let root_wait = host.wait(root);
        let leaf_wait = host.wait(leaf);
        ex.drive(10);
        gate.notify();
        ex.drive(10);
        assert_eq!(host.wait(middle).now_or_never(), Some(Ok(0)));
        host.kill(root, 2).unwrap();
        ex.drive(10);
        assert_eq!(host.wait_group(1).now_or_never(), Some(Ok(())));
        assert_eq!(root_wait.now_or_never(), Some(Ok(130)));
        assert_eq!(leaf_wait.now_or_never(), Some(Ok(130)));
        assert_eq!(host.retained_count(), 0);
    }
    #[test]
    fn dropped_group_transfers_confirmed_cleanup_to_executor() {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        host.register("wait", |_, _| Box::pin(futures::future::pending()));
        host.spawn(request("wait", 1)).unwrap();
        ex.drive(10);
        {
            let _guard = ProcessGroup::new(Rc::new(host.clone()), 1);
        }
        ex.drive(20);
        assert_eq!(host.active_count(), 0);
        assert_eq!(host.retained_count(), 0);
        assert!(host.0.groups.borrow().is_empty());
    }
}
