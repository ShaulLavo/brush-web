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
    inherited: RefCell<Vec<u32>>,
    next_fd: Cell<u32>,
    next_pid: Cell<u32>,
    children: RefCell<BTreeMap<u32, FakeChild>>,
    requests: RefCell<Vec<RuntimeSpawn>>,
    closed: RefCell<Vec<u32>>,
    polls: RefCell<Vec<(i32, Vec<Subscription>)>>,
    signals: RefCell<Vec<(bool, u32, i32)>>,
    held_jobs: RefCell<BTreeSet<u32>>,
    reaped_jobs: RefCell<Vec<u32>>,
    kill_job_errors: RefCell<BTreeMap<u32, i32>>,
    wait_job_errors: RefCell<BTreeMap<u32, i32>>,
    spawn_errors: RefCell<BTreeSet<String>>,
    interrupt: Cell<i32>,
    interrupt_after: Cell<Option<usize>>,
    consumed_interrupts: Cell<usize>,
    parse_gate: Cancel,
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
            inherited: RefCell::new(vec![0, 1, 2]),
            next_fd: Cell::new(10),
            next_pid: Cell::new(100),
            children: RefCell::new(BTreeMap::new()),
            requests: RefCell::new(Vec::new()),
            closed: RefCell::new(Vec::new()),
            polls: RefCell::new(Vec::new()),
            signals: RefCell::new(Vec::new()),
            held_jobs: RefCell::new(BTreeSet::new()),
            reaped_jobs: RefCell::new(Vec::new()),
            kill_job_errors: RefCell::new(BTreeMap::new()),
            wait_job_errors: RefCell::new(BTreeMap::new()),
            spawn_errors: RefCell::new(BTreeSet::new()),
            interrupt: Cell::new(0),
            interrupt_after: Cell::new(None),
            consumed_interrupts: Cell::new(0),
            parse_gate: Cancel::new(),
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
    fn inherited_fds(&self) -> Vec<u32> {
        self.inherited.borrow().clone()
    }
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32> {
        if self.spawn_errors.borrow().contains(&request.executable) {
            return Err(44);
        }
        // The real runtime seals a job when its pending membership reaches zero,
        // even before wait_job reaps it. Do not hide illegal sequential joins.
        if request.job > 0 {
            let job = request.job as u32;
            if self.reaped_jobs.borrow().contains(&job)
                || !(self.held_jobs.borrow().contains(&job)
                    || self
                        .children
                        .borrow()
                        .values()
                        .any(|child| child.job == job && child.status.get().is_none()))
            {
                return Err(12);
            }
        }
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
        let parse_gate = self.parse_gate.clone();
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
                    "runtime-cat" => {
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
                    "take-one" => {
                        let mut byte = [0];
                        let count = fds
                            .get(0)
                            .ok_or(1)?
                            .read_cancelled(&mut byte, &cancel)
                            .await
                            .map_err(|_| 1)?;
                        output
                            .write_all(&byte[..count], &cancel)
                            .await
                            .map_err(|_| 1)?;
                    }
                    "sleep" => futures::future::pending::<()>().await,
                    "parse-gate" => parse_gate.cancelled().await,
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
        if self.reaped_jobs.borrow().contains(&job) {
            return Err(12);
        }
        if let Some(&errno) = self.wait_job_errors.borrow().get(&job) {
            return Err(errno);
        }
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
        if let Some(&errno) = self.kill_job_errors.borrow().get(&job) {
            return Err(errno);
        }
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
    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32> {
        self.fs
            .mkdir(path, allow_existing)
            .map_err(|error| match error {
                IoError::AlreadyExists => 20,
                IoError::NotDirectory => 54,
                _ => 44,
            })
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
        if let Some(remaining) = self.interrupt_after.get() {
            self.interrupt_after.set(remaining.checked_sub(1));
            if remaining == 1 {
                self.interrupt_after.set(None);
                self.interrupt.set(2);
            }
        }
        let signal = self.interrupt.replace(0);
        if signal == 2 {
            self.consumed_interrupts
                .set(self.consumed_interrupts.get() + 1);
        }
        signal
    }
}
fn setup() -> (Executor, Rc<Fake>, Runtime) {
    let executor = Executor::new();
    let fake = Fake::new(executor.clone());
    let runtime = Runtime::new(fake.clone(), executor.clone());
    (executor, fake, runtime)
}
fn runtime_session(executor: &Executor, runtime: &Runtime) -> Rc<Session> {
    let session = Rc::new(Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    ));
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    session
}
fn shutdown_session(executor: &Executor, runtime: &Runtime, fake: &Fake, session: Rc<Session>) {
    finish(
        executor,
        runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.inputs.borrow().is_empty());
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(runtime.0.waiters.borrow().is_empty());
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    assert_eq!(executor.drive(64).pending, 0);
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
fn groups_aggregate_fresh_jobs_and_background_does_not_join_foreground() {
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
    assert_eq!(requests[1].job, 0);
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
        // `cat` is an engine builtin. Use a distinct fake executable so these
        // stages really cross ProcessHost; retain a builtin consumer as well.
        .start("printf first | runtime-cat | runtime-cat | cat > /result; runtime-cat < /result 3>&1; emit | runtime-cat | runtime-cat")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"first".to_vec();
    for _ in 0..64 {
        expected.extend_from_slice(b"runtime bytes\n");
    }
    assert_eq!(fake.output.bytes(), expected);
    let requests = fake.requests.borrow();
    assert_eq!(requests.len(), 6);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.executable == "runtime-cat")
            .count(),
        5
    );
    let inherited_extra = requests
        .iter()
        .find(|request| request.fds.iter().any(|binding| binding.child == 3))
        .unwrap();
    assert_eq!(
        inherited_extra
            .fds
            .iter()
            .find(|binding| binding.child == 3)
            .unwrap()
            .parent,
        inherited_extra
            .fds
            .iter()
            .find(|binding| binding.child == 1)
            .unwrap()
            .parent
    );
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

fn drive_until_spawn(executor: &Executor, runtime: &Runtime, fake: &Fake, count: usize) {
    for _ in 0..1000 {
        executor.drive(64);
        if fake.requests.borrow().len() >= count {
            return;
        }
        runtime.poll(0).unwrap();
    }
    panic!("expected {count} runtime children");
}

fn interrupt_during_isolated_eval_parse(executor: &Executor, runtime: &Runtime, fake: &Fake) {
    fake.parse_gate.cancel();
    executor.drive(64);
    runtime.poll(0).unwrap();
    // Re-arm waiting runtime children once, then make no further reactor turns.
    // The foreground wait can sample once; joining the background eval checks
    // only its own token. Further host probes therefore run inside its parser.
    fake.interrupt_after.set(Some(16));
    for _ in 0..2000 {
        executor.drive(64);
        if fake.consumed_interrupts.get() != 0 {
            assert_eq!(fake.consumed_interrupts.get(), 1);
            assert_eq!(fake.interrupt.get(), 0, "the ABI event is consuming");
            return;
        }
    }
    panic!("the synchronous eval parser did not consume the injected ABI event");
}

#[test]
fn background_eval_parser_routes_consuming_interrupt_to_the_current_foreground() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .variables
        .insert("source".into(), ":; ".repeat(32));
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("{ parse-gate; eval \"$source\"; sleep; } &")
                .unwrap(),
        ),
        0,
    );
    drive_until_spawn(&executor, &runtime, &fake, 1);
    let foreground = session.start("sleep").unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 2);
    let foreground_pid = fake.next_pid.get() - 1;
    let foreground_job = fake.job_of(foreground_pid).unwrap();
    assert!(!foreground.is_finished());
    assert_eq!(fake.wait(foreground_pid), Err(AGAIN));
    interrupt_during_isolated_eval_parse(&executor, &runtime, &fake);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(fake.wait(foreground_pid), Ok(130));
    drive_until_spawn(&executor, &runtime, &fake, 3);
    assert_eq!(session.background_jobs(), 1);
    assert_eq!(runtime.retained_count(), 1);
    let background_pid = fake.next_pid.get() - 1;
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    assert_eq!(fake.requests.borrow().last().unwrap().job, -1);
    assert!(!fake.signals.borrow().is_empty());
    assert!(fake.signals.borrow().iter().all(|&(group, id, signal)| {
        signal == 2
            && id
                == if group {
                    foreground_job
                } else {
                    foreground_pid
                }
    }));
    assert_eq!(finish(&executor, &runtime, session.start(":").unwrap()), 0,);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn nested_capture_eval_parser_interrupts_foreground_without_stopping_background() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .variables
        .insert("source".into(), ":; ".repeat(32));
    assert_eq!(
        finish(&executor, &runtime, session.start("sleep &").unwrap()),
        0,
    );
    drive_until_spawn(&executor, &runtime, &fake, 1);
    let background_pid = fake.next_pid.get() - 1;
    let foreground = session
        .start(r#"x=$(x=$(parse-gate; eval "$source"); echo "$x"); echo forbidden"#)
        .unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 2);
    let capture_pid = fake.next_pid.get() - 1;
    let capture_job = fake.job_of(capture_pid).unwrap();
    interrupt_during_isolated_eval_parse(&executor, &runtime, &fake);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(session.background_jobs(), 1);
    assert_eq!(runtime.retained_count(), 1);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    assert!(fake.output.bytes().is_empty());
    assert!(fake.signals.borrow().iter().all(|&(group, id, signal)| {
        signal == 2 && id == if group { capture_job } else { capture_pid }
    }));
    assert_eq!(finish(&executor, &runtime, session.start(":").unwrap()), 0,);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    shutdown_session(&executor, &runtime, &fake, session);
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
fn external_after_builtin_pipeline_starts_a_fresh_runtime_job() {
    let (executor, fake, runtime) = setup();
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    let job = session
        .start("emit | cat > /complete; runtime-cat < /complete")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"runtime bytes\n".repeat(64));
    assert_eq!(fake.requests.borrow().len(), 2);
    assert!(
        fake.requests
            .borrow()
            .iter()
            .all(|request| request.job == 0)
    );
    assert_eq!(fake.reaped_jobs.borrow().len(), 2);
    assert!(runtime.0.groups.borrow().is_empty());
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}

#[test]
fn background_brace_sequence_kill_and_wait_cover_later_runtime_members() {
    let (executor, fake, runtime) = setup();
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    let job = session
        .start("{ emit; sleep; echo BAD_AFTER_JOB_KILL; } &")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    for _ in 0..100 {
        executor.drive(64);
        if fake.requests.borrow().len() == 2 {
            break;
        }
        runtime.poll(0).unwrap();
    }
    assert_eq!(
        fake.requests.borrow().len(),
        2,
        "later member must really spawn"
    );
    assert!(
        fake.requests
            .borrow()
            .iter()
            .all(|request| request.job == -1)
    );
    assert_eq!(
        fake.children
            .borrow()
            .values()
            .map(|child| child.status.get())
            .collect::<Vec<_>>(),
        vec![Some(0), None],
        "first member exited before persistent later member started"
    );
    let members: Vec<_> = fake
        .children
        .borrow()
        .iter()
        .map(|(&pid, child)| (pid, child.job))
        .collect();
    let job = session
        .start("kill %1; wait %1; echo MEMBERS_REAPED")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"runtime bytes\n".repeat(64);
    expected.extend_from_slice(b"MEMBERS_REAPED\n");
    assert_eq!(
        fake.output.bytes(),
        expected,
        "no command after the killed member runs"
    );
    assert_eq!(session.background_jobs(), 0);
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(*fake.reaped_jobs.borrow(), vec![members[0].1, members[1].1]);
    // Explicit TERM remains TERM for the direct child and descendant teardown,
    // including the job whose direct child had already exited naturally.
    assert_eq!(
        *fake.signals.borrow(),
        vec![
            (true, members[0].1, 15),
            (true, members[1].1, 15),
            (false, members[1].0, 15),
            (true, members[0].1, 15),
            (true, members[1].1, 15),
        ]
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}

#[test]
fn group_wait_includes_later_children_and_every_descendant_confirmation() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    assert_eq!(
        finish(&executor, &runtime, executor.spawn(runtime.wait(first))),
        Ok(0)
    );
    let first_job = fake.job_of(first as u32).unwrap();
    let mut sealed = fake.requests.borrow()[0].clone();
    sealed.job = first_job as i32;
    assert_eq!(
        fake.spawn(&sealed),
        Err(12),
        "completed jobs cannot be joined"
    );

    fake.held_jobs.borrow_mut().insert(first_job);
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    assert!(!done.is_finished());
    let later = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    assert_ne!(first_job, later_job);
    fake.held_jobs.borrow_mut().insert(later_job);
    executor.drive(64);
    fake.held_jobs.borrow_mut().remove(&first_job);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert!(
        !done.is_finished(),
        "later job's descendants still own the group"
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![first_job]);
    fake.held_jobs.borrow_mut().remove(&later_job);
    runtime.poll(0).unwrap();
    assert_eq!(finish(&executor, &runtime, done), Ok(()));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![first_job, later_job]);
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
}

#[test]
fn killing_dynamic_background_group_rejects_new_members_and_isolates_siblings() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_background_group();
    let foreground = runtime.allocate_group();
    let sibling = runtime.allocate_background_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    assert_eq!(
        finish(&executor, &runtime, executor.spawn(runtime.wait(first))),
        Ok(0)
    );
    let first_job = fake.job_of(first as u32).unwrap();
    fake.held_jobs.borrow_mut().insert(first_job);
    let later = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    let foreground_pid = runtime
        .spawn(request(&runtime, "sleep", foreground))
        .unwrap();
    let sibling_pid = runtime.spawn(request(&runtime, "sleep", sibling)).unwrap();
    runtime.kill_group(group, 15).unwrap();
    assert_eq!(
        runtime.spawn(request(&runtime, "exit", group)),
        Err(ProcessError::GroupClosed(group))
    );
    assert_eq!(
        *fake.signals.borrow(),
        vec![(true, first_job, 15), (true, later_job, 15)]
    );
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert!(!done.is_finished());
    assert_eq!(fake.wait(foreground_pid as u32), Err(AGAIN));
    assert_eq!(fake.wait(sibling_pid as u32), Err(AGAIN));
    fake.held_jobs.borrow_mut().remove(&first_job);
    runtime.poll(0).unwrap();
    assert_eq!(finish(&executor, &runtime, done), Ok(()));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![first_job, later_job]);
    for group in [foreground, sibling] {
        runtime.kill_group(group, 9).unwrap();
        assert_eq!(
            finish(
                &executor,
                &runtime,
                executor.spawn(runtime.wait_group(group))
            ),
            Ok(())
        );
    }
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(
        fake.requests.borrow()[..2]
            .iter()
            .all(|request| request.job == -1)
    );
}

#[test]
fn group_fanout_continues_after_errors_and_invalid_signal_does_not_close_admission() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    assert_eq!(
        runtime.kill_group(group, 0),
        Err(ProcessError::InvalidSignal)
    );
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    assert_eq!(
        finish(&executor, &runtime, executor.spawn(runtime.wait(first))),
        Ok(0)
    );
    let first_job = fake.job_of(first as u32).unwrap();
    let later = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    fake.kill_job_errors.borrow_mut().insert(first_job, 71);
    assert_eq!(
        runtime.kill_group(group, 15),
        Err(ProcessError::Runtime(71))
    );
    assert_eq!(
        *fake.signals.borrow(),
        vec![(true, first_job, 15), (true, later_job, 15)]
    );
    fake.wait_job_errors.borrow_mut().insert(first_job, 63);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group))
        ),
        Err(ProcessError::Runtime(63))
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job]);
    assert!(
        runtime.0.groups.borrow().contains_key(&group),
        "failed confirmation keeps cleanup ownership"
    );
    fake.wait_job_errors.borrow_mut().remove(&first_job);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group))
        ),
        Ok(())
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job, first_job]);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(runtime.retained_count(), 0);
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

#[test]
fn runtime_mkdir_uses_shared_filesystem_and_grep_reads_created_directory() {
    let (executor, fake, runtime) = setup();
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    let job = session.start("mkdir -p nested/deep; mkdir -p nested/deep; cd nested/deep; printf 'tick\\nother\\n' > result; grep -n tick result").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"1:tick\n");
    assert_eq!(
        fake.fs.read_file("/home/guest/nested/deep/result").unwrap(),
        b"tick\nother\n"
    );
    let job = session.start("mkdir -p result").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 1);
    assert!(fake.requests.borrow().is_empty()); // Neither utility spawned a guest.
}

#[test]
fn inherited_shell_bootstrap_preserves_extra_and_sparse_logical_bindings() {
    let (executor, fake, runtime) = setup();
    fake.fs
        .write_file("/descriptor-data", b"shared-offset\nremaining")
        .unwrap();
    let file = fake
        .fs
        .open("/descriptor-data", &OpenOptions::default())
        .unwrap();
    let stdout = fake.fds.borrow().get(&1).unwrap().clone();
    fake.fds.borrow_mut().extend([
        (3, stdout),
        (4, file),
        (1_000_000, Endpoint::null()),
        (i32::MAX as u32, Endpoint::null()),
    ]);
    *fake.inherited.borrow_mut() = vec![0, 1, 2, 3, 4, 1_000_000, i32::MAX as u32];
    // A private physical descriptor must never become an inherited logical binding.
    let private = fake.fd(Endpoint::null());
    let fds = runtime.stdio().unwrap();
    assert_eq!(
        fds.iter().map(|(&fd, _)| fd).collect::<Vec<_>>(),
        *fake.inherited.borrow()
    );
    assert!(fds.get(private).is_none());
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(fds).unwrap();
    let job = session
        .start("read -r -u 4 value; printf 'DIRECT_FD3:%s\\n' \"$value\" >&3")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"DIRECT_FD3:shared-offset\n");
    // The inherited file was duplicated, not reopened: its original offset moved too.
    let mut remaining = [0; 9];
    assert_eq!(fake.read(4, &mut remaining), Ok(remaining.len()));
    assert_eq!(&remaining, b"remaining");
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, private, 1_000_000, i32::MAX as u32]
    );
}

#[test]
fn empty_inherited_shell_bindings_do_not_recreate_stdio() {
    let (_executor, fake, runtime) = setup();
    fake.inherited.borrow_mut().clear();
    let fds = runtime.stdio().unwrap();
    assert_eq!(fds.iter().count(), 0);
    assert_eq!(fake.fds.borrow().len(), 3);
}

#[test]
fn noninteractive_shell_preserves_closed_stdio_and_requires_only_used_descriptors() {
    for (inherited, source, status, expected) in [
        (vec![0, 1], "printf CLOSED_STDERR_OK", 0, "CLOSED_STDERR_OK"),
        (vec![1, 2], "printf CLOSED_STDIN_OK", 0, "CLOSED_STDIN_OK"),
        (vec![0, 2], ":", 0, ""),
        (vec![0, 2], "printf inaccessible", 1, ""),
        (vec![], ":", 0, ""),
        (vec![], "printf inaccessible", 1, ""),
    ] {
        let (executor, fake, runtime) = setup();
        *fake.inherited.borrow_mut() = inherited.clone();
        fake.fds.borrow_mut().retain(|fd, _| inherited.contains(fd));
        let session = Session::new(
            executor.clone(),
            Rc::new(runtime.clone()),
            Rc::new(runtime.clone()),
            Limits::default(),
        );
        let fds = runtime.stdio().unwrap();
        assert_eq!(fds.iter().map(|(&fd, _)| fd).collect::<Vec<_>>(), inherited);
        session.set_descriptors(fds).unwrap();
        let job = session.start(source).unwrap();
        assert_eq!(finish(&executor, &runtime, job), status, "{source}");
        assert_eq!(fake.output.bytes(), expected.as_bytes(), "{source}");
        finish(
            &executor,
            &runtime,
            executor.spawn(async move { session.shutdown().await }),
        );
        assert_eq!(
            fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
            inherited
        );
    }
}

#[test]
fn substitution_descriptors_cross_the_actual_runtime_spawn_boundary() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let job = session.start("v=$(emit); printf '%s' \"$v\"; runtime-cat < <(printf streamed); pid=$!; wait \"$pid\"").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"runtime bytes\n".repeat(64);
    expected.pop();
    expected.extend_from_slice(b"streamed");
    assert_eq!(fake.output.bytes(), expected);
    let requests = fake.requests.borrow();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.executable.as_str())
            .collect::<Vec<_>>(),
        ["emit", "runtime-cat"]
    );
    let consumer = &requests[1];
    let stdin = consumer
        .fds
        .iter()
        .find(|binding| binding.child == 0)
        .unwrap()
        .parent;
    assert_eq!(
        consumer
            .fds
            .iter()
            .find(|binding| binding.child == 63)
            .unwrap()
            .parent,
        stdin
    );
    assert!(
        requests
            .iter()
            .all(|request| request.fds.iter().all(|binding| binding.parent >= 10))
    );
    drop(requests);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(fake.reaped_jobs.borrow().len(), 2);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn large_heredoc_inputs_stream_after_spawn_and_aliases_share_read_position() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let payload = "x".repeat(io::PIPE_CAPACITY * 3);
    session
        .state()
        .borrow_mut()
        .variables
        .insert("payload".into(), payload.clone());
    let job = session.start("runtime-cat <<< \"$payload\"; runtime-cat <<EOF\n$payload\nEOF\nf() { take-one; runtime-cat; }; f 3<<<abcd 0<&3").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let expected = format!("{payload}\n{payload}\nabcd\n");
    assert_eq!(fake.output.bytes(), expected.as_bytes());
    assert_eq!(fake.requests.borrow().len(), 4);
    let requests = fake.requests.borrow();
    let first = &requests[2];
    let next = &requests[3];
    let fd = first
        .fds
        .iter()
        .find(|binding| binding.child == 0)
        .unwrap()
        .parent;
    assert_eq!(
        first
            .fds
            .iter()
            .find(|binding| binding.child == 3)
            .unwrap()
            .parent,
        fd
    );
    assert_eq!(
        next.fds
            .iter()
            .find(|binding| binding.child == 0)
            .unwrap()
            .parent,
        fd
    );
    drop(requests);
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn failed_spawn_and_redirect_never_leave_a_buffered_input_writer() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .variables
        .insert("payload".into(), "x".repeat(io::PIPE_CAPACITY * 3));
    let baseline: Vec<_> = fake.fds.borrow().keys().copied().collect();
    let next_fd = fake.next_fd.get();
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("runtime-cat <<< \"$payload\" < /missing")
                .unwrap()
        ),
        1
    );
    assert_eq!(
        fake.next_fd.get(),
        next_fd,
        "no pipe writer starts during redirection preparation"
    );
    fake.spawn_errors.borrow_mut().insert("runtime-cat".into());
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("runtime-cat <<< \"$payload\"").unwrap()
        ),
        127
    );
    assert!(fake.requests.borrow().is_empty());
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        baseline
    );
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(runtime.0.inputs.borrow().is_empty());
    assert_eq!(executor.drive(64).pending, 0);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn buffered_input_admission_is_bounded_and_released_after_cancellation() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_background_group();
    let mut guard = ProcessGroup::new(Rc::new(runtime.clone()), group);
    let mut admitted = 0;
    for _ in 0..32 {
        let mut child = request(&runtime, "sleep", group);
        child
            .fds
            .insert(0, Endpoint::bytes(vec![b'x'; 1024 * 1024]));
        match runtime.spawn(child) {
            Ok(_) => admitted += 1,
            Err(error) => {
                assert_eq!(error, ProcessError::ProcessLimit);
                break;
            }
        }
    }
    assert!(admitted > 0 && admitted < 32);
    assert_eq!(fake.requests.borrow().len(), admitted);
    assert!(runtime.0.input_slots.get() > 0);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(async move { guard.terminate(15).await })
        ),
        Ok(())
    );
    assert!(
        fake.children
            .borrow()
            .values()
            .all(|child| child.status.get() == Some(143))
    );
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.inputs.borrow().is_empty());
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert_eq!(runtime.retained_count(), 0);
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    assert_eq!(executor.drive(64).pending, 0);
}

#[test]
fn shutting_down_one_session_preserves_a_peer_buffered_reader() {
    let (executor, fake, runtime) = setup();
    let first = runtime_session(&executor, &runtime);
    let second = runtime_session(&executor, &runtime);
    let payload = vec![b'x'; io::PIPE_CAPACITY * 3];
    let input = Endpoint::bytes(payload.clone());
    let mut first_fds = runtime.stdio().unwrap();
    first_fds.insert(0, input.clone());
    first.set_descriptors(first_fds).unwrap();
    let mut second_fds = runtime.stdio().unwrap();
    second_fds.insert(0, input.clone());
    second.set_descriptors(second_fds).unwrap();
    drop(input);
    assert_eq!(
        finish(&executor, &runtime, first.start("take-one").unwrap()),
        0
    );
    assert!(
        runtime.0.input_slots.get() > 0,
        "the rest exceeds one pipe and still needs its writer"
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { first.shutdown().await }),
    );
    assert!(
        runtime.0.input_slots.get() > 0,
        "a peer still owns the open reader"
    );
    assert_eq!(
        finish(&executor, &runtime, second.start("runtime-cat").unwrap()),
        0
    );
    assert_eq!(fake.output.bytes(), payload);
    assert!(fake.signals.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, second);
}

#[test]
fn builtin_only_capture_and_process_substitution_groups_return_to_baseline() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let baseline: Vec<_> = fake.fds.borrow().keys().copied().collect();
    for _ in 0..64 {
        let job = session
            .start("v=$(printf x); : <(true); wait \"$!\"")
            .unwrap();
        assert_eq!(finish(&executor, &runtime, job), 0);
        assert!(runtime.0.groups.borrow().is_empty());
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(
            fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
            baseline
        );
    }
    assert!(fake.requests.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn capture_eof_can_precede_group_descendant_reaping_but_keeps_a_cleanup_owner() {
    for cancel in [false, true] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        let command = session.start("v=$(emit); echo CAPTURED").unwrap();
        for _ in 0..1000 {
            executor.drive(1);
            if !fake.requests.borrow().is_empty() {
                break;
            }
            runtime.poll(0).unwrap();
        }
        let job = fake
            .children
            .borrow()
            .values()
            .next()
            .expect("external capture actually spawned")
            .job;
        fake.held_jobs.borrow_mut().insert(job);
        assert_eq!(finish(&executor, &runtime, command), 0);
        assert_eq!(fake.output.bytes(), b"CAPTURED\n");
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(
            runtime.0.groups.borrow().len(),
            1,
            "the outliving descendant still has an owner"
        );
        if cancel {
            let closing = session.clone();
            let shutdown = executor.spawn(async move { closing.shutdown().await });
            executor.drive(128);
            runtime.poll(0).unwrap();
            executor.drive(128);
            assert!(fake.signals.borrow().contains(&(true, job, 2)));
            assert!(
                !shutdown.is_finished(),
                "delivery is not descendant exit confirmation"
            );
            fake.held_jobs.borrow_mut().remove(&job);
            runtime.poll(0).unwrap();
            finish(&executor, &runtime, shutdown);
        } else {
            assert!(fake.signals.borrow().is_empty());
            fake.held_jobs.borrow_mut().remove(&job);
            for _ in 0..100 {
                runtime.poll(0).unwrap();
                executor.drive(64);
                if runtime.0.groups.borrow().is_empty() {
                    break;
                }
            }
        }
        assert!(fake.reaped_jobs.borrow().contains(&job));
        assert!(runtime.0.groups.borrow().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn requested_signals_reach_children_substitutions_and_all_group_cleanup() {
    for (launch, selector) in [
        ("sleep &", "%1"),
        ("v=$(sleep) &", "%1"),
        (": <(sleep); pid=$!", "\"$pid\""),
    ] {
        runtime_signal_forms(launch, selector);
    }
}

fn runtime_signal_forms(launch: &str, selector: &str) {
    for (form, signal, status) in [
        ("", 15, 143),
        ("-s TERM", 15, 143),
        ("-15", 15, 143),
        ("-s INT", 2, 130),
        ("-2", 2, 130),
    ] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(&executor, &runtime, session.start(launch).unwrap()),
            0
        );
        for _ in 0..1000 {
            executor.drive(64);
            runtime.poll(0).unwrap();
            if !fake.requests.borrow().is_empty() {
                break;
            }
        }
        assert_eq!(
            fake.requests.borrow().len(),
            1,
            "the real runtime child must start: {launch}"
        );
        let (pid, group) = fake
            .children
            .borrow()
            .iter()
            .map(|(&pid, child)| (pid, child.job))
            .next()
            .unwrap();
        let source = format!("kill {form} {selector}; wait {selector}");
        assert_eq!(
            finish(&executor, &runtime, session.start(&source).unwrap()),
            status,
            "{launch}: {source}"
        );
        let signals = fake.signals.borrow();
        assert!(
            signals.contains(&(false, pid, signal)),
            "direct child delivery: {launch}: {source}"
        );
        assert!(
            signals.contains(&(true, group, signal)),
            "group delivery: {launch}: {source}"
        );
        assert!(
            signals.iter().all(|(_, _, actual)| *actual == signal),
            "{launch}: {source}"
        );
        drop(signals);
        assert!(runtime.0.groups.borrow().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn interrupt_and_shutdown_drain_live_capture_and_blocked_input_writers() {
    for source in ["v=$(sleep)", "sleep <<< \"$payload\""] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        session
            .state()
            .borrow_mut()
            .variables
            .insert("payload".into(), "x".repeat(io::PIPE_CAPACITY * 3));
        let job = session.start(source).unwrap();
        for _ in 0..1000 {
            executor.drive(64);
            runtime.poll(0).unwrap();
            if !fake.requests.borrow().is_empty() {
                break;
            }
        }
        assert_eq!(fake.requests.borrow().len(), 1);
        assert!(!job.is_finished());
        session.interrupt();
        assert_eq!(finish(&executor, &runtime, job), 130);
        assert!(
            fake.signals
                .borrow()
                .iter()
                .all(|(_, _, signal)| *signal == 2)
        );
        shutdown_session(&executor, &runtime, &fake, session);
    }
}
