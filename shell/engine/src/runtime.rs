//! Original runtime_proc adapter. Every task operation is immediate; only the
//! embedding's reactor turn calls the blocking `poll` import. Descriptors from
//! preview1 path_open, runtime pipes and inherited stdio share one namespace.
use crate::{
    executor::Executor,
    io::{Endpoint, FdTable, FileSystem, HostEndpoint, IoError, OpenOptions},
    process::{GroupId, ProcessError, ProcessHost, ProcessId, SpawnRequest},
};
use futures::{FutureExt, future::LocalBoxFuture};
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

#[cfg(target_os = "wasi")]
mod wasi;
#[cfg(target_os = "wasi")]
pub use wasi::WasiAbi;

const AGAIN: i32 = 6;
// runtime/proc/signals.ts: DEFAULT=0, IGNORE=1, HANDLE=2. This is a
// disposition, not the signal number or the self-signal operation (mode 3).
#[cfg(any(target_os = "wasi", test))]
const SIGNAL_DISPOSITION_HANDLE: i32 = 2;
#[cfg(any(target_os = "wasi", test))]
fn register_interrupt_handler(signal: impl FnOnce(i32, i32) -> i32) -> Result<(), i32> {
    match signal(2, SIGNAL_DISPOSITION_HANDLE) {
        result if result < 0 => Err(-result),
        _ => Ok(()),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Binding {
    pub child: u32,
    pub parent: u32,
}
#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSpawn {
    pub executable: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub job: i32,
    pub fds: Vec<Binding>,
}
/// Wire records are encoded explicitly as little-endian, not by casting Rust
/// structs. Both input and output records occupy exactly 16 bytes in guest RAM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub kind: u32,
    pub id: u32,
    pub userdata: u64,
}
impl Subscription {
    pub fn encode(self) -> [u8; 16] {
        let mut bytes = [0; 16];
        bytes[..4].copy_from_slice(&self.kind.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.id.to_le_bytes());
        bytes[8..].copy_from_slice(&self.userdata.to_le_bytes());
        bytes
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PollEvent {
    pub userdata: u64,
    pub kind: u32,
    pub flags: u32,
}
impl PollEvent {
    pub fn decode(bytes: [u8; 16]) -> Self {
        Self {
            userdata: u64::from_le_bytes(bytes[..8].try_into().unwrap()),
            kind: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            flags: u32::from_le_bytes(bytes[12..].try_into().unwrap()),
        }
    }
}
/// Injectable boundary keeps native engine tests independent of WASM imports.
/// Errnos are positive WASI errnos here; the WASM adapter decodes negative results.
/// `wait_job` confirms descendant teardown and reaps runtime-owned tombstones.
pub trait Abi {
    /// The embedder's initial logical bindings, excluding private directory preopens
    /// and descriptors subsequently allocated by this guest.
    fn inherited_fds(&self) -> Vec<u32>;
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32>;
    fn job_of(&self, pid: u32) -> Result<u32, i32>;
    fn wait(&self, pid: u32) -> Result<i32, i32>;
    /// Nonblocking runtime wait_job with NOHANG=1. EAGAIN until all members exit.
    fn wait_job(&self, job: u32) -> Result<i32, i32>;
    fn kill(&self, pid: u32, signal: i32) -> Result<(), i32>;
    fn kill_job(&self, job: u32, signal: i32) -> Result<(), i32>;
    fn pipe(&self) -> Result<(u32, u32), i32>;
    fn dup(&self, fd: u32) -> Result<u32, i32>;
    fn close(&self, fd: u32);
    /// One preview1 directory operation. Existing directories (never files)
    /// are accepted only for mkdir -p; the caller walks parent components.
    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32>;
    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32>;
    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32>;
    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32>;
    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32>;
    fn interrupted(&self) -> i32;
}
struct Waiter {
    kind: u32,
    id: u32,
    waker: Waker,
}
struct Group {
    // Runtime jobs seal when their last member exits. A shell group may start
    // later commands, so each direct child owns a job (including its descendants).
    runtime_jobs: Vec<u32>,
    background: bool,
    closing: bool,
}
struct Child {
    group: GroupId,
    status: Cell<Option<i32>>,
}
struct State {
    abi: Rc<dyn Abi>,
    executor: Executor,
    waiters: RefCell<BTreeMap<u64, Waiter>>,
    next_waiter: Cell<u64>,
    next_group: Cell<GroupId>,
    groups: RefCell<BTreeMap<GroupId, Group>>,
    children: RefCell<BTreeMap<ProcessId, Rc<Child>>>,
}
#[derive(Clone)]
pub struct Runtime(Rc<State>);
impl Runtime {
    pub fn new(abi: Rc<dyn Abi>, executor: Executor) -> Self {
        Self(Rc::new(State {
            abi,
            executor,
            waiters: RefCell::new(BTreeMap::new()),
            next_waiter: Cell::new(1),
            next_group: Cell::new(1),
            groups: RefCell::new(BTreeMap::new()),
            children: RefCell::new(BTreeMap::new()),
        }))
    }
    /// Own one fd binding. Endpoint clones share it; the final clone closes it.
    pub fn endpoint(&self, fd: u32) -> Endpoint {
        Endpoint::host(Rc::new(RuntimeEndpoint {
            runtime: self.clone(),
            fd,
        }))
    }
    /// Bootstrap the shell's logical namespace with every inherited binding,
    /// not just stdio. Private physical duplicates keep endpoint ownership separate.
    pub fn stdio(&self) -> Result<FdTable, IoError> {
        let mut fds = FdTable::default();
        for fd in self.0.abi.inherited_fds() {
            fds.insert(fd, self.endpoint(self.0.abi.dup(fd).map_err(io_error)?));
        }
        Ok(fds)
    }
    fn ready(&self, kind: u32, id: u32) -> Ready {
        Ready {
            runtime: self.clone(),
            kind,
            id,
            token: None,
        }
    }
    /// Drive only BETWEEN executor turns. With timeout 0 this never blocks;
    /// timeout -1 parks until host readiness or a signal. No task calls poll.
    pub fn poll(&self, timeout: i32) -> Result<usize, i32> {
        let subscriptions: Vec<_> = self
            .0
            .waiters
            .borrow()
            .iter()
            .map(|(&token, waiter)| Subscription {
                kind: waiter.kind,
                id: waiter.id,
                userdata: token,
            })
            .collect();
        let mut events = vec![PollEvent::default(); subscriptions.len()];
        let count = self.0.abi.poll(&subscriptions, timeout, &mut events)?;
        if count > events.len() {
            return Err(28);
        }
        let mut wakers = Vec::new();
        {
            let mut waiters = self.0.waiters.borrow_mut();
            for event in events.into_iter().take(count) {
                if waiters
                    .get(&event.userdata)
                    .is_some_and(|waiter| waiter.kind == event.kind)
                    && let Some(waiter) = waiters.remove(&event.userdata)
                {
                    wakers.push(waiter.waker);
                }
            }
        }
        for waker in wakers {
            waker.wake();
        }
        Ok(count)
    }
    pub fn take_interrupt(&self) -> bool {
        self.0.abi.interrupted() == 2
    }
    fn group(&self, background: bool) -> GroupId {
        let id = self.0.next_group.get();
        self.0
            .next_group
            .set(id.checked_add(1).expect("group id exhausted"));
        self.0.groups.borrow_mut().insert(
            id,
            Group {
                runtime_jobs: Vec::new(),
                background,
                closing: false,
            },
        );
        id
    }
    pub fn retained_count(&self) -> usize {
        self.0.children.borrow().len()
    }
}
struct Ready {
    runtime: Runtime,
    kind: u32,
    id: u32,
    token: Option<u64>,
}
impl Future for Ready {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        if let Some(token) = this.token {
            let mut waiters = this.runtime.0.waiters.borrow_mut();
            match waiters.get_mut(&token) {
                None => return Poll::Ready(()),
                Some(waiter) => waiter.waker = cx.waker().clone(),
            }
        } else {
            let token = this.runtime.0.next_waiter.get();
            this.runtime
                .0
                .next_waiter
                .set(token.checked_add(1).expect("reactor token exhausted"));
            this.runtime.0.waiters.borrow_mut().insert(
                token,
                Waiter {
                    kind: this.kind,
                    id: this.id,
                    waker: cx.waker().clone(),
                },
            );
            this.token = Some(token);
        }
        Poll::Pending
    }
}
impl Drop for Ready {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            self.runtime.0.waiters.borrow_mut().remove(&token);
        }
    }
}
struct RuntimeEndpoint {
    runtime: Runtime,
    fd: u32,
}
impl Drop for RuntimeEndpoint {
    fn drop(&mut self) {
        self.runtime.0.abi.close(self.fd);
    }
}
impl HostEndpoint for RuntimeEndpoint {
    fn runtime_fd(&self) -> Option<u32> {
        Some(self.fd)
    }
    fn read<'a>(&'a self, output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            loop {
                match self.runtime.0.abi.read(self.fd, output) {
                    Err(AGAIN) => self.runtime.ready(0, self.fd).await,
                    result => return result.map_err(io_error),
                }
            }
        }
        .boxed_local()
    }
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            loop {
                match self.runtime.0.abi.write(self.fd, input) {
                    Err(AGAIN) => self.runtime.ready(1, self.fd).await,
                    result => return result.map_err(io_error),
                }
            }
        }
        .boxed_local()
    }
}
impl FileSystem for Runtime {
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        async move {
            if !path.starts_with('/')
                || path.len() > crate::io::MAX_PATH_BYTES
                || path.contains('\0')
            {
                return Err(IoError::InvalidPath);
            }
            if parents {
                for (index, _) in path.match_indices('/').filter(|(index, _)| *index > 0) {
                    crate::executor::yield_now().await;
                    self.0.abi.mkdir(&path[..index], true).map_err(io_error)?;
                }
            }
            crate::executor::yield_now().await;
            self.0.abi.mkdir(path, parents).map_err(io_error)
        }
        .boxed_local()
    }
    fn pipe(&self) -> Result<(Endpoint, Endpoint), IoError> {
        let (read, write) = self.0.abi.pipe().map_err(io_error)?;
        Ok((self.endpoint(read), self.endpoint(write)))
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        async move {
            self.0
                .abi
                .open(path, options)
                .map(|fd| self.endpoint(fd))
                .map_err(io_error)
        }
        .boxed_local()
    }
}
fn io_error(errno: i32) -> IoError {
    match errno {
        8 | 76 => IoError::BadDescriptor,
        64 => IoError::BrokenPipe,
        44 => IoError::NotFound,
        28 | 37 => IoError::InvalidPath,
        33 | 48 | 51 => IoError::LimitExceeded,
        _ => IoError::Runtime(errno),
    }
}
impl ProcessHost for Runtime {
    fn allocate_group(&self) -> GroupId {
        self.group(false)
    }
    fn allocate_background_group(&self) -> GroupId {
        self.group(true)
    }
    fn interrupted(&self) -> bool {
        self.take_interrupt()
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
        if self.retained_count() >= 4096 {
            return Err(ProcessError::ProcessLimit);
        }
        // The ABI's caller is always the shell. A synthetic parent would silently
        // change signal authority and is not representable by this ABI.
        if let Some(parent) = request.parent {
            return Err(ProcessError::InvalidParent(parent));
        }
        let background = self
            .0
            .groups
            .borrow()
            .get(&request.group)
            .filter(|group| !group.closing)
            .map(|group| group.background)
            .ok_or(ProcessError::GroupClosed(request.group))?;
        let executable = request
            .argv
            .first()
            .cloned()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| ProcessError::UnknownCommand(String::new()))?;
        let fds = request
            .fds
            .iter()
            .map(|(&child, endpoint)| {
                endpoint
                    .runtime_fd()
                    .map(|parent| Binding { child, parent })
                    .ok_or(ProcessError::Runtime(8))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let spec = RuntimeSpawn {
            executable,
            argv: request.argv,
            env: request.env,
            cwd: request.cwd,
            job: if background { -1 } else { 0 },
            fds,
        };
        let pid = self.0.abi.spawn(&spec).map_err(ProcessError::Runtime)?;
        // Spawn has synchronously retained inherited endpoints. Dropping request's
        // descriptor table now cannot close the child's open descriptions.
        let runtime_job = match self.0.abi.job_of(pid) {
            Ok(job) => job,
            Err(errno) => {
                // Do not strand a reserved process when host metadata fails.
                let _ = self.0.abi.kill(pid, 9);
                self.0.children.borrow_mut().insert(
                    pid as u64,
                    Rc::new(Child {
                        group: request.group,
                        status: Cell::new(None),
                    }),
                );
                self.abandon_group(request.group, 9);
                return Err(ProcessError::Runtime(errno));
            }
        };
        self.0
            .groups
            .borrow_mut()
            .get_mut(&request.group)
            .unwrap()
            .runtime_jobs
            .push(runtime_job);
        self.0.children.borrow_mut().insert(
            pid as u64,
            Rc::new(Child {
                group: request.group,
                status: Cell::new(None),
            }),
        );
        Ok(pid as u64)
    }
    fn wait(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<i32, ProcessError>> {
        let child = self.0.children.borrow().get(&pid).cloned();
        let runtime = self.clone();
        async move {
            let child = child.ok_or(ProcessError::UnknownProcess(pid))?;
            loop {
                if let Some(status) = child.status.get() {
                    return Ok(status);
                }
                match runtime.0.abi.wait(pid as u32) {
                    Ok(status) => {
                        child.status.set(Some(status));
                        runtime.0.children.borrow_mut().remove(&pid);
                        return Ok(status);
                    }
                    Err(AGAIN) => runtime.ready(2, pid as u32).await,
                    Err(errno) => return Err(ProcessError::Runtime(errno)),
                }
            }
        }
        .boxed_local()
    }
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        if !self.0.children.borrow().contains_key(&pid) {
            return Err(ProcessError::UnknownProcess(pid));
        }
        self.0
            .abi
            .kill(pid as u32, signal)
            .map_err(ProcessError::Runtime)
    }
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
        // runtime_proc accepts signals 1..64, not signal-zero existence probes.
        // An invalid request must not close admission to an otherwise live group.
        if !(1..=64).contains(&signal) {
            return Err(ProcessError::InvalidSignal);
        }
        let jobs = self.0.groups.borrow_mut().get_mut(&group).map(|group| {
            group.closing = true;
            group.runtime_jobs.clone()
        });
        let mut error = None;
        for job in jobs.into_iter().flatten() {
            if let Err(errno) = self.0.abi.kill_job(job, signal) {
                // One failed delivery must not strand later children/descendants.
                error.get_or_insert(ProcessError::Runtime(errno));
            }
        }
        error.map_or(Ok(()), Err)
    }
    fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        let runtime = self.clone();
        async move {
            let mut error = None;
            let mut failed_jobs = Vec::new();
            loop {
                let batch: Vec<_> = runtime
                    .0
                    .children
                    .borrow()
                    .iter()
                    .filter(|(_, child)| child.group == group)
                    .map(|(&pid, _)| runtime.wait(pid))
                    .collect();
                if batch.is_empty() {
                    let job = runtime.0.groups.borrow().get(&group).and_then(|group| {
                        group
                            .runtime_jobs
                            .iter()
                            .copied()
                            .find(|job| !failed_jobs.contains(job))
                    });
                    let Some(job) = job else {
                        if let Some(error) = error {
                            return Err(error);
                        }
                        runtime.0.groups.borrow_mut().remove(&group);
                        return Ok(());
                    };
                    loop {
                        match runtime.0.abi.wait_job(job) {
                            Ok(_) => {
                                if let Some(group) = runtime.0.groups.borrow_mut().get_mut(&group) {
                                    group.runtime_jobs.retain(|retained| *retained != job);
                                }
                                break;
                            }
                            Err(AGAIN) => runtime.ready(4, job).await,
                            Err(errno) => {
                                failed_jobs.push(job);
                                error.get_or_insert(ProcessError::Runtime(errno));
                                break;
                            }
                        }
                    }
                    // A shell task may have admitted more children while a prior
                    // child's descendant confirmation was pending. Recheck both
                    // children and jobs before releasing the logical group.
                } else {
                    for result in futures::future::join_all(batch).await {
                        result?;
                    }
                }
            }
        }
        .boxed_local()
    }
    fn abandon_group(&self, group: GroupId, signal: i32) {
        let _ = self.kill_group(group, signal);
        let wait = self.wait_group(group);
        self.0.executor.spawn(async move {
            let _ = wait.await;
        });
    }
}

#[cfg(test)]
mod tests;
