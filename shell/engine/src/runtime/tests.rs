use super::*;
use crate::{
    Limits, Session,
    executor::Cancel,
    io::{self, Capture, MemoryFs},
    process::ProcessGroup,
};
use std::collections::BTreeSet;

struct FakeChild {
    job: u32,
    status: Rc<Cell<Option<i32>>>,
    cancel: Cancel,
    signal: Rc<Cell<i32>>,
}
struct Fake {
    executor: Executor,
    fds: RefCell<BTreeMap<u32, Endpoint>>,
    next_fd: Cell<u32>,
    next_pid: Cell<u32>,
    children: RefCell<BTreeMap<u32, FakeChild>>,
    requests: RefCell<Vec<RuntimeSpawn>>,
    closed: RefCell<Vec<u32>>,
    polls: RefCell<Vec<(i32, Vec<Subscription>)>>,
    signals: RefCell<Vec<(bool, u32, i32)>>,
    held_jobs: RefCell<BTreeSet<u32>>,
    reaped_jobs: RefCell<Vec<u32>>,
    interrupt: Cell<i32>,
    fs: MemoryFs,
    output: Capture,
}
impl Fake {
    fn new(executor: Executor) -> Rc<Self> {
        let (stdout, output) = io::capture(4 * 1024 * 1024);
        Rc::new(Self {
            executor,
            fds: RefCell::new(BTreeMap::from([
                (0, Endpoint::null()),
                (1, stdout),
                (2, Endpoint::null()),
            ])),
            next_fd: Cell::new(10),
            next_pid: Cell::new(100),
            children: RefCell::new(BTreeMap::new()),
            requests: RefCell::new(Vec::new()),
            closed: RefCell::new(Vec::new()),
            polls: RefCell::new(Vec::new()),
            signals: RefCell::new(Vec::new()),
            held_jobs: RefCell::new(BTreeSet::new()),
            reaped_jobs: RefCell::new(Vec::new()),
            interrupt: Cell::new(0),
            fs: MemoryFs::new(4 * 1024 * 1024),
            output,
        })
    }
    fn fd(&self, endpoint: Endpoint) -> u32 {
        let fd = self.next_fd.get();
        self.next_fd.set(fd + 1);
        self.fds.borrow_mut().insert(fd, endpoint);
        fd
    }
}
impl Abi for Fake {
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32> {
        let pid = self.next_pid.get();
        self.next_pid.set(pid + 1);
        let job = if request.job <= 0 {
            pid + 900
        } else {
            request.job as u32
        };
        let mut fds = FdTable::default();
        for binding in &request.fds {
            fds.insert(
                binding.child,
                self.fds.borrow().get(&binding.parent).cloned().ok_or(8)?,
            );
        }
        self.requests.borrow_mut().push(request.clone());
        let status = Rc::new(Cell::new(None));
        let cancel = Cancel::new();
        let signal = Rc::new(Cell::new(15));
        self.children.borrow_mut().insert(
            pid,
            FakeChild {
                job,
                status: status.clone(),
                cancel: cancel.clone(),
                signal: signal.clone(),
            },
        );
        let argv = request.argv.clone();
        self.executor.spawn(async move {
            let run = async {
                let output = fds.get(1).ok_or(1)?;
                match argv[0].as_str() {
                    "emit" => {
                        for _ in 0..64 {
                            output
                                .write_all(b"runtime bytes\n", &cancel)
                                .await
                                .map_err(|_| 1)?;
                        }
                    }
                    "cat" => {
                        let input = fds.get(0).ok_or(1)?;
                        let mut buffer = [0; 97];
                        loop {
                            let count = input
                                .read_cancelled(&mut buffer, &cancel)
                                .await
                                .map_err(|_| 1)?;
                            if count == 0 {
                                break;
                            }
                            output
                                .write_all(&buffer[..count], &cancel)
                                .await
                                .map_err(|_| 1)?;
                        }
                    }
                    "sleep" => futures::future::pending::<()>().await,
                    _ => {}
                }
                Ok::<i32, i32>(0)
            };
            let result = cancel.run(run).await;
            status.set(Some(match result {
                Ok(Ok(code)) | Ok(Err(code)) => code,
                Err(_) => 128 + signal.get(),
            }));
        });
        Ok(pid)
    }
    fn job_of(&self, pid: u32) -> Result<u32, i32> {
        self.children
            .borrow()
            .get(&pid)
            .map(|child| child.job)
            .ok_or(71)
    }
    fn wait(&self, pid: u32) -> Result<i32, i32> {
        self.children
            .borrow()
            .get(&pid)
            .ok_or(12)?
            .status
            .get()
            .ok_or(AGAIN)
    }
    fn wait_job(&self, job: u32) -> Result<i32, i32> {
        if self.held_jobs.borrow().contains(&job)
            || self
                .children
                .borrow()
                .values()
                .any(|child| child.job == job && child.status.get().is_none())
        {
            return Err(AGAIN);
        }
        self.reaped_jobs.borrow_mut().push(job);
        Ok(0)
    }
    fn kill(&self, pid: u32, signal: i32) -> Result<(), i32> {
        self.signals.borrow_mut().push((false, pid, signal));
        let children = self.children.borrow();
        let child = children.get(&pid).ok_or(71)?;
        child.signal.set(signal);
        child.cancel.cancel();
        Ok(())
    }
    fn kill_job(&self, job: u32, signal: i32) -> Result<(), i32> {
        self.signals.borrow_mut().push((true, job, signal));
        for child in self
            .children
            .borrow()
            .values()
            .filter(|child| child.job == job)
        {
            child.signal.set(signal);
            child.cancel.cancel();
        }
        Ok(())
    }
    fn pipe(&self) -> Result<(u32, u32), i32> {
        let (read, write) = io::pipe();
        Ok((self.fd(read), self.fd(write)))
    }
    fn dup(&self, fd: u32) -> Result<u32, i32> {
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        Ok(self.fd(endpoint))
    }
    fn close(&self, fd: u32) {
        self.closed.borrow_mut().push(fd);
        self.fds.borrow_mut().remove(&fd);
    }
    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32> {
        Ok(self.fd(self.fs.open(path, options).map_err(|_| 44)?))
    }
    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32> {
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        endpoint
            .read(output)
            .now_or_never()
            .ok_or(AGAIN)?
            .map_err(|error| if error == IoError::BrokenPipe { 64 } else { 8 })
    }
    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32> {
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        endpoint
            .write(input)
            .now_or_never()
            .ok_or(AGAIN)?
            .map_err(|error| if error == IoError::BrokenPipe { 64 } else { 8 })
    }
    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32> {
        self.polls
            .borrow_mut()
            .push((timeout, subscriptions.to_vec()));
        for (slot, sub) in output.iter_mut().zip(subscriptions) {
            *slot = PollEvent {
                userdata: sub.userdata,
                kind: sub.kind,
                flags: 0,
            };
        }
        Ok(subscriptions.len())
    }
    fn interrupted(&self) -> i32 {
        self.interrupt.replace(0)
    }
}
fn setup() -> (Executor, Rc<Fake>, Runtime) {
    let executor = Executor::new();
    let fake = Fake::new(executor.clone());
    let runtime = Runtime::new(fake.clone(), executor.clone());
    (executor, fake, runtime)
}
fn request(runtime: &Runtime, name: &str, group: GroupId) -> SpawnRequest {
    SpawnRequest {
        argv: vec![name.into()],
        env: BTreeMap::new(),
        cwd: "/home/guest".into(),
        fds: runtime.stdio().unwrap(),
        group,
        parent: None,
    }
}
fn finish<T: Clone + 'static>(
    executor: &Executor,
    runtime: &Runtime,
    job: crate::executor::JoinHandle<T>,
) -> T {
    for _ in 0..10_000 {
        executor.drive(64);
        if job.is_finished() {
            return job.now_or_never().unwrap();
        }
        runtime.poll(0).unwrap();
    }
    panic!("fake runtime failed to finish");
}
#[test]
fn exact_sixteen_byte_wire_records() {
    let sub = Subscription {
        kind: 2,
        id: 0x12345678,
        userdata: 0x1020304050607080,
    };
    assert_eq!(
        sub.encode(),
        [
            2, 0, 0, 0, 0x78, 0x56, 0x34, 0x12, 0x80, 0x70, 0x60, 0x50, 0x40, 0x30, 0x20, 0x10
        ]
    );
    assert_eq!(
        PollEvent::decode([
            0x80, 0x70, 0x60, 0x50, 0x40, 0x30, 0x20, 0x10, 2, 0, 0, 0, 1, 0, 0, 0
        ]),
        PollEvent {
            userdata: sub.userdata,
            kind: 2,
            flags: 1
        }
    );
}
#[test]
fn groups_map_lazily_and_background_does_not_join_foreground() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let background = runtime.allocate_background_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    runtime.spawn(request(&runtime, "exit", group)).unwrap();
    runtime
        .spawn(request(&runtime, "exit", background))
        .unwrap();
    let requests = fake.requests.borrow();
    assert_eq!(requests[0].job, 0);
    assert_eq!(requests[1].job, first as i32 + 900);
    assert_eq!(requests[2].job, -1);
    assert_ne!(group, first + 900);
    drop(requests);
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(group)),
    )
    .unwrap();
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(background)),
    )
    .unwrap();
    assert_eq!(runtime.retained_count(), 0);
}
#[test]
fn nonblocking_eagain_wait_registration_is_removed_when_cancelled() {
    let (executor, fake, runtime) = setup();
    let (input, output) = runtime.pipe().unwrap();
    let cancel = Cancel::new();
    let child_cancel = cancel.clone();
    let job = executor.spawn(async move {
        let mut byte = [0];
        input.read_cancelled(&mut byte, &child_cancel).await
    });
    executor.drive(64);
    assert!(!job.is_finished());
    assert_eq!(runtime.0.waiters.borrow().len(), 1);
    assert!(fake.polls.borrow().is_empty(), "task must not call poll");
    cancel.cancel();
    executor.drive(64);
    assert_eq!(job.now_or_never(), Some(Err(IoError::Cancelled)));
    assert!(runtime.0.waiters.borrow().is_empty());
    drop(output);
    assert_eq!(fake.closed.borrow().len(), 2);
}
#[test]
fn partial_writes_epipe_and_dup_lifetime() {
    let (executor, fake, runtime) = setup();
    let (input, output) = runtime.pipe().unwrap();
    let duplicate = output.clone();
    let fd = output.runtime_fd().unwrap();
    drop(output);
    assert!(!fake.closed.borrow().contains(&fd));
    let data = vec![1; io::PIPE_CAPACITY + 7];
    assert_eq!(
        duplicate.write(&data).now_or_never(),
        Some(Ok(io::PIPE_CAPACITY))
    );
    let writer = duplicate.clone();
    let job = executor.spawn(async move { writer.write(b"blocked").await });
    executor.drive(64);
    assert!(!job.is_finished());
    drop(input);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert_eq!(job.now_or_never(), Some(Err(IoError::BrokenPipe)));
    drop(duplicate);
    assert!(fake.closed.borrow().contains(&fd));
}
#[test]
fn runtime_pipeline_builtins_external_and_fs_share_descriptor_namespace() {
    let (executor, fake, runtime) = setup();
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    let job = session
        .start("printf first | cat | cat > /result; cat < /result; emit | cat | cat")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"first".to_vec();
    for _ in 0..64 {
        expected.extend_from_slice(b"runtime bytes\n");
    }
    assert_eq!(fake.output.bytes(), expected);
    let requests = fake.requests.borrow();
    assert_eq!(requests.len(), 6);
    assert!(
        requests
            .iter()
            .all(|request| request.fds.iter().all(|binding| binding.parent >= 10))
    );
    assert!(
        fake.polls
            .borrow()
            .iter()
            .flat_map(|(_, subs)| subs)
            .any(|sub| sub.kind == 2)
    );
    drop(requests);
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}
#[test]
fn background_persists_and_foreground_interrupt_is_checked_in_budget() {
    let (executor, fake, runtime) = setup();
    let session = Rc::new(Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    ));
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    assert_eq!(
        finish(&executor, &runtime, session.start("sleep &").unwrap()),
        0
    );
    assert_eq!(session.background_jobs(), 1);
    let foreground = session.start("while true; do :; done").unwrap();
    executor.drive(32);
    fake.interrupt.set(2);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(session.background_jobs(), 1);
    assert!(
        fake.signals.borrow().is_empty(),
        "builtin foreground must not signal background job"
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(runtime.retained_count(), 0);
    assert!(fake.signals.borrow().iter().any(|(job, _, _)| *job));
}
#[test]
fn wait_group_observes_descendants_and_abandoned_group_confirms_cleanup() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let job = pid as u32 + 900;
    fake.held_jobs.borrow_mut().insert(job);
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert!(!done.is_finished());
    assert!(
        runtime
            .0
            .waiters
            .borrow()
            .values()
            .any(|waiter| waiter.kind == 4)
    );
    fake.held_jobs.borrow_mut().remove(&job);
    runtime.poll(0).unwrap();
    finish(&executor, &runtime, done).unwrap();
    assert!(fake.reaped_jobs.borrow().contains(&job));
    let group = runtime.allocate_group();
    runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    drop(ProcessGroup::new(Rc::new(runtime.clone()), group));
    for _ in 0..10 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
}

#[test]
fn sigint_registration_calls_runtime_with_handle_not_ignore() {
    // Exercise the same registration path WasiAbi passes to proc_signal, not a
    // mock preconfigured with handled signals. Pin the numeric wire arguments.
    let mut registered = None;
    assert_eq!(
        register_interrupt_handler(|signal, disposition| {
            registered = Some((signal, disposition));
            0
        }),
        Ok(())
    );
    assert_eq!(registered, Some((2, 2)));
    assert_eq!(SIGNAL_DISPOSITION_HANDLE, 2);
    assert_eq!(
        register_interrupt_handler(|_, disposition| {
            assert_ne!(disposition, 1, "mode 1 silently ignores SIGINT");
            -28
        }),
        Err(28)
    );
}
