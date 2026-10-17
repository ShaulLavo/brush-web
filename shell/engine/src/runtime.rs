//! Original runtime_proc adapter. Every task operation is immediate; only the
//! embedding's reactor turn calls the blocking `poll` import. Descriptors from
//! preview1 path_open, runtime pipes and inherited stdio share one namespace.
use crate::{
    executor::{Cancel, Executor, JoinHandle},
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
    rc::{Rc, Weak},
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

const MAX_RETAINED_PROCESSES: usize = 4096;
const INPUT_UNIT_BYTES: usize = 4096;

struct InputSlot {
    used: Rc<Cell<usize>>,
    units: usize,
    bytes: usize,
}
impl InputSlot {
    fn grow(&mut self, bytes: usize, children: usize) -> Result<(), ProcessError> {
        let total = self
            .bytes
            .checked_add(bytes)
            .ok_or(ProcessError::ProcessLimit)?;
        let units = total.div_ceil(INPUT_UNIT_BYTES);
        let extra = units - self.units;
        if self
            .used
            .get()
            .saturating_add(extra)
            .saturating_add(children)
            .saturating_add(1)
            > MAX_RETAINED_PROCESSES
        {
            return Err(ProcessError::ProcessLimit);
        }
        self.used.set(self.used.get() + extra);
        self.units = units;
        self.bytes = total;
        Ok(())
    }
    fn restore(&mut self, bytes: usize) {
        let units = bytes.div_ceil(INPUT_UNIT_BYTES);
        self.used.set(self.used.get() - (self.units - units));
        self.bytes = bytes;
        self.units = units;
    }
}
impl Drop for InputSlot {
    fn drop(&mut self) {
        self.used.set(self.used.get() - self.units);
    }
}

struct PreparedInput {
    source: Endpoint,
    reader: Endpoint,
    cancel: Cancel,
    future: LocalBoxFuture<'static, Result<(), IoError>>,
    slot: InputSlot,
    users: Vec<GroupId>,
}

struct InputPump {
    cancel: Cancel,
    join: JoinHandle<Result<(), IoError>>,
    _slot: InputSlot,
    reader: Weak<dyn HostEndpoint>,
    users: Vec<GroupId>,
}
impl InputPump {
    fn reserve_user(&mut self, group: GroupId, children: usize) -> Result<(), ProcessError> {
        if self.users.contains(&group) || self.users.len() < self.users.capacity() {
            return Ok(());
        }
        let bytes = self._slot.bytes;
        self._slot.grow(std::mem::size_of::<GroupId>(), children)?;
        if self.users.try_reserve_exact(1).is_err() {
            self._slot.restore(bytes);
            return Err(ProcessError::ProcessLimit);
        }
        Ok(())
    }
    fn unowned(&self) -> bool {
        self.users.is_empty() && self.reader.strong_count() == 0
    }
}
impl Drop for InputPump {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

fn input_future(
    source: Endpoint,
    writer: Endpoint,
    cancel: Cancel,
) -> impl Future<Output = Result<(), IoError>> {
    async move {
        let mut buffer = [0; 1024];
        loop {
            let count = source.read_cancelled(&mut buffer, &cancel).await?;
            if count == 0 {
                return Ok(());
            }
            writer.write_all(&buffer[..count], &cancel).await?;
        }
    }
}

fn input_future_bytes<F>(_: &impl FnOnce(Endpoint, Endpoint, Cancel) -> F) -> usize {
    std::mem::size_of::<F>()
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
    input_slots: Rc<Cell<usize>>,
    inputs: RefCell<Vec<InputPump>>,
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
            input_slots: Rc::new(Cell::new(0)),
            inputs: RefCell::new(Vec::new()),
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
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
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

    fn prepare_input(
        &self,
        source: &Endpoint,
        payload: usize,
    ) -> Result<PreparedInput, ProcessError> {
        // Include retained payload, the concrete pump, queue/task metadata and
        // vector slots. Input owners share the existing bounded process slots.
        let bytes = payload
            .checked_add(input_future_bytes(&input_future))
            .and_then(|n| {
                n.checked_add(INPUT_UNIT_BYTES + 16 * std::mem::size_of::<PreparedInput>())
            })
            .ok_or(ProcessError::ProcessLimit)?;
        let units = bytes.div_ceil(INPUT_UNIT_BYTES);
        let used = self
            .0
            .input_slots
            .get()
            .checked_add(units)
            .ok_or(ProcessError::ProcessLimit)?;
        if used.saturating_add(self.retained_count()).saturating_add(1) > MAX_RETAINED_PROCESSES {
            return Err(ProcessError::ProcessLimit);
        }
        self.0.input_slots.set(used);
        let slot = InputSlot {
            used: self.0.input_slots.clone(),
            units,
            bytes,
        };
        let (reader, writer) = self.pipe().map_err(|_| ProcessError::Runtime(8))?;
        let cancel = Cancel::new();
        let mut users = Vec::new();
        users
            .try_reserve_exact(1)
            .map_err(|_| ProcessError::ProcessLimit)?;
        let future = input_future(source.buffered_source(), writer, cancel.clone());
        Ok(PreparedInput {
            source: source.clone(),
            reader,
            cancel,
            future: future.boxed_local(),
            slot,
            users,
        })
    }

    fn input_binding(
        &self,
        endpoint: &Endpoint,
        inputs: &mut Vec<PreparedInput>,
    ) -> Result<u32, ProcessError> {
        if let Some(fd) = endpoint.runtime_fd() {
            return Ok(fd);
        }
        let payload = endpoint
            .buffered_input_bytes()
            .ok_or(ProcessError::Runtime(8))?;
        if let Some(input) = inputs.iter().find(|input| input.source.same_open(endpoint)) {
            return Ok(input.reader.runtime_fd().expect("host pipe descriptor"));
        }
        let input = self.prepare_input(endpoint, payload)?;
        inputs
            .try_reserve_exact(1)
            .map_err(|_| ProcessError::ProcessLimit)?;
        let fd = input.reader.runtime_fd().expect("host pipe descriptor");
        inputs.push(input);
        Ok(fd)
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
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
        if self
            .retained_count()
            .saturating_add(self.0.input_slots.get())
            >= MAX_RETAINED_PROCESSES
        {
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
        let mut inputs = Vec::new();
        let mut fds = Vec::new();
        fds.try_reserve_exact(request.fds.iter().count())
            .map_err(|_| ProcessError::ProcessLimit)?;
        for (&child, endpoint) in request.fds.iter() {
            fds.push(Binding {
                child,
                parent: self.input_binding(endpoint, &mut inputs)?,
            });
        }
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
        self.0
            .inputs
            .borrow_mut()
            .try_reserve_exact(inputs.len())
            .map_err(|_| ProcessError::ProcessLimit)?;
        for input in self.0.inputs.borrow_mut().iter_mut() {
            let used = request.fds.iter().any(|(_, endpoint)| {
                endpoint
                    .host_owner()
                    .is_some_and(|owner| owner.ptr_eq(&input.reader))
            });
            if used {
                input.reserve_user(request.group, self.retained_count())?;
            }
        }
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
        // Only a successful spawn starts writers. Failure before this point
        // drops unpolled futures and closes both pipe ends synchronously.
        // Cache the exported open description so later builtin/external reads
        // and aliases share the pipe's actual read position, not pump read-ahead.
        for input in inputs {
            input.source.export_buffer(&input.reader);
            let reader = input.reader.host_owner().expect("host input reader");
            let mut users = input.users;
            users.push(request.group);
            let pump = InputPump {
                cancel: input.cancel,
                join: self.0.executor.spawn(input.future),
                _slot: input.slot,
                reader,
                users,
            };
            self.0.inputs.borrow_mut().push(pump);
        }
        for input in self.0.inputs.borrow_mut().iter_mut() {
            let used = request.fds.iter().any(|(_, endpoint)| {
                endpoint
                    .host_owner()
                    .is_some_and(|owner| owner.ptr_eq(&input.reader))
            });
            if used && !input.users.contains(&request.group) {
                input.users.push(request.group);
            }
        }
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
                        runtime
                            .0
                            .inputs
                            .borrow_mut()
                            .retain(|input| !input.join.is_finished());
                        for input in runtime.0.inputs.borrow_mut().iter_mut() {
                            input.users.retain(|owner| *owner != group);
                        }
                        runtime.shutdown_io().await;
                        let children = runtime
                            .0
                            .children
                            .borrow()
                            .values()
                            .any(|child| child.group == group);
                        let jobs = runtime
                            .0
                            .groups
                            .borrow()
                            .get(&group)
                            .is_some_and(|group| !group.runtime_jobs.is_empty());
                        if children || jobs {
                            continue;
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
    fn shutdown_io(&self) -> LocalBoxFuture<'static, ()> {
        let runtime = self.clone();
        async move {
            loop {
                let input = {
                    let mut inputs = runtime.0.inputs.borrow_mut();
                    inputs
                        .iter()
                        .position(InputPump::unowned)
                        .map(|index| inputs.swap_remove(index))
                };
                let Some(input) = input else { break };
                input.cancel.cancel();
                let _ = input.join.clone().await;
            }
            runtime
                .0
                .inputs
                .borrow_mut()
                .retain(|input| !input.join.is_finished());
        }
        .boxed_local()
    }
}

#[cfg(test)]
mod tests;
