//! Original task-oriented interpreter for the engine gate, not a Bashkit
//! interpreter fork. Unsupported syntax returns status 2 rather than guessing.
use crate::{
    arithmetic, builtins,
    executor::{Budget, Cancel, Executor, JoinHandle, yield_now},
    expand,
    io::{self, FdTable, FileSystem, OpenOptions},
    process::{GroupId, ProcessGroup, ProcessHost, SpawnRequest},
    state::{FunctionFrame, PrefixFrame, SharedState, State, StoredFunction, absolute},
};
use futures::future::join_all;
use shell_parser::parser::*;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};

mod eval;
pub(crate) use eval::RetainedStorage;

#[derive(Clone, Debug)]
pub struct Limits {
    pub source_bytes: usize,
    /// Command name + arguments + assignment names, '=' and values, in bytes.
    pub expansion_bytes: usize,
    /// All words, including command name and assignments (no empty AST placeholder).
    pub arguments: usize,
    pub pipeline_stages: usize,
    pub jobs: usize,
    pub function_depth: usize,
    pub line_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_bytes: 256 * 1024,
            expansion_bytes: 1024 * 1024,
            // Bash has no builtin argument count limit; expansion_bytes
            // bounds memory. `{0..10000}` alone needs 10,001 arguments.
            arguments: 65_536,
            pipeline_stages: 128,
            jobs: 128,
            function_depth: 128,
            line_bytes: 64 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Flow {
    Normal,
    Exit,
    Abort,
    Return,
    DiscardReadUnit,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Outcome {
    pub code: i32,
    pub flow: Flow,
}
impl Outcome {
    pub(crate) fn status(code: i32) -> Self {
        Self {
            code,
            flow: Flow::Normal,
        }
    }
}
/// Diagnostics for redirect-target failures use the stderr reached so far.
/// Other expansions, including prefix RHSs, use the caller's original stderr.
enum DiagnosticStderr {
    Inherited,
    Redirected(Option<io::Endpoint>),
}
struct CommandError {
    error: expand::Error,
    stderr: DiagnosticStderr,
    heredoc_status: Option<i32>,
}
impl CommandError {
    fn at_line(mut self, line: Option<usize>) -> Self {
        self.error = self.error.at_line(line);
        self
    }
    fn redirect(
        error: expand::Error,
        stderr: Option<io::Endpoint>,
        heredoc_status: Option<i32>,
    ) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Redirected(stderr),
            heredoc_status,
        }
    }
}
impl From<expand::Error> for CommandError {
    fn from(error: expand::Error) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Inherited,
            heredoc_status: None,
        }
    }
}
impl From<i32> for CommandError {
    fn from(code: i32) -> Self {
        expand::Error::Status(code).into()
    }
}

type Descriptors = Rc<RefCell<FdTable>>;
const TASK_METADATA_BYTES: usize = 4096;
/// Shared forwarding keeps descendants attached when several isolated scopes
/// finish in a different order. Captured parent handles follow later transfers.
#[derive(Clone)]
struct Scope(Rc<ScopeState>);
struct ScopeState {
    id: u64,
    parent: RefCell<Option<Scope>>,
}
impl Scope {
    fn new(id: u64) -> Self {
        Self(Rc::new(ScopeState {
            id,
            parent: RefCell::new(None),
        }))
    }
    fn resolved(&self) -> Self {
        let mut scope = self.clone();
        loop {
            let parent = scope.0.parent.borrow().clone();
            match parent {
                Some(parent) => scope = parent,
                None => return scope,
            }
        }
    }
    fn resolved_id(&self) -> u64 {
        self.resolved().0.id
    }
    fn forward_to(&self, parent: Scope) {
        // Skip ancestors that already exited. Repeated background hand-offs
        // must not retain an ever-growing chain of otherwise dead scopes.
        *self.0.parent.borrow_mut() = Some(parent.resolved());
    }
}
impl PartialEq for Scope {
    fn eq(&self, other: &Self) -> bool {
        self.resolved_id() == other.resolved_id()
    }
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
// Registry identities supply synthetic async handles, never ProcessHost PIDs.
pub(crate) struct JobId(u64);
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobNumber(u64);
#[derive(Clone, Copy)]
pub(crate) enum JobSelector {
    Handle(JobId),
    Number(JobNumber),
}
impl JobSelector {
    pub(crate) fn parse(value: &str) -> Result<Self, i32> {
        match value.strip_prefix('%') {
            Some(number) => number
                .parse()
                .map(|n| Self::Number(JobNumber(n)))
                .map_err(|_| 2),
            None => value.parse().map(|n| Self::Handle(JobId(n))).map_err(|_| 2),
        }
    }
    fn matches(self, id: JobId, job: &Job) -> bool {
        match self {
            Self::Handle(handle) => id == handle && !matches!(job.kind, JobKind::Internal),
            Self::Number(number) => job.kind == JobKind::Background(number),
        }
    }
    fn matches_live(self, id: JobId, job: &Job) -> bool {
        self.matches(id, job) && !matches!(job.kind, JobKind::Completed)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Background(JobNumber),
    ProcessSubstitution,
    /// A completed numeric handle retained until the bounded job table needs
    /// its slot again. Percent-job selectors intentionally do not match it.
    Completed,
    Internal,
}
struct Job {
    owner: Scope,
    kind: JobKind,
    group: GroupId,
    cancel: Cancel,
    signal: Rc<Cell<Option<i32>>>,
    join: JoinHandle<i32>,
    _allocation: Option<eval::Allocation>,
}
struct Core {
    executor: Executor,
    host: Rc<dyn ProcessHost>,
    fs: Rc<dyn FileSystem>,
    limits: Limits,
    eval_storage: eval::StorageBudget,
    descriptors: Descriptors,
    jobs: RefCell<BTreeMap<JobId, Job>>,
    next: Cell<u64>,
    foreground: RefCell<Option<Job>>,
    exit_requested: Cell<bool>,
}
#[derive(Clone)]
pub(crate) struct Context {
    core: Rc<Core>,
    source: eval::Source,
    pub cancel: Cancel,
    signal: Rc<Cell<Option<i32>>>,
    pub group: GroupId,
    scope: Scope,
    parameter_error_status: i32,
    compound_child: bool,
    evaluation: eval::Scope,
}
impl Context {
    fn stop_signal(&self) -> i32 {
        self.signal.get().unwrap_or(2)
    }
    fn cancel_status(&self) -> i32 {
        128 + self.stop_signal()
    }
    pub(crate) fn fs(&self) -> &dyn FileSystem {
        self.core.fs.as_ref()
    }
    pub(crate) fn limits(&self) -> &Limits {
        &self.core.limits
    }
    fn parser_budget(&self) -> shell_parser::limits::ExecutionBudget {
        let core = self.core.clone();
        let cancel = self.cancel.clone();
        self.evaluation.parser_budget(Some(Rc::new(move || {
            // A synchronous isolated parser may be the only running task when
            // Ctrl+C arrives. Consume it through the current foreground owner,
            // then test this reader's own token without canceling background.
            let foreground = core
                .foreground
                .borrow()
                .as_ref()
                .map(|job| job.cancel.clone());
            if let Some(foreground) = foreground {
                foreground.probe_now();
            }
            cancel.probe_now()
        })))
    }
    fn isolated(&self) -> Self {
        Self {
            scope: Scope::new(self.core.allocate_id()),
            evaluation: self.evaluation.new_task(),
            ..self.clone()
        }
    }
    fn child_error_status(&self, command: &Command) -> i32 {
        if matches!(
            command,
            Command::Simple(_) | Command::Function(_) | Command::Compound(..)
        ) {
            return self.parameter_error_status;
        }
        1
    }
    fn isolated_command(&self, command: &Command) -> Self {
        Self {
            parameter_error_status: self.child_error_status(command),
            compound_child: matches!(command, Command::Compound(..)),
            ..self.isolated()
        }
    }
    fn compound_body(&self) -> Self {
        Self {
            parameter_error_status: if self.compound_child {
                1
            } else {
                self.parameter_error_status
            },
            compound_child: false,
            ..self.clone()
        }
    }
    async fn cleanup_jobs(&self) {
        for job in self
            .core
            .jobs
            .borrow()
            .values()
            .filter(|job| job.owner == self.scope)
        {
            if job.signal.get().is_none() {
                job.signal.set(Some(self.stop_signal()));
            }
            job.cancel.cancel();
        }
        while let Some((id, join)) = self.next_job(None, true) {
            join.await;
            self.core.jobs.borrow_mut().remove(&id);
        }
    }
    /// A successful isolated scope leaves asynchronous descendants running.
    /// Transfer their cleanup ownership outward without making them waitable
    /// jobs of the caller. Cancellation still reaps the whole owned subtree.
    async fn finish_scope(&self, parent_scope: Scope) {
        if self.cancel.is_cancelled() {
            self.cleanup_jobs().await;
            return;
        }
        self.core.jobs.borrow_mut().retain(|_, job| {
            if job.owner != self.scope {
                return true;
            }
            job.kind = JobKind::Internal;
            !job.join.is_finished()
        });
        self.scope.forward_to(parent_scope);
    }
    async fn finish_group(&self, processes: &mut ProcessGroup, code: i32) -> i32 {
        let finished = self.cancel.run(processes.finish()).await;
        match finished {
            Ok(Ok(_)) => code,
            Ok(Err(_)) => 1,
            Err(_) => processes
                .terminate(self.stop_signal())
                .await
                .map(|_| self.cancel_status())
                .unwrap_or(1),
        }
    }
    pub(crate) async fn wait_job(&self, id: Option<JobSelector>) -> Result<i32, i32> {
        let code = self.wait_jobs(id, false).await?;
        Ok(if id.is_none() { 0 } else { code })
    }
    async fn wait_jobs(
        &self,
        selector: Option<JobSelector>,
        include_internal: bool,
    ) -> Result<i32, i32> {
        let mut code = 0;
        loop {
            let Some((id, job)) = self.next_job(selector, include_internal) else {
                if selector.is_some() {
                    return Err(127);
                }
                self.core
                    .jobs
                    .borrow_mut()
                    .retain(|_, job| job.owner != self.scope || job.kind != JobKind::Completed);
                return Ok(code);
            };
            code = self.cancel.run(job).await.map_err(|_| 130)?;
            if selector.is_some() {
                self.core
                    .jobs
                    .borrow_mut()
                    .get_mut(&id)
                    .expect("owned job stays registered while waiting")
                    .kind = JobKind::Completed;
                return Ok(code);
            }
            self.core.jobs.borrow_mut().remove(&id);
            // Exiting children may transfer their own descendants to this
            // scope. Supervisors drain those too, unlike the shell's `wait`.
        }
    }
    fn next_job(
        &self,
        selector: Option<JobSelector>,
        include_internal: bool,
    ) -> Option<(JobId, JoinHandle<i32>)> {
        self.core
            .jobs
            .borrow()
            .iter()
            .find(|(id, job)| {
                let selected = selector.map_or(
                    include_internal
                        || matches!(
                            job.kind,
                            JobKind::Background(_) | JobKind::ProcessSubstitution
                        ),
                    |selector| selector.matches(**id, job),
                );
                selected && job.owner == self.scope
            })
            .map(|(id, job)| (*id, job.join.clone()))
    }
    pub(crate) fn check_job(&self, selector: JobSelector) -> Result<(), i32> {
        self.core
            .jobs
            .borrow()
            .iter()
            .find(|(id, job)| selector.matches_live(**id, job) && job.owner == self.scope)
            .map(|_| ())
            .ok_or(1)
    }
    pub(crate) fn kill_job(&self, selector: JobSelector, signal: i32) -> Result<(), i32> {
        let jobs = self.core.jobs.borrow();
        let job = jobs
            .iter()
            .find(|(id, job)| selector.matches_live(**id, job) && job.owner == self.scope)
            .map(|(_, job)| job)
            .ok_or(1)?;
        if job.join.is_finished() {
            return Err(1);
        }
        self.core
            .host
            .kill_group(job.group, signal)
            .map_err(|_| 1)?;
        job.signal.set(Some(signal));
        job.cancel.cancel();
        Ok(())
    }
}
/// Failure before a foreground job starts. Embeddings must preserve interrupt
/// status rather than reporting parser cancellation as a syntax error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    Interrupted,
    Invalid(String),
}
impl StartError {
    pub fn status(&self) -> i32 {
        match self {
            Self::Interrupted => 130,
            Self::Invalid(_) => 2,
        }
    }
}
impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Interrupted => f.write_str("request cancelled"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for StartError {}

/// A persistent shell session. The embedding drives `Executor`, delivers
/// interrupts without a message-loop round trip, and drains terminal endpoints.
pub struct Session {
    core: Rc<Core>,
    state: SharedState,
}
impl Session {
    pub fn new(
        executor: Executor,
        host: Rc<dyn ProcessHost>,
        fs: Rc<dyn FileSystem>,
        limits: Limits,
    ) -> Self {
        Self {
            core: Rc::new(Core {
                executor,
                host,
                fs,
                eval_storage: eval::StorageBudget::new(limits.expansion_bytes),
                limits,
                descriptors: Rc::new(RefCell::new(FdTable::default())),
                jobs: RefCell::new(BTreeMap::new()),
                next: Cell::new(1),
                foreground: RefCell::new(None),
                exit_requested: Cell::new(false),
            }),
            state: State::default().shared(),
        }
    }
    pub fn state(&self) -> SharedState {
        self.state.clone()
    }
    pub fn exit_requested(&self) -> bool {
        self.core.exit_requested.get()
    }
    pub fn background_jobs(&self) -> usize {
        self.core
            .jobs
            .borrow()
            .values()
            .filter(|job| {
                matches!(job.kind, JobKind::Background(_)) && job.owner.resolved_id() == 0
            })
            .count()
    }
    pub fn interrupt(&self) {
        if let Some(job) = self.core.foreground.borrow().as_ref() {
            if job.signal.get().is_none() {
                job.signal.set(Some(2));
            }
            job.cancel.cancel();
        }
    }
    pub fn set_descriptors(&self, fds: FdTable) -> Result<(), String> {
        if self.core.foreground.borrow().is_some() {
            return Err("foreground job is already running".into());
        }
        *self.core.descriptors.borrow_mut() = fds;
        Ok(())
    }
    pub fn start(&self, source: &str) -> Result<JoinHandle<i32>, StartError> {
        if self.core.foreground.borrow().is_some() {
            return Err(StartError::Invalid(
                "foreground job is already running".into(),
            ));
        }
        if source.len() > self.core.limits.source_bytes {
            return Err(StartError::Invalid("shell source limit exceeded".into()));
        }
        let host = self.core.host.clone();
        let cancel = Cancel::with_probe(Rc::new(move || host.interrupted()));
        let parser_cancel = cancel.clone();
        let evaluation = eval::Scope::new(&self.core.limits, self.core.eval_storage.clone());
        let parser = evaluation.parser_budget(Some(Rc::new(move || parser_cancel.probe_now())));
        let (script, failure) =
            parse_shell(source, &self.core.limits, &parser).map_err(|error| {
                if error == "request cancelled" {
                    StartError::Interrupted
                } else {
                    StartError::Invalid(error)
                }
            })?;
        if script.commands.is_empty()
            && let Some(ParseFailure::Syntax { message, .. }) = failure.as_ref()
        {
            return Err(StartError::Invalid(message.clone()));
        }
        let group = self.core.host.allocate_group();
        let foreground_cancel = cancel.clone();
        let signal = Rc::new(Cell::new(None));
        let foreground_signal = signal.clone();
        let context = Context {
            core: self.core.clone(),
            source: eval::Source::root(source),
            cancel,
            signal,
            group,
            scope: Scope::new(0),
            parameter_error_status: 127,
            compound_child: false,
            evaluation,
        };
        let state = self.state.clone();
        let join = self.core.executor.spawn(async move {
            let _foreground = ForegroundGuard(context.core.clone());
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let mut result = script_sequence(
                script.commands,
                script.command_end_lines,
                state.clone(),
                context.core.descriptors.clone(),
                context.clone(),
            )
            .await;
            if matches!(result.flow, Flow::Normal | Flow::DiscardReadUnit)
                && let Some(failure) = failure
            {
                result = parse_failure(failure, "-c", &context.core.descriptors, &context).await;
            }
            if result.flow == Flow::Exit {
                context.core.exit_requested.set(true);
            }
            let code = context.finish_group(&mut processes, result.code).await;
            state.borrow_mut().status = code;
            code
        });
        *self.core.foreground.borrow_mut() = Some(Job {
            owner: Scope::new(0),
            kind: JobKind::Internal,
            group,
            cancel: foreground_cancel,
            signal: foreground_signal,
            join: join.clone(),
            _allocation: None,
        });
        Ok(join)
    }
    pub async fn shutdown(&self) {
        self.interrupt();
        let jobs: Vec<_> = self
            .core
            .jobs
            .borrow()
            .values()
            .map(|j| {
                if j.signal.get().is_none() {
                    j.signal.set(Some(2));
                }
                j.cancel.cancel();
                j.join.clone()
            })
            .collect();
        let foreground = self
            .core
            .foreground
            .borrow()
            .as_ref()
            .map(|job| job.join.clone());
        join_all(jobs.into_iter().chain(foreground)).await;
        self.core.jobs.borrow_mut().clear();
        *self.core.descriptors.borrow_mut() = FdTable::default();
        self.core.host.shutdown_io().await;
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.interrupt();
        for job in self.core.jobs.borrow().values() {
            if job.signal.get().is_none() {
                job.signal.set(Some(2));
            }
            job.cancel.cancel();
        }
    }
}
impl Core {
    fn reap_internal_jobs(&self) {
        self.jobs
            .borrow_mut()
            .retain(|_, job| job.kind != JobKind::Internal || !job.join.is_finished());
    }
    fn has_job_capacity(&self) -> bool {
        self.jobs
            .borrow()
            .values()
            .filter(|job| job.kind != JobKind::Completed)
            .count()
            < self.limits.jobs
    }
    fn reap_completed_jobs(&self) {
        let mut jobs = self.jobs.borrow_mut();
        // Reserve one launch slot by evicting the oldest retained handle.
        // Inspect the bounded table in place; eviction allocates no scratch.
        while jobs.len() >= self.limits.jobs {
            let oldest = jobs
                .iter()
                .find_map(|(id, job)| matches!(job.kind, JobKind::Completed).then_some(*id));
            let Some(id) = oldest else { break };
            jobs.remove(&id);
        }
    }
    fn allocate_job_number(&self, owner: &Scope) -> Result<JobNumber, i32> {
        let jobs = self.jobs.borrow();
        for index in 0..=jobs.len() {
            let number = JobNumber(
                u64::try_from(index)
                    .map_err(|_| 2)?
                    .checked_add(1)
                    .ok_or(2)?,
            );
            let used = jobs
                .values()
                .any(|job| job.kind == JobKind::Background(number) && job.owner == *owner);
            if !used {
                return Ok(number);
            }
        }
        Err(2)
    }
    fn allocate_id(&self) -> u64 {
        let id = self.next.get();
        self.next.set(id.checked_add(1).expect("job ID overflow"));
        id
    }
}
struct ForegroundGuard(Rc<Core>);
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        self.0.foreground.borrow_mut().take();
    }
}

/// Where parsing stopped. Bash reads and runs a script one complete line at
/// a time, so the commands on earlier lines still run first.
enum ParseFailure {
    /// A command substitution body that does not parse (status 127).
    Word(usize),
    /// Any other syntax error (status 2).
    Syntax { message: String, line: usize },
}

struct ParsedScript {
    commands: Vec<Command>,
    command_end_lines: Vec<usize>,
}

/// Parse shell source the way the script reader and `eval` do. Resource
/// limits are errors; a syntax error keeps the complete lines before it.
fn parse_shell(
    source: &str,
    limits: &Limits,
    budget: &shell_parser::limits::ExecutionBudget,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    if source.len() > limits.source_bytes {
        return Err("shell source limit exceeded".into());
    }
    let parser_limits = shell_parser::limits::ExecutionLimits {
        max_input_bytes: limits.source_bytes,
        ..Default::default()
    };
    let (script, error) = Parser::with_limits_and_timeout(
        source,
        parser_limits.max_ast_depth,
        parser_limits.max_parser_operations,
        Some(parser_limits.parser_timeout),
    )
    .with_execution_budget(budget.clone())
    // The whole script is parsed before aliases it defines exist, so the
    // top level stays lenient; substitution bodies get bash's grammar.
    .with_strict_substitution_bodies()
    .parse_recovering();
    budget.check().map_err(|error| error.to_string())?;
    let failure = match error {
        None => None,
        Some(shell_parser::Error::ShellWord { line }) => Some(ParseFailure::Word(line)),
        Some(shell_parser::Error::Parse { message, line, .. }) => {
            Some(ParseFailure::Syntax { message, line })
        }
        Some(error) => return Err(error.to_string()),
    };
    Ok((
        ParsedScript {
            commands: script.commands,
            command_end_lines: script.command_end_lines,
        },
        failure,
    ))
}

/// Report where parsing stopped, after the commands before it ran. A bad
/// substitution body ends the shell with 127; other syntax errors with 2.
async fn parse_failure(
    failure: ParseFailure,
    reader: &str,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let (message, line) = match failure {
        ParseFailure::Word(line) => {
            let mut work = expansion_work(context.limits());
            let error = work
                .admit_storage(256)
                .err()
                .unwrap_or(expand::Error::ShellBoundary {
                    stage: expand::ShellBoundaryStage::Word,
                    line: Some(line),
                });
            return expansion_failure(error.into(), fds, context).await;
        }
        ParseFailure::Syntax { message, line } => (message, line),
    };
    if message.len() > context.limits().expansion_bytes {
        return Outcome::status(2);
    }
    let diagnostic = format!("/usr/bin/bash: {reader}: line {line}: {message}\n");
    let stderr = fds.borrow().get(2);
    if let Some(stderr) = stderr {
        let _ = stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await;
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    Outcome {
        code: 2,
        flow: Flow::Exit,
    }
}

async fn script_sequence(
    commands: Vec<Command>,
    command_end_lines: Vec<usize>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut result = Outcome::status(0);
    let mut discarded_line = None;
    // The parser groups each top-level read unit through its terminating
    // newline. Arithmetic expansion errors unwind functions and compound
    // commands in that unit, then Bash's reader accepts the next one.
    for (index, command) in commands.into_iter().enumerate() {
        let end_line = command_end_lines.get(index).copied();
        if discarded_line.is_some_and(|line| end_line.is_some_and(|end| end <= line)) {
            continue;
        }
        result = execute(command, state.clone(), fds.clone(), context.clone()).await;
        if context.cancel.is_cancelled() {
            return Outcome::status(130);
        }
        if result.flow == Flow::DiscardReadUnit {
            discarded_line = end_line;
        } else if matches!(result.flow, Flow::Exit | Flow::Abort | Flow::Return) {
            break;
        }
    }
    result
}

fn sequence(
    commands: Vec<Command>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, Outcome> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        sequence_body(commands, state, fds, context),
        Outcome::status,
    )
}

async fn sequence_body(
    commands: Vec<Command>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut result = Outcome::status(0);
    for command in commands {
        result = execute(command, state.clone(), fds.clone(), context.clone()).await;
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            break;
        }
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    result
}
fn execute(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, Outcome> {
    if context.cancel.is_cancelled() {
        return futures::future::Either::Left(futures::future::ready(Outcome::status(130)));
    }
    let evaluation = match context.evaluation.descend() {
        Ok(scope) => scope,
        Err(code) => {
            return futures::future::Either::Left(futures::future::ready(Outcome::status(code)));
        }
    };
    let context = Context {
        evaluation,
        ..context
    };
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        async move {
            yield_now().await;
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            let preserve = matches!(command, Command::Pipeline(_) | Command::List(_));
            let result = command_body(command, state.clone(), fds, context).await;
            finish_command(&state, result, preserve)
        },
        Outcome::status,
    )
}

fn finish_command(state: &SharedState, result: Outcome, preserve_pipeline: bool) -> Outcome {
    let mut state = state.borrow_mut();
    state.status = result.code;
    if !preserve_pipeline {
        state.pipestatus = vec![result.code];
    }
    result
}

// Select the future outside the recursive poll frame. An async match retains
// every branch's largest expansion/dispatch frame even when polling a brace.
#[inline(never)]
fn command_body(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    match command {
        Command::Simple(simple) => {
            evaluation.frame(simple_command(simple, state, fds, context), Outcome::status)
        }
        Command::Function(function) => evaluation.frame(
            async move {
                state.borrow_mut().functions.insert(
                    function.name,
                    StoredFunction {
                        body: Rc::new(*function.body),
                        storage: context.evaluation.retained(),
                    },
                );
                Outcome::status(0)
            },
            Outcome::status,
        ),
        Command::Pipeline(pipeline) => evaluation.frame(
            pipeline_command(pipeline, state, fds, context),
            Outcome::status,
        ),
        Command::List(list) => {
            evaluation.frame(list_command(list, state, fds, context), Outcome::status)
        }
        Command::Compound(CompoundCommand::Subshell(commands), redirs) => evaluation.frame(
            subshell(commands, redirs, state, fds, context),
            Outcome::status,
        ),
        Command::Compound(compound, redirs) => evaluation.frame(
            compound_command(compound, redirs, state, fds, context),
            Outcome::status,
        ),
    }
}

async fn pipeline_command(
    pipeline: Pipeline,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let count = pipeline.commands.len();
    if count == 0 || count > context.limits().pipeline_stages {
        state.borrow_mut().pipestatus = vec![2];
        return Outcome::status(2);
    }
    let mut work = expansion_work(context.limits());
    let children = match pipeline_children(count, &state, &context, &mut work).await {
        Ok(children) => children,
        Err(error) => {
            let outcome = expansion_failure(error.into(), &fds, &context).await;
            state.borrow_mut().pipestatus = vec![outcome.code];
            return outcome;
        }
    };
    let mut children = children.into_iter();
    let mut pipes = VecDeque::new();
    for _ in 1..count {
        let pipe = match context.fs().pipe() {
            Ok(pipe) => pipe,
            Err(error) => return Outcome::status(error.status()),
        };
        pipes.push_back(pipe);
    }
    let mut previous = None;
    let mut tasks = Vec::new();
    // All stage task/queue metadata is admitted before the first launch.
    let _tasks_allocation = match admit_task_metadata::<JoinHandle<Outcome>>(&context, count) {
        Ok(allocation) => allocation,
        Err(_) => {
            state.borrow_mut().pipestatus = vec![2];
            return Outcome::status(2);
        }
    };
    if tasks.try_reserve_exact(count).is_err() {
        state.borrow_mut().pipestatus = vec![2];
        return Outcome::status(2);
    }
    for (index, command) in pipeline.commands.into_iter().enumerate() {
        let mut stage_fds = fds.borrow().clone();
        if let Some(input) = previous.take() {
            stage_fds.insert(0, input);
        }
        if index + 1 < count {
            let (reader, writer) = pipes.pop_front().expect("reserved pipeline pipe");
            stage_fds.insert(1, writer);
            previous = Some(reader);
        }
        let child = if count == 1 {
            state.clone()
        } else {
            children.next().expect("all pipeline state was prepared")
        };
        let stage_context = if count == 1 {
            context.clone()
        } else {
            context.isolated_command(&command)
        };
        let stage_fds = if count == 1 {
            fds.clone()
        } else {
            Rc::new(RefCell::new(stage_fds))
        };
        let parent_scope = context.scope.clone();
        tasks.push(context.core.executor.spawn(pipeline_stage(
            command,
            child,
            stage_fds,
            stage_context,
            parent_scope,
            count > 1,
        )));
    }
    drop(fds);
    drop(previous);
    let results = join_all(tasks).await;
    if count == 1 && results[0].flow != Flow::Normal {
        return results[0];
    }
    let codes: Vec<_> = results.iter().map(|r| r.code).collect();
    let mut code = if state.borrow().pipefail {
        codes.iter().rev().copied().find(|&n| n != 0).unwrap_or(0)
    } else {
        *codes.last().unwrap()
    };
    if pipeline.negated {
        code = i32::from(code == 0);
    }
    if context.cancel.is_cancelled() {
        code = 130;
    }
    state.borrow_mut().pipestatus = codes;
    Outcome::status(code)
}

#[inline(never)]
fn pipeline_children<'a>(
    count: usize,
    state: &'a SharedState,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<Vec<SharedState>, expand::Error>> {
    context.evaluation.frame(
        pipeline_children_body(count, state, context, work),
        |code| Err(code.into()),
    )
}

async fn pipeline_children_body(
    count: usize,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Vec<SharedState>, expand::Error> {
    let mut children = Vec::new();
    if count == 1 {
        return Ok(children);
    }
    work.admit_storage(
        count
            .checked_mul(std::mem::size_of::<SharedState>())
            .ok_or(2)?,
    )?;
    children.try_reserve_exact(count).map_err(|_| 2)?;
    for _ in 0..count {
        children.push(
            State::snapshot(state, &context.cancel, work)
                .await?
                .shared(),
        );
    }
    Ok(children)
}

async fn pipeline_stage(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    parent_scope: Scope,
    isolated: bool,
) -> Outcome {
    let result = execute(command, state, fds, context.clone()).await;
    if isolated {
        context.finish_scope(parent_scope).await;
    }
    result
}

async fn compound_command(
    compound: CompoundCommand,
    redirs: Vec<Redirect>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let table = fds.borrow().clone();
    drop(fds);
    let fds = Rc::new(RefCell::new(table));
    let mut work = substitution_work(&context, &fds);
    let fds = match command_redirects(&redirs, &state, fds, &context, &mut work).await {
        Err(outcome) => return outcome,
        Ok(fds) => fds,
    };
    let context = context.compound_body();
    // Other bodies must release the expansion reader's descriptor references.
    work.substitutions = matches!(
        compound,
        CompoundCommand::Arithmetic(_) | CompoundCommand::Case(_)
    )
    .then(|| Substitutions {
        context: context.clone(),
        fds: fds.clone(),
    });
    execute_compound_body(compound, state, fds, context, &mut work).await
}

#[inline(never)]
fn command_redirects<'a>(
    redirs: &'a [Redirect],
    state: &'a SharedState,
    fds: Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<Descriptors, Outcome>> {
    context.evaluation.frame(
        async move {
            let original_fds = fds.clone();
            match redirects(redirs, state, fds, context, work, None).await {
                Ok(fds) => Ok(fds),
                Err(error) => Err(expansion_failure(error, &original_fds, context).await),
            }
        },
        |code| Err(Outcome::status(code)),
    )
}

#[inline(never)]
fn execute_compound_body<'a>(
    compound: CompoundCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a> {
    let evaluation = context.evaluation.clone();
    match compound {
        CompoundCommand::Arithmetic(source) => evaluation.frame(
            async move { arithmetic_command(&source, &state, &fds, &context, work).await },
            Outcome::status,
        ),
        CompoundCommand::BraceGroup(commands) => sequence(commands, state, fds, context),
        CompoundCommand::While(loop_) => {
            evaluation.frame(while_command(loop_, state, fds, context), Outcome::status)
        }
        CompoundCommand::Case(case_) => {
            evaluation.frame(run_case(case_, state, fds, context, work), Outcome::status)
        }
        _ => futures::future::Either::Left(futures::future::ready(Outcome::status(2))),
    }
}

async fn while_command(
    loop_: WhileCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut condition_cache = None;
    let mut condition_cache_attempted = false;
    let mut body_cache = None;
    let mut body_cache_attempted = false;
    let mut result = Outcome::status(0);
    let mut budget = Budget::default();
    loop {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        if !condition_cache_attempted {
            condition_cache_attempted = true;
            condition_cache = cache_loop_arithmetic(&loop_.condition, &context).await;
        }
        let condition = loop_sequence(
            &loop_.condition,
            &state,
            &fds,
            &context,
            condition_cache.as_ref(),
        )
        .await;
        if context.cancel.is_cancelled() {
            return Outcome::status(130);
        }
        if condition.flow != Flow::Normal {
            return condition;
        }
        if condition.code != 0 {
            return result;
        }
        if !body_cache_attempted {
            body_cache_attempted = true;
            body_cache = cache_loop_arithmetic(&loop_.body, &context).await;
        }
        result = loop_sequence(&loop_.body, &state, &fds, &context, body_cache.as_ref()).await;
        if result.flow != Flow::Normal {
            return result;
        }
    }
}

fn loop_sequence<'a>(
    commands: &'a [Command],
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    cache: Option<&'a CachedArithmetic<'a>>,
) -> eval::Frame<'a> {
    if let [Command::Compound(CompoundCommand::Arithmetic(source), redirs)] = commands
        && redirs.is_empty()
    {
        return loop_arithmetic(source, state, fds, context, cache);
    }
    context.evaluation.frame(
        async move {
            // The prior iteration's copy is gone. Admit this retained AST
            // copy against fresh command storage, never elapsed loop work.
            let mut work = expansion_work(context.limits());
            if let Err(error) = crate::ast_copy::admit(commands, &context.cancel, &mut work).await {
                return expansion_failure(error.into(), fds, context).await;
            }
            sequence(
                commands.to_vec(),
                state.clone(),
                fds.clone(),
                context.clone(),
            )
            .await
        },
        Outcome::status,
    )
}

struct CachedArithmetic<'a> {
    program: arithmetic::Program<'a>,
    _storage: eval::StorageAllocation,
}

async fn cache_loop_arithmetic<'a>(
    commands: &'a [Command],
    context: &Context,
) -> Option<CachedArithmetic<'a>> {
    let [Command::Compound(CompoundCommand::Arithmetic(source), redirs)] = commands else {
        return None;
    };
    if !redirs.is_empty() || !arithmetic::Program::is_static(source) {
        return None;
    }
    let storage = context
        .evaluation
        .admit_storage(arithmetic::Program::retained_bytes(source))
        .ok()?;
    let mut work = expansion_work(context.limits());
    let program = match arithmetic::Program::compile(source, &mut work, &context.cancel).await {
        Ok(program) => program,
        Err(_) => return None,
    };
    Some(CachedArithmetic {
        program,
        _storage: storage,
    })
}

fn loop_arithmetic<'a>(
    source: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &Context,
    cache: Option<&'a CachedArithmetic<'a>>,
) -> eval::Frame<'a> {
    if context.cancel.is_cancelled() {
        return futures::future::Either::Left(futures::future::ready(Outcome::status(130)));
    }
    let evaluation = match context.evaluation.descend() {
        Ok(scope) => scope,
        Err(code) => {
            return futures::future::Either::Left(futures::future::ready(Outcome::status(code)));
        }
    };
    let context = Context {
        evaluation: evaluation.clone(),
        ..context.compound_body()
    };
    // The retained loop already owns this typed source. Replay borrows it;
    // every evaluation still owns fresh Work and command-local descriptors.
    evaluation.frame(
        async move {
            yield_now().await;
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            let table = fds.borrow().clone();
            let fds = Rc::new(RefCell::new(table));
            let mut work = substitution_work(&context, &fds);
            let result = match cache {
                Some(cache) => {
                    arithmetic_command_program(&cache.program, state, &fds, &context, &mut work)
                        .await
                }
                None => arithmetic_command(source, state, &fds, &context, &mut work).await,
            };
            let result = finish_command(state, result, false);
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            result
        },
        Outcome::status,
    )
}

async fn loop_checkpoint(budget: &mut Budget, context: &Context) -> Result<(), Outcome> {
    budget
        .checkpoint(&context.cancel)
        .await
        .map_err(|_| Outcome::status(130))
}

/// `case` expands its word as a scalar (no splitting or globbing) and each
/// pattern with quote protection, then matches through the bounded matcher.
async fn run_case(
    case_: CaseCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &mut expand::Work,
) -> Outcome {
    let word = match case_word(&case_.word, &state, &context, work).await {
        Ok(word) => word,
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let mut matched = false;
    let mut result = Outcome::status(0);
    let mut budget = Budget::default();
    for item in case_.cases {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        if !matched {
            let item_match = match case_item_matches(
                &item.patterns,
                &word,
                &state,
                &fds,
                &context,
                work,
                &mut budget,
            )
            .await
            {
                Ok(matched) => matched,
                Err(outcome) => return outcome,
            };
            if !item_match {
                continue;
            }
            matched = true;
        }
        result = sequence(item.commands, state.clone(), fds.clone(), context.clone()).await;
        if result.flow != Flow::Normal {
            return result;
        }
        match item.terminator {
            CaseTerminator::Break => return result,
            CaseTerminator::FallThrough => {}
            CaseTerminator::Continue => matched = false,
        }
    }
    result
}

#[inline(never)]
fn case_word<'a>(
    word: &'a Word,
    state: &'a SharedState,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<String, expand::Error>> {
    context.evaluation.frame(
        expand::word(
            word,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            context.limits().expansion_bytes,
            work,
        ),
        |code| Err(code.into()),
    )
}

#[inline(never)]
fn case_item_matches<'a>(
    patterns: &'a [Word],
    word: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
    budget: &'a mut Budget,
) -> eval::Frame<'a, Result<bool, Outcome>> {
    context.evaluation.frame(
        case_item_matches_body(patterns, word, state, fds, context, work, budget),
        |code| Err(Outcome::status(code)),
    )
}

async fn case_item_matches_body(
    patterns: &[Word],
    word: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
    budget: &mut Budget,
) -> Result<bool, Outcome> {
    for pattern in patterns {
        loop_checkpoint(budget, context).await?;
        let mut pattern = match expand::pattern(
            pattern,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            work,
        )
        .await
        {
            Ok(pattern) => pattern,
            Err(error) => return Err(expansion_failure(error.into(), fds, context).await),
        };
        match pattern.matches_full(word, work, &context.cancel).await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => return Err(expansion_failure(error.into(), fds, context).await),
        }
    }
    Ok(false)
}

async fn arithmetic_command(
    source: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Outcome {
    let value = crate::arithmetic::evaluate(
        source,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await;
    arithmetic_result(value, fds, context).await
}

async fn arithmetic_command_program(
    program: &arithmetic::Program<'_>,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Outcome {
    let arithmetic_cancel = context.cancel.without_probe();
    let value = arithmetic::evaluate_program(
        program,
        state,
        &arithmetic_cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await;
    arithmetic_result(value, fds, context).await
}

async fn arithmetic_result(
    value: Result<i64, expand::Error>,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    match value {
        Ok(value) => Outcome::status(i32::from(value == 0)),
        Err(
            error @ expand::Error::Arithmetic {
                expansion: false, ..
            }
            | error @ expand::Error::Readonly {
                expansion: false, ..
            },
        ) => {
            let mut outcome = expansion_failure(error.into(), fds, context).await;
            outcome.flow = Flow::Normal;
            outcome
        }
        Err(error) => expansion_failure(error.into(), fds, context).await,
    }
}

async fn expansion_failure(error: CommandError, fds: &Descriptors, context: &Context) -> Outcome {
    let CommandError {
        error,
        stderr,
        heredoc_status,
    } = error;
    // External and unnamed commands expand heredocs in a command-local reader.
    // Shell builtins/functions and prefix RHS errors stay in the shell scope.
    let flow = if heredoc_status.is_some() {
        Flow::Normal
    } else if matches!(
        error,
        expand::Error::AssignmentDepth
            | expand::Error::Arithmetic { .. }
            | expand::Error::Readonly { .. }
            | expand::Error::ShellBoundary {
                stage: expand::ShellBoundaryStage::Expansion,
                ..
            }
    ) {
        Flow::DiscardReadUnit
    } else {
        // Abort this submitted script, not the persistent interactive session.
        // Only the explicit exit builtin requests session shutdown.
        Flow::Abort
    };
    let (name, message, line, status) = match error {
        expand::Error::Status(code) => return Outcome::status(code),
        expand::Error::AssignmentDepth => return Outcome { code: 1, flow },
        expand::Error::SpecialAssignment { name, line } => {
            (name, "cannot assign in this way".to_owned(), line, 1)
        }
        expand::Error::Readonly { name, line, .. } => {
            (name, "readonly variable".to_owned(), line, 1)
        }
        expand::Error::Unbound { name, line } => (
            name,
            "unbound variable".to_owned(),
            line,
            heredoc_status.unwrap_or(context.parameter_error_status),
        ),
        expand::Error::ShellBoundary { stage, line } => (
            "arithmetic expression".to_owned(),
            "syntax error while looking for matching `)'".to_owned(),
            line,
            match stage {
                expand::ShellBoundaryStage::Word => 127,
                expand::ShellBoundaryStage::Expansion => 1,
            },
        ),
        expand::Error::Arithmetic { message, line, .. } => (
            "arithmetic expression".to_owned(),
            message.to_owned(),
            line,
            1,
        ),
        expand::Error::BadSubstitution { message, line } => {
            ("bad substitution".to_owned(), message.to_owned(), line, 1)
        }
        expand::Error::Parameter {
            name,
            message,
            line,
        } => (
            name,
            message,
            line,
            heredoc_status.unwrap_or(context.parameter_error_status),
        ),
        expand::Error::Indirect { name, unset, line } => (
            name,
            if unset {
                "invalid indirect expansion"
            } else {
                "invalid variable name"
            }
            .to_owned(),
            line,
            1,
        ),
    };
    // The expansion adapter reserves diagnostic space before owning these
    // strings. Check the complete spelling before format allocates its copy.
    let size = name.len().saturating_add(message.len()).saturating_add(96);
    if size > context.limits().expansion_bytes {
        return Outcome::status(2);
    }
    let diagnostic = match line {
        Some(line) => format!("/usr/bin/bash: line {line}: {name}: {message}\n"),
        None => format!("/usr/bin/bash: {name}: {message}\n"),
    };
    let stderr = match stderr {
        DiagnosticStderr::Inherited => fds.borrow().get(2),
        DiagnosticStderr::Redirected(stderr) => stderr,
    };
    if let Some(stderr) = stderr {
        let _ = stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await;
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    Outcome { code: status, flow }
}

async fn subshell(
    commands: Vec<Command>,
    redirs: Vec<Redirect>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut work = expansion_work(context.limits());
    let _task_allocation = match admit_task_metadata::<()>(&context, 1) {
        Ok(allocation) => allocation,
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let child = match State::snapshot(&state, &context.cancel, &mut work).await {
        Ok(child) => child.shared(),
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let parent_scope = context.scope.clone();
    let child_context = context.isolated();
    let child_fds = Rc::new(RefCell::new(fds.borrow().clone()));
    drop(fds);
    let result =
        context
            .core
            .executor
            .spawn(async move {
                work.substitutions = Some(Substitutions {
                    context: child_context.clone(),
                    fds: child_fds.clone(),
                });
                let result =
                    match command_redirects(&redirs, &child, child_fds, &child_context, &mut work)
                        .await
                    {
                        Ok(fds) => {
                            work.substitutions = None;
                            let body_context = Context {
                                parameter_error_status: 1,
                                compound_child: false,
                                ..child_context.clone()
                            };
                            sequence(commands, child, fds, body_context).await
                        }
                        Err(outcome) => outcome,
                    };
                child_context.finish_scope(parent_scope).await;
                result
            })
            .await;
    Outcome::status(result.code)
}

async fn list_command(
    list: CommandList,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    // `&` backgrounds the preceding AND/OR list, not the command after it.
    let mut first = *list.first;
    let mut links = Vec::new();
    let mut result;
    for (operator, next) in list.rest {
        if matches!(operator, ListOperator::And | ListOperator::Or) {
            links.push((operator, next));
            continue;
        }
        let command = and_or(first, std::mem::take(&mut links), list.span);
        result = if operator == ListOperator::Background {
            background(command, &state, &fds, &context).await
        } else {
            execute(command, state.clone(), fds.clone(), context.clone()).await
        };
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            return result;
        }
        first = next;
    }
    // There are no separators left: evaluate AND/OR directly to avoid wrapping
    // the same AST into another list forever.
    result = execute(first, state.clone(), fds.clone(), context.clone()).await;
    for (operator, next) in links {
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            break;
        }
        if (operator == ListOperator::And && result.code == 0)
            || (operator == ListOperator::Or && result.code != 0)
        {
            result = execute(next, state.clone(), fds.clone(), context.clone()).await;
        }
    }
    result
}
fn and_or(first: Command, rest: Vec<(ListOperator, Command)>, span: Span) -> Command {
    if rest.is_empty() {
        first
    } else {
        Command::List(CommandList {
            first: Box::new(first),
            rest,
            span,
        })
    }
}
#[inline(never)]
fn background<'a>(
    command: Command,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> eval::Frame<'a> {
    context.evaluation.frame(
        background_body(command, state, fds, context),
        Outcome::status,
    )
}

async fn background_body(
    command: Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let result = launch_background(command, state, fds, context).await;
    let mut state = state.borrow_mut();
    state.status = result.code;
    state.pipestatus = vec![result.code];
    result
}

async fn launch_background(
    command: Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    context.core.reap_internal_jobs();
    if !context.core.has_job_capacity() {
        return Outcome::status(2);
    }
    let mut work = expansion_work(context.limits());
    let child = match State::snapshot(state, &context.cancel, &mut work).await {
        Ok(child) => child.shared(),
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    let job = JobId(context.core.allocate_id());
    let identity = match async_identity(job, &context.cancel, &mut work).await {
        Ok(identity) => identity,
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    let allocation = match admit_job(context) {
        Ok(allocation) => allocation,
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    // Snapshot checkpoints may have let another scope create async children.
    context.core.reap_completed_jobs();
    if context.core.jobs.borrow().len() >= context.limits().jobs {
        return Outcome::status(2);
    }
    let number = match context.core.allocate_job_number(&context.scope) {
        Ok(number) => number,
        Err(code) => return Outcome::status(code),
    };
    let group = context.core.host.allocate_background_group();
    let cancel = Cancel::new();
    let signal = Rc::new(Cell::new(None));
    let child_context = Context {
        core: context.core.clone(),
        source: context.source.clone(),
        cancel: cancel.clone(),
        signal: signal.clone(),
        group,
        scope: Scope::new(context.core.allocate_id()),
        parameter_error_status: context.child_error_status(&command),
        compound_child: matches!(command, Command::Compound(..)),
        evaluation: context.evaluation.new_task(),
    };
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let parent_scope = context.scope.clone();
    let join = context.core.executor.spawn(async move {
        let mut processes = ProcessGroup::new(child_context.core.host.clone(), group)
            .with_signal(child_context.signal.clone());
        let result = execute(command, child, fds, child_context.clone()).await;
        child_context.finish_scope(parent_scope).await;
        child_context
            .finish_group(&mut processes, result.code)
            .await
    });
    context.core.jobs.borrow_mut().insert(
        job,
        Job {
            owner: context.scope.clone(),
            kind: JobKind::Background(number),
            group,
            cancel,
            signal,
            join,
            _allocation: Some(allocation),
        },
    );
    state.borrow_mut().last_async = Some(identity);
    Outcome::status(0)
}

fn admit_task_metadata<T>(
    context: &Context,
    count: usize,
) -> Result<eval::Allocation, expand::Error> {
    let bytes = count
        .checked_mul(TASK_METADATA_BYTES + std::mem::size_of::<T>())
        .ok_or(2)?;
    context
        .evaluation
        .admit_execution(bytes)
        .map_err(Into::into)
}

fn admit_job(context: &Context) -> Result<eval::Allocation, expand::Error> {
    // One conservative B-tree node plus fixed task/queue/cancellation metadata.
    let bytes = std::mem::size_of::<(JobId, Job)>()
        .checked_add(std::mem::size_of::<usize>())
        .and_then(|bytes| bytes.checked_mul(16))
        .and_then(|bytes| bytes.checked_add(TASK_METADATA_BYTES))
        .ok_or(2)?;
    context
        .evaluation
        .admit_execution(bytes)
        .map_err(Into::into)
}

async fn async_identity(
    id: JobId,
    cancel: &Cancel,
    work: &mut expand::Work,
) -> Result<String, expand::Error> {
    let bytes = id.0.checked_ilog10().unwrap_or(0) as usize + 1;
    work.admit_storage(bytes)?;
    for _ in 0..bytes {
        work.checkpoint(cancel).await?;
    }
    let mut identity = String::new();
    identity.try_reserve_exact(bytes).map_err(|_| 2)?;
    std::fmt::Write::write_fmt(&mut identity, format_args!("{}", id.0)).map_err(|_| 2)?;
    Ok(identity)
}

fn admission_status(error: expand::Error) -> i32 {
    match error {
        expand::Error::Status(code) => code,
        _ => 2,
    }
}
/// Bash's own device names: `/dev/fd/N` duplicates open descriptor N (a
/// process substitution, for instance); `/dev/stdin`, `/dev/stdout` and
/// `/dev/stderr` are descriptors 0, 1 and 2. A closed descriptor is an error.
pub(crate) fn device_endpoint(path: &str, fds: &FdTable) -> Option<Result<io::Endpoint, i32>> {
    let fd = match path {
        "/dev/stdin" => 0,
        "/dev/stdout" => 1,
        "/dev/stderr" => 2,
        _ => path.strip_prefix("/dev/fd/")?.parse::<u32>().ok()?,
    };
    Some(fds.get(fd).ok_or(1))
}
fn expansion_work(limits: &Limits) -> expand::Work {
    expand::Work::new(
        limits
            .source_bytes
            .saturating_add(limits.expansion_bytes)
            .saturating_add(limits.arguments),
        limits.expansion_bytes,
        limits.arguments,
    )
}
/// Expansion work that can run command substitutions with `fds` (the
/// descriptors in effect before the command's own redirections).
fn substitution_work(context: &Context, fds: &Descriptors) -> expand::Work {
    let mut work = expansion_work(context.limits());
    work.substitutions = Some(Substitutions {
        context: context.clone(),
        fds: fds.clone(),
    });
    work
}

/// Runs `$(...)` bodies as subshell tasks. Expansion work carries one while it
/// expands a command's words; it is taken out before dispatch so its
/// descriptor reference cannot keep a pipe endpoint open during the command.
#[derive(Clone)]
pub(crate) struct Substitutions {
    context: Context,
    fds: Descriptors,
}
impl Substitutions {
    /// Start `commands` in an isolated copy of `state`, with stdout on a new
    /// pipe whose reader is returned. The body runs as its own executor task,
    /// so nested substitutions add no native or WASM stack depth.
    pub(crate) fn start(
        &self,
        commands: Vec<Command>,
        state: SharedState,
    ) -> Result<(io::Endpoint, SubstitutionTask), i32> {
        self.context.core.reap_internal_jobs();
        if !self.context.core.has_job_capacity() {
            return Err(2);
        }
        let allocation = admit_job(&self.context).map_err(admission_status)?;
        self.context.core.reap_completed_jobs();
        let (reader, writer) = self.context.fs().pipe().map_err(|error| error.status())?;
        let child = state;
        let mut table = self.fds.borrow().clone();
        table.insert(1, writer);
        let fds = Rc::new(RefCell::new(table));
        let cancel = Cancel::new();
        let group = self.context.core.host.allocate_background_group();
        let signal = Rc::new(Cell::new(None));
        let parent = self.context.cancel.clone();
        let parent_signal = self.context.signal.clone();
        let parent_scope = self.context.scope.clone();
        let context = Context {
            cancel: cancel.clone(),
            signal: signal.clone(),
            group,
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let link = cancel.clone();
        let link_signal = signal.clone();
        let capture_complete = Cancel::new();
        let captured = capture_complete.clone();
        let (complete, completion) = futures::channel::oneshot::channel();
        let join = self.context.core.executor.spawn(async move {
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let body = async {
                let result = sequence(commands, child, fds, context.clone()).await;
                // Capturing waits for actual stdout EOF, not every background
                // job: redirected descendants may keep running after EOF.
                if context.cancel.run(captured.cancelled()).await.is_err() {
                    context.cleanup_jobs().await;
                }
                context.finish_scope(parent_scope).await;
                let code = if context.cancel.is_cancelled() {
                    context.cancel_status()
                } else {
                    result.code
                };
                // EOF releases capture, while this registered supervisor keeps
                // cleanup ownership of any host descendants still running.
                let _ = complete.send(code);
                context.finish_group(&mut processes, code).await
            };
            // The parent's cancellation reaches the body through its own
            // token; the body still unwinds normally and reports its status.
            let forward = async {
                parent.cancelled().await;
                if link_signal.get().is_none() {
                    link_signal.set(Some(parent_signal.get().unwrap_or(2)));
                }
                link.cancel();
                futures::future::pending::<()>().await
            };
            futures::pin_mut!(body, forward);
            match futures::future::select(body, forward).await {
                futures::future::Either::Left((code, _)) => code,
                futures::future::Either::Right(((), body)) => body.await,
            }
        });
        let core = &self.context.core;
        let id = JobId(core.allocate_id());
        core.jobs.borrow_mut().insert(
            id,
            Job {
                owner: self.context.scope.clone(),
                kind: JobKind::Internal,
                group,
                cancel: cancel.clone(),
                signal: signal.clone(),
                join: join.clone(),
                _allocation: Some(allocation),
            },
        );
        Ok((
            reader,
            SubstitutionTask {
                cancel,
                capture_complete,
                join,
                completion,
                signal,
                parent_signal: self.context.signal.clone(),
                core: core.clone(),
                id,
                finished: false,
            },
        ))
    }
    /// Start `<(commands)` (`is_input`) or `>(commands)` as a job of this
    /// shell and open its end of the pipe in the command's descriptor table,
    /// at the highest free descriptor from 63 down, as bash does. Returns
    /// that descriptor; the caller expands it to `/dev/fd/N`. The table is
    /// the command's own copy, so the descriptor closes with the command.
    pub(crate) fn process<'a>(
        &'a self,
        commands: Vec<Command>,
        is_input: bool,
        state: SharedState,
        parent_state: &'a SharedState,
        work: &'a mut expand::Work,
    ) -> eval::Frame<'a, Result<u32, i32>> {
        self.context.evaluation.frame(
            self.process_body(commands, is_input, state, parent_state, work),
            Err,
        )
    }

    async fn process_body(
        &self,
        commands: Vec<Command>,
        is_input: bool,
        state: SharedState,
        parent_state: &SharedState,
        work: &mut expand::Work,
    ) -> Result<u32, i32> {
        let fd = (3..=63u32)
            .rev()
            .find(|fd| self.fds.borrow().get(*fd).is_none())
            .ok_or(2)?;
        let core = &self.context.core;
        core.reap_internal_jobs();
        if !core.has_job_capacity() {
            return Err(2);
        }
        let job = JobId(core.allocate_id());
        let identity = async_identity(job, &self.context.cancel, work)
            .await
            .map_err(admission_status)?;
        let allocation = admit_job(&self.context).map_err(admission_status)?;
        core.reap_completed_jobs();
        if core.jobs.borrow().len() >= self.context.limits().jobs {
            return Err(2);
        }
        let (reader, writer) = self.context.fs().pipe().map_err(|error| error.status())?;
        let mut table = self.fds.borrow().clone();
        let parent_end = if is_input {
            table.insert(1, writer);
            reader
        } else {
            table.insert(0, reader);
            writer
        };
        let fds = Rc::new(RefCell::new(table));
        let child = state;
        let cancel = Cancel::new();
        let group = core.host.allocate_background_group();
        let signal = Rc::new(Cell::new(None));
        let context = Context {
            cancel: cancel.clone(),
            signal: signal.clone(),
            group,
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let parent = self.context.cancel.clone();
        let parent_signal = self.context.signal.clone();
        let link = cancel.clone();
        let link_signal = signal.clone();
        let join = core.executor.spawn(async move {
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let body = async {
                let result = sequence(commands, child, fds, context.clone()).await;
                let _ = context.wait_jobs(None, true).await;
                context.cleanup_jobs().await;
                context.finish_group(&mut processes, result.code).await
            };
            let forward = async {
                parent.cancelled().await;
                if link_signal.get().is_none() {
                    link_signal.set(Some(parent_signal.get().unwrap_or(2)));
                }
                link.cancel();
                futures::future::pending::<()>().await
            };
            futures::pin_mut!(body, forward);
            match futures::future::select(body, forward).await {
                futures::future::Either::Left((code, _)) => code,
                futures::future::Either::Right(((), body)) => body.await,
            }
        });
        core.jobs.borrow_mut().insert(
            job,
            Job {
                owner: self.context.scope.clone(),
                kind: JobKind::ProcessSubstitution,
                group,
                cancel,
                signal,
                join,
                _allocation: Some(allocation),
            },
        );
        self.fds.borrow_mut().insert(fd, parent_end);
        parent_state.borrow_mut().last_async = Some(identity);
        Ok(fd)
    }
    /// Standard error of the shell running the substitution.
    pub(crate) fn stderr(&self) -> Option<io::Endpoint> {
        self.fds.borrow().get(2)
    }
    pub(crate) fn cancel(&self) -> &Cancel {
        &self.context.cancel
    }
}
/// Capture completion follows EOF. The registered join separately owns group
/// reaping; cancellation/errors drain it before releasing the capture.
pub(crate) struct SubstitutionTask {
    cancel: Cancel,
    capture_complete: Cancel,
    join: JoinHandle<i32>,
    completion: futures::channel::oneshot::Receiver<i32>,
    signal: Rc<Cell<Option<i32>>>,
    parent_signal: Rc<Cell<Option<i32>>>,
    core: Rc<Core>,
    id: JobId,
    finished: bool,
}
impl SubstitutionTask {
    pub(crate) fn cancel(&self) {
        if self.signal.get().is_none() {
            self.signal.set(Some(self.parent_signal.get().unwrap_or(2)));
        }
        self.cancel.cancel();
    }
    pub(crate) async fn finish(mut self) -> i32 {
        self.capture_complete.cancel();
        let code = (&mut self.completion).await.unwrap_or(130);
        if self.cancel.is_cancelled() {
            self.join.clone().await;
        }
        if self.join.is_finished() {
            self.core.jobs.borrow_mut().remove(&self.id);
        }
        self.finished = true;
        code
    }
}
impl Drop for SubstitutionTask {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel();
        }
    }
}

/// Function words already retain raw spelling. For top-level declarations use
/// the unchanged lexer's raw-capture API on this command's bounded source span.
/// AST order supplies assignment/argument counts; operators stay lexer-owned.
async fn retain_declaration_syntax(
    simple: &mut SimpleCommand,
    source: &str,
    cancel: &Cancel,
) -> Result<(), i32> {
    if simple.name.raw.is_some() || !builtins::declaration_command(&simple.name) {
        return Ok(());
    }
    let source = source
        .get(simple.span.start.offset..simple.span.end.offset)
        .ok_or(2)?;
    let mut lexer = Lexer::new(source);
    lexer.set_capture_raw(true);
    let mut assignments = simple.assignments.len();
    let mut words = std::iter::once(&mut simple.name).chain(simple.args.iter_mut());
    let mut target = words.next();
    let mut redirect_operand = false;
    let mut budget = Budget::default();
    while let Some(token) = lexer.next_spanned_token() {
        budget.checkpoint(cancel).await.map_err(|_| 130)?;
        let Some(raw) = token.raw else {
            let spelling = &source[token.span.start.offset..token.span.end.offset];
            redirect_operand = spelling.ends_with(['<', '>'])
                || spelling.ends_with(">|")
                || spelling.ends_with(">&")
                || spelling.ends_with("<&");
            continue;
        };
        if redirect_operand {
            redirect_operand = false;
            continue;
        }
        if assignments > 0 {
            assignments -= 1;
            continue;
        }
        let word = target.take().ok_or(2)?;
        word.raw = Some(raw);
        target = words.next();
        if target.is_none() {
            return Ok(());
        }
    }
    Err(2)
}

struct PreparedCommand {
    argv: Vec<String>,
    assigned: Vec<(String, String)>,
    fds: Descriptors,
    work: expand::Work,
}

/// Prefix assignments for a builtin live for the builtin call and restore on
/// every exit path. The guard owns prior mutations before any later admission
/// or alias-resolution failure can unwind the call.
struct BuiltinPrefixFrame {
    state: SharedState,
    saved: BTreeMap<String, Option<String>>,
}
impl BuiltinPrefixFrame {
    async fn enter(
        state: SharedState,
        assigned: &[(String, String)],
        context: &Context,
        work: &mut expand::Work,
    ) -> Result<Self, expand::Error> {
        for (name, value) in assigned {
            State::admit_assignment(&state, name, value.len(), &context.cancel, work).await?;
        }
        let mut frame = Self {
            state: state.clone(),
            saved: BTreeMap::new(),
        };
        {
            let mut state_ref = state.borrow_mut();
            for (name, value) in assigned {
                work.admit_storage(name.len())?;
                let target = state_ref.assignment_name(name.clone()).map_err(|_| 2)?;
                if !frame.saved.contains_key(&target) {
                    work.admit_storage(
                        (std::mem::size_of::<(String, Option<String>)>()
                            + std::mem::size_of::<usize>())
                        .saturating_mul(16),
                    )?;
                }
                if !state_ref.variables.contains_key(&target) {
                    work.admit_storage(
                        (std::mem::size_of::<(String, String)>() + std::mem::size_of::<usize>())
                            .saturating_mul(16),
                    )?;
                }
                work.admit_storage(target.len().saturating_add(value.len()))?;
                let previous = state_ref.variables.insert(target.clone(), value.clone());
                frame.saved.entry(target).or_insert(previous);
            }
        }
        Ok(frame)
    }
}
impl Drop for BuiltinPrefixFrame {
    fn drop(&mut self) {
        let mut state = self.state.borrow_mut();
        for (name, value) in std::mem::take(&mut self.saved) {
            match value {
                Some(value) => {
                    state.variables.insert(name, value);
                }
                None => {
                    state.variables.remove(&name);
                }
            }
        }
    }
}

async fn simple_command(
    simple: SimpleCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let line = simple.expansion_line;
    let original_fds = fds.clone();
    let prepared = match prepare_simple_command(simple, &state, fds, &context).await {
        Ok(prepared) => prepared,
        Err(error) => return expansion_failure(error.at_line(line), &original_fds, &context).await,
    };
    if prepared.argv.first().is_some_and(|name| name == "exec") {
        if prepared.argv.len() != 1 || !prepared.assigned.is_empty() {
            return Outcome::status(2);
        }
        *original_fds.borrow_mut() = prepared.fds.borrow().clone();
        return Outcome::status(0);
    }
    // Even a saved stderr can alias a pipe reader. Release all diagnostic-only
    // ownership before dispatch, so a child's close can deliver EPIPE promptly.
    drop(original_fds);
    dispatch_simple_command(prepared, state, context)
        .await
        .unwrap_or_else(Outcome::status)
}

#[inline(never)]
fn prepare_simple_command<'a>(
    simple: SimpleCommand,
    state: &'a SharedState,
    fds: Descriptors,
    context: &'a Context,
) -> eval::Frame<'a, Result<PreparedCommand, CommandError>> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        prepare_simple_command_body(simple, state, fds, context),
        |code| Err(code.into()),
    )
}

async fn prepare_simple_command_body(
    mut simple: SimpleCommand,
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
) -> Result<PreparedCommand, CommandError> {
    retain_declaration_syntax(&mut simple, &context.source, &context.cancel).await?;
    let assignment_count = simple.assignments.len();
    if assignment_count > context.limits().arguments {
        return Err(2.into());
    }
    let mut bytes = 0usize;
    let mut budget = Budget::default();
    // Process substitutions open descriptors for this command only.
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let mut work = substitution_work(context, &fds);
    let mut argv = expand::fields(
        &simple.name,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        context.limits().arguments - assignment_count,
        context.limits().expansion_bytes,
        &mut work,
    )
    .await?;
    bytes += argv.iter().map(String::len).sum::<usize>();
    let declaration = builtins::declaration_command(&simple.name);
    for word in simple.args {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let remaining_bytes = context.limits().expansion_bytes.saturating_sub(bytes);
        let remaining_words = context
            .limits()
            .arguments
            .saturating_sub(assignment_count)
            .saturating_sub(argv.len());
        let fields = if declaration && builtins::assignment_operand(&word) {
            if remaining_words == 0 {
                return Err(2.into());
            }
            let value = expand::word(
                &word,
                state,
                &context.cancel,
                remaining_bytes,
                context.limits().expansion_bytes,
                &mut work,
            )
            .await?;
            work.consume_scalar_field();
            vec![value]
        } else {
            expand::fields(
                &word,
                state,
                &context.cancel,
                remaining_bytes,
                remaining_words,
                context.limits().expansion_bytes,
                &mut work,
            )
            .await?
        };
        bytes += fields.iter().map(String::len).sum::<usize>();
        argv.extend(fields);
    }
    // Bash expands command words first. Assignment-only commands then assign
    // before redirects; named commands redirect before expanding prefix RHSs.
    if argv.is_empty() {
        assignments(
            simple.assignments,
            state,
            context,
            &mut bytes,
            &mut work,
            true,
        )
        .await?;
        let fds = redirects(&simple.redirects, state, fds, context, &mut work, Some(1)).await?;
        work.substitutions = None;
        return Ok(PreparedCommand {
            argv,
            assigned: Vec::new(),
            fds,
            work,
        });
    }
    let name = &argv[0];
    let shell_command = state.borrow().functions.contains_key(name)
        || matches!(name.as_str(), "exec" | "let" | "eval")
        || (builtins::is_builtin(name) && !matches!(name.as_str(), "cat" | "seq"));
    let heredoc_status = (!shell_command).then_some(context.parameter_error_status);
    let fds = redirects(
        &simple.redirects,
        state,
        fds,
        context,
        &mut work,
        heredoc_status,
    )
    .await?;
    let assigned = assignments(
        simple.assignments,
        state,
        context,
        &mut bytes,
        &mut work,
        false,
    )
    .await?;
    work.substitutions = None;
    Ok(PreparedCommand {
        argv,
        assigned,
        fds,
        work,
    })
}

#[inline(never)]
fn dispatch_simple_command(
    prepared: PreparedCommand,
    state: SharedState,
    context: Context,
) -> eval::Frame<'static, Result<Outcome, i32>> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(dispatch_simple_command_body(prepared, state, context), Err)
}

async fn dispatch_simple_command_body(
    prepared: PreparedCommand,
    state: SharedState,
    context: Context,
) -> Result<Outcome, i32> {
    let PreparedCommand {
        argv,
        assigned,
        fds,
        mut work,
    } = prepared;
    let mut fields = argv.into_iter();
    let Some(name) = fields.next() else {
        // A command with no words left takes the status of the last command
        // substitution it ran (words, then redirects and assignments).
        return Ok(Outcome::status(work.substitution_status.unwrap_or(0)));
    };
    let args: Vec<_> = fields.collect();
    // Prefix assignments for external commands belong only to their environment.
    // Function prefix assignments remain deferred until full Bash rules.
    let function = state.borrow().functions.get(&name).cloned();
    if let Some(body) = function {
        if !assigned.is_empty() {
            return Err(2);
        }
        // Function syntax has a source-size budget independent of argv bytes.
        // Admit its execution copy before cloning even with a tiny argv ceiling.
        let source_bytes = context.limits().source_bytes;
        let mut copy_work = expand::Work::new(source_bytes, source_bytes, 0);
        if let Err(error) =
            crate::ast_copy::command(body.body.as_ref(), &context.cancel, &mut copy_work).await
        {
            return Ok(expansion_failure(error.into(), &fds, &context).await);
        }
        let frame = FunctionFrame::enter(state.clone(), args, context.limits().function_depth)?;
        let context = Context {
            evaluation: context
                .evaluation
                .clone()
                .with_retained(body.storage.clone()),
            ..context
        };
        // A boxed await still polls recursively. Join a separate task so both
        // polling and dropping one call stop at its handle, with unchanged depth.
        let task_allocation = Rc::new(
            admit_task_metadata::<JoinHandle<Outcome>>(&context, 1).map_err(admission_status)?,
        );
        let allocation = task_allocation.clone();
        let executor = context.core.executor.clone();
        let evaluation = context.evaluation.clone();
        let call = evaluation.frame(
            async move {
                let _frame = frame;
                let _allocation = allocation;
                execute(body.body.as_ref().clone(), state, fds, context).await
            },
            Outcome::status,
        );
        let mut outcome = match call {
            futures::future::Either::Left(outcome) => outcome.await,
            futures::future::Either::Right(body) => executor.spawn(body).await,
        };
        drop(task_allocation);
        if outcome.flow == Flow::Return {
            outcome.flow = Flow::Normal;
        }
        return Ok(outcome);
    }
    if name == "let" {
        if !assigned.is_empty() {
            return Err(2);
        }
        return Ok(let_command(args, state, fds, context, work).await);
    }
    if name == "eval" {
        if !assigned.is_empty() {
            return Err(2);
        }
        return Ok(eval::run(args, state, fds, context).await);
    }
    if builtins::is_builtin(&name) {
        let _frame = BuiltinPrefixFrame::enter(state.clone(), &assigned, &context, &mut work)
            .await
            .map_err(admission_status)?;
        let bindings = fds.borrow().clone();
        return builtins::run(&name, args, state, bindings, context, &mut work).await;
    }
    // A pipe named by an open descriptor exists but cannot be executed.
    if name.starts_with("/dev/fd/")
        && device_endpoint(&name, &fds.borrow()).is_some_and(|endpoint| endpoint.is_ok())
    {
        let diagnostic = format!("/usr/bin/bash: {name}: Permission denied\n");
        let stderr = fds.borrow().get(2);
        if let Some(stderr) = stderr {
            let _ = stderr
                .write_all(diagnostic.as_bytes(), &context.cancel)
                .await;
        }
        return Ok(Outcome::status(126));
    }
    let (mut env, cwd) = {
        let s = state.borrow();
        (s.environment(), s.cwd.clone())
    };
    env.extend(assigned);
    let mut argv = vec![name];
    argv.extend(args);
    let pid = context
        .core
        .host
        .spawn(SpawnRequest {
            argv,
            env,
            cwd,
            fds: fds.borrow().clone(),
            group: context.group,
            parent: None,
        })
        .map_err(|_| 127)?;
    // The child owns its inherited descriptors. Shell-side stage copies must
    // not keep a closed child reader/writer alive while waiting for its exit.
    drop(fds);
    match context.cancel.run(context.core.host.wait(pid)).await {
        Ok(result) => Ok(Outcome::status(result.map_err(|_| 1)?)),
        Err(_) => {
            context
                .core
                .host
                .kill(pid, context.stop_signal())
                .map_err(|_| 1)?;
            context.core.host.wait(pid).await.map_err(|_| 1)?;
            Err(context.cancel_status())
        }
    }
}

#[inline(never)]
fn let_command(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    mut work: expand::Work,
) -> eval::Frame<'static, Outcome> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        async move {
            if args.is_empty() {
                return arithmetic_command("()", &state, &fds, &context, &mut work).await;
            }
            let mut result = Outcome::status(0);
            for source in &args {
                let value = crate::arithmetic::evaluate_literal(
                    source,
                    &state,
                    &context.cancel,
                    context.limits().expansion_bytes,
                    &mut work,
                )
                .await;
                result = match value {
                    Ok(value) => Outcome::status(i32::from(value == 0)),
                    Err(error) => return literal_arithmetic_failure(error, &fds, &context).await,
                };
            }
            result
        },
        Outcome::status,
    )
}

async fn literal_arithmetic_failure(
    error: expand::Error,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let ordinary = matches!(
        error,
        expand::Error::Arithmetic {
            expansion: false,
            ..
        } | expand::Error::Readonly {
            expansion: false,
            ..
        }
    );
    let mut result = expansion_failure(error.into(), fds, context).await;
    if ordinary {
        result.flow = Flow::Normal;
    }
    result
}

#[inline(never)]
fn builtin_command(
    name: String,
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    mut work: expand::Work,
) -> eval::Frame<'static, Result<Outcome, i32>> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        async move {
            let bindings = fds.borrow().clone();
            builtins::run(&name, args, state, bindings, context, &mut work).await
        },
        Err,
    )
}
async fn assignments(
    assignments: Vec<Assignment>,
    state: &SharedState,
    context: &Context,
    bytes: &mut usize,
    work: &mut expand::Work,
    commit: bool,
) -> Result<Vec<(String, String)>, expand::Error> {
    if assignments.is_empty() {
        return Ok(Vec::new());
    }
    let frame = PrefixFrame::enter(state.clone());
    let mut names = Vec::new();
    let initial_bytes = *bytes;
    let mut budget = Budget::default();
    for assignment in assignments {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if assignment.index.is_some() || assignment.append {
            return Err(2.into());
        }
        let AssignmentValue::Scalar(word) = assignment.value else {
            return Err(2.into());
        };
        let value = expand::word(
            &word,
            state,
            &context.cancel,
            context
                .limits()
                .expansion_bytes
                .saturating_sub(*bytes)
                .saturating_sub(assignment.name.len().saturating_add(1)),
            context.limits().expansion_bytes,
            work,
        )
        .await?;
        *bytes = bytes
            .saturating_add(assignment.name.len())
            .saturating_add(1)
            .saturating_add(value.len());
        if *bytes > context.limits().expansion_bytes {
            return Err(2.into());
        }
        expand::admit_assignment(state, &assignment.name, value.len(), &context.cancel, work)
            .await?;
        names.push(assignment.name.clone());
        if let Err(name) = frame.set(assignment.name, value) {
            work.admit_storage(name.len().saturating_add(160))?;
            return Err(expand::Error::Readonly {
                name,
                line: None,
                expansion: true,
            });
        }
    }
    let mut assigned = Vec::new();
    *bytes = initial_bytes;
    for name in names {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let state = state.borrow();
        let value = state.scalar_parameter(&name).ok_or(2)?;
        *bytes = bytes
            .saturating_add(name.len())
            .saturating_add(1)
            .saturating_add(value.len());
        if *bytes > context.limits().expansion_bytes {
            return Err(2.into());
        }
        if !commit {
            assigned.push((name, value.to_owned()));
        }
    }
    if commit {
        frame.commit();
    }
    Ok(assigned)
}

async fn redirect_target(
    redirect: &Redirect,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
    reader_state: Option<&SharedState>,
) -> Result<String, expand::Error> {
    let reader = reader_state.cloned().unwrap_or_else(|| state.clone());
    expand::word(
        &redirect.target,
        &reader,
        &context.cancel,
        context.limits().expansion_bytes,
        context.limits().expansion_bytes,
        work,
    )
    .await
}

async fn redirects(
    redirs: &[Redirect],
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
    work: &mut expand::Work,
    heredoc_status: Option<i32>,
) -> Result<Descriptors, CommandError> {
    if redirs.is_empty() {
        return Ok(fds);
    }
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    // Target substitutions observe the redirections already applied, and
    // process substitutions insert their descriptors into this same table.
    if let Some(runner) = &mut work.substitutions {
        runner.fds = fds.clone();
    }
    let mut budget = Budget::default();
    // External and unnamed commands use one isolated reader shell for all
    // their here-documents. Each target sees the previous target's completed
    // assignments, while the snapshot remains detached from the caller.
    let mut reader_state: Option<SharedState> = None;
    for redirect in redirs {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if redirect.fd_var.is_some() {
            return Err(2.into());
        }
        let reader_status = if matches!(
            redirect.kind,
            RedirectKind::HereDoc | RedirectKind::HereDocStrip
        ) {
            heredoc_status
        } else {
            None
        };
        let expands = redirect
            .target
            .parts
            .iter()
            .any(|part| !matches!(part, WordPart::Literal(_)));
        if reader_status.is_some() && expands && reader_state.is_none() {
            reader_state = Some(
                State::snapshot(state, &context.cancel, work)
                    .await
                    .map_err(|error| {
                        CommandError::redirect(
                            error.at_line(redirect.expansion_line),
                            fds.borrow().get(2),
                            reader_status,
                        )
                    })?
                    .shared(),
            );
        }
        let target_reader = reader_status.and_then(|_| reader_state.as_ref());
        let target = redirect_target(redirect, state, context, work, target_reader)
            .await
            .map_err(|error| {
                CommandError::redirect(
                    error.at_line(redirect.expansion_line),
                    fds.borrow().get(2),
                    reader_status,
                )
            })?;
        let input = matches!(
            redirect.kind,
            RedirectKind::Input
                | RedirectKind::DupInput
                | RedirectKind::HereDoc
                | RedirectKind::HereDocStrip
                | RedirectKind::HereString
                | RedirectKind::ReadWrite
        );
        let fd = redirect.fd.unwrap_or(if input { 0 } else { 1 });
        let fd = u32::try_from(fd).map_err(|_| 2)?;
        match redirect.kind {
            RedirectKind::DupInput | RedirectKind::DupOutput => {
                if target == "-" {
                    fds.borrow_mut().remove(fd);
                } else {
                    let source = target.parse::<u32>().map_err(|_| 2)?;
                    let endpoint = fds.borrow().get(source).ok_or(1)?;
                    fds.borrow_mut().insert(fd, endpoint);
                }
            }
            RedirectKind::HereDoc | RedirectKind::HereDocStrip | RedirectKind::HereString => {
                work.admit_storage(io::buffered_input_metadata_bytes())?;
                // The parser already removed `<<-` tabs; the body expanded
                // like a double-quoted word. A here-string gains a newline.
                let mut text = target;
                if redirect.kind == RedirectKind::HereString {
                    work.admit_storage(1)?;
                    text.try_reserve_exact(1).map_err(|_| 2)?;
                    text.push('\n');
                }
                fds.borrow_mut()
                    .insert(fd, io::Endpoint::bytes(text.into_bytes()));
            }
            RedirectKind::Input
            | RedirectKind::Output
            | RedirectKind::Clobber
            | RedirectKind::Append
            | RedirectKind::OutputBoth
            | RedirectKind::ReadWrite => {
                let device = device_endpoint(&target, &fds.borrow());
                if let Some(endpoint) = device {
                    let endpoint = endpoint?;
                    if redirect.kind == RedirectKind::OutputBoth {
                        fds.borrow_mut().insert(2, endpoint.clone());
                    }
                    fds.borrow_mut().insert(fd, endpoint);
                    continue;
                }
                let path = absolute(&state.borrow().cwd, &target);
                let read_write = redirect.kind == RedirectKind::ReadWrite;
                let options = OpenOptions {
                    read: input,
                    write: !input || read_write,
                    create: !input || read_write,
                    truncate: matches!(
                        redirect.kind,
                        RedirectKind::Output | RedirectKind::Clobber | RedirectKind::OutputBoth
                    ),
                    append: redirect.kind == RedirectKind::Append,
                };
                let endpoint = context
                    .cancel
                    .run(context.fs().open(&path, &options))
                    .await
                    .map_err(|_| 130)?
                    .map_err(|e| e.status())?;
                if redirect.kind == RedirectKind::OutputBoth {
                    fds.borrow_mut().insert(2, endpoint.clone());
                }
                fds.borrow_mut().insert(fd, endpoint);
            }
        }
    }
    Ok(fds)
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::{io::MemoryFs, process::InProcessHost};
    use futures::FutureExt;

    fn replay_context() -> (SharedState, Descriptors, Context) {
        let executor = Executor::new();
        let host = Rc::new(InProcessHost::new(executor.clone()));
        let group = host.allocate_group();
        let session = Session::new(
            executor,
            host,
            Rc::new(MemoryFs::new(4096)),
            Limits::default(),
        );
        let context = Context {
            evaluation: eval::Scope::new(&session.core.limits, session.core.eval_storage.clone()),
            core: session.core.clone(),
            source: eval::Source::root(""),
            cancel: Cancel::new(),
            signal: Rc::new(Cell::new(None)),
            group,
            scope: Scope::new(0),
            parameter_error_status: 127,
            compound_child: false,
        };
        (session.state(), session.core.descriptors.clone(), context)
    }

    fn finish_replay(future: impl std::future::Future<Output = Outcome>) -> Outcome {
        futures::pin_mut!(future);
        for _ in 0..1000 {
            if let Some(outcome) = future.as_mut().now_or_never() {
                return outcome;
            }
        }
        panic!("arithmetic replay exceeded bounded polls");
    }

    #[test]
    fn borrowed_arithmetic_replay_preserves_execution_depth_and_status() {
        for (depth, code) in [(255, 0), (256, 2)] {
            let (state, fds, mut context) = replay_context();
            state.borrow_mut().status = 13;
            state.borrow_mut().pipestatus = vec![9, 13];
            for _ in 0..depth {
                context.evaluation = context.evaluation.descend().unwrap();
            }
            let commands = [Command::Compound(
                CompoundCommand::Arithmetic("n=7".into()),
                Vec::new(),
            )];
            let outcome = finish_replay(loop_sequence(&commands, &state, &fds, &context, None));
            assert_eq!(outcome.code, code);
            assert_eq!(outcome.flow, Flow::Normal);
            assert_eq!(state.borrow().variables.contains_key("n"), code == 0);
            assert_eq!(state.borrow().status, if code == 0 { 0 } else { 13 });
            assert_eq!(
                state.borrow().pipestatus,
                if code == 0 { vec![0] } else { vec![9, 13] }
            );
        }
    }

    #[test]
    fn borrowed_arithmetic_replay_admits_its_frame_and_releases_it_on_drop() {
        let (state, fds, context) = replay_context();
        let limit =
            usize::try_from(shell_parser::limits::ExecutionLimits::default().max_work_units)
                .unwrap();
        let allocation = context.evaluation.admit_execution(limit).unwrap();
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("n=7".into()),
            Vec::new(),
        )];
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            2
        );
        assert!(!state.borrow().variables.contains_key("n"));
        drop(allocation);
        let replay = loop_sequence(&commands, &state, &fds, &context, None);
        assert!(context.evaluation.admit_execution(limit).is_err());
        drop(replay);
        drop(context.evaluation.admit_execution(limit).unwrap());
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            0
        );
        assert_eq!(state.borrow().variables["n"], "7");
        drop(context.evaluation.admit_execution(limit).unwrap());
    }

    #[test]
    fn borrowed_arithmetic_replay_keeps_compound_context_and_pre_cancel_checks() {
        let (state, fds, mut context) = replay_context();
        context.compound_child = true;
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("${missing:?required}".into()),
            Vec::new(),
        )];
        let outcome = finish_replay(loop_sequence(&commands, &state, &fds, &context, None));
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.flow, Flow::Abort);
        assert_eq!(context.parameter_error_status, 127);
        context.cancel.cancel();
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            130
        );
    }

    #[test]
    fn borrowed_arithmetic_replay_keeps_command_storage_admission() {
        let (state, fds, mut context) = replay_context();
        Rc::get_mut(&mut context.core)
            .unwrap()
            .limits
            .expansion_bytes = 0;
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("n=7".into()),
            Vec::new(),
        )];
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            2
        );
        assert!(!state.borrow().variables.contains_key("n"));
        assert_eq!(state.borrow().pipestatus, vec![2]);
    }

    #[test]
    fn later_descendant_transfers_follow_already_forwarded_parent_handles() {
        let root = Scope::new(0);
        let outer = Scope::new(1);
        let middle = Scope::new(2);
        let inner = Scope::new(3);
        let captured_outer = outer.clone();
        let captured_middle = middle.clone();
        outer.forward_to(root);
        middle.forward_to(captured_outer);
        inner.forward_to(captured_middle);
        assert_eq!(inner.resolved_id(), 0);
    }

    #[test]
    fn successive_background_handoffs_do_not_retain_exited_ancestors() {
        let mut parent = Scope::new(0);
        for id in 1..1000 {
            let child = Scope::new(id);
            child.forward_to(parent);
            assert_eq!(child.0.parent.borrow().as_ref().unwrap().0.id, 0);
            parent = child;
        }
        assert_eq!(parent.resolved_id(), 0);
    }

    #[test]
    fn earlier_descendant_transfers_follow_later_ancestor_exits() {
        let root = Scope::new(0);
        let outer = Scope::new(1);
        let middle = Scope::new(2);
        let inner = Scope::new(3);
        inner.forward_to(middle.clone());
        middle.forward_to(outer.clone());
        assert_eq!(inner.resolved_id(), 1);
        outer.forward_to(root);
        assert_eq!(inner.resolved_id(), 0);
    }
}
