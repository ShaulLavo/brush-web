//! Original task-oriented interpreter for the engine gate, not a Bashkit
//! interpreter fork. Unsupported syntax returns status 2 rather than guessing.
use crate::{
    builtins,
    executor::{Budget, Cancel, Executor, JoinHandle, yield_now},
    expand,
    io::{self, FdTable, FileSystem, OpenOptions},
    process::{GroupId, ProcessGroup, ProcessHost, SpawnRequest},
    state::{FunctionFrame, PrefixFrame, SharedState, State, absolute},
};
use futures::{
    FutureExt,
    future::{LocalBoxFuture, join_all},
};
use shell_parser::parser::*;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

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
}
impl CommandError {
    fn at_line(mut self, line: Option<usize>) -> Self {
        self.error = self.error.at_line(line);
        self
    }
    fn redirect(error: expand::Error, stderr: Option<io::Endpoint>) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Redirected(stderr),
        }
    }
}
impl From<expand::Error> for CommandError {
    fn from(error: expand::Error) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Inherited,
        }
    }
}
impl From<i32> for CommandError {
    fn from(code: i32) -> Self {
        expand::Error::Status(code).into()
    }
}

type Descriptors = Rc<RefCell<FdTable>>;
struct Job {
    owner: u64,
    cancel: Cancel,
    join: JoinHandle<i32>,
}
struct Core {
    executor: Executor,
    host: Rc<dyn ProcessHost>,
    fs: Rc<dyn FileSystem>,
    limits: Limits,
    descriptors: Descriptors,
    jobs: RefCell<BTreeMap<u64, Job>>,
    next: Cell<u64>,
    next_job: Cell<u64>,
    foreground: RefCell<Option<Job>>,
}
#[derive(Clone)]
pub(crate) struct Context {
    core: Rc<Core>,
    source: Rc<str>,
    pub cancel: Cancel,
    pub group: GroupId,
    scope: u64,
    parameter_error_status: i32,
    compound_child: bool,
}
impl Context {
    pub(crate) fn fs(&self) -> &dyn FileSystem {
        self.core.fs.as_ref()
    }
    pub(crate) fn limits(&self) -> &Limits {
        &self.core.limits
    }
    fn isolated(&self) -> Self {
        Self {
            scope: self.core.allocate_id(),
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
        let jobs: Vec<_> = self
            .core
            .jobs
            .borrow()
            .iter()
            .filter(|(_, job)| job.owner == self.scope)
            .map(|(&id, job)| {
                job.cancel.cancel();
                (id, job.join.clone())
            })
            .collect();
        for (id, join) in jobs {
            join.await;
            self.core.jobs.borrow_mut().remove(&id);
        }
    }
    async fn finish_group(&self, processes: &mut ProcessGroup, code: i32) -> i32 {
        let finished = self.cancel.run(processes.finish()).await;
        match finished {
            Ok(Ok(_)) => code,
            Ok(Err(_)) => 1,
            Err(_) => processes.terminate(2).await.map(|_| 130).unwrap_or(1),
        }
    }
    pub(crate) async fn wait_job(&self, id: Option<u64>) -> Result<i32, i32> {
        let jobs: Vec<_> = self
            .core
            .jobs
            .borrow()
            .iter()
            .filter(|(key, job)| job.owner == self.scope && id.is_none_or(|id| id == **key))
            .map(|(id, job)| (*id, job.join.clone()))
            .collect();
        if id.is_some() && jobs.is_empty() {
            return Err(127);
        }
        let mut code = 0;
        for (id, job) in jobs {
            code = self.cancel.run(job).await.map_err(|_| 130)?;
            self.core.jobs.borrow_mut().remove(&id);
        }
        Ok(code)
    }
    pub(crate) fn kill_job(&self, id: u64) -> Result<(), i32> {
        let jobs = self.core.jobs.borrow();
        let job = jobs
            .get(&id)
            .filter(|job| job.owner == self.scope)
            .ok_or(1)?;
        job.cancel.cancel();
        Ok(())
    }
}
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
                limits,
                descriptors: Rc::new(RefCell::new(FdTable::default())),
                jobs: RefCell::new(BTreeMap::new()),
                next: Cell::new(1),
                next_job: Cell::new(1),
                foreground: RefCell::new(None),
            }),
            state: State::default().shared(),
        }
    }
    pub fn state(&self) -> SharedState {
        self.state.clone()
    }
    pub fn background_jobs(&self) -> usize {
        self.core.jobs.borrow().len()
    }
    pub fn interrupt(&self) {
        if let Some(job) = self.core.foreground.borrow().as_ref() {
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
    pub fn start(&self, source: &str) -> Result<JoinHandle<i32>, String> {
        if self.core.foreground.borrow().is_some() {
            return Err("foreground job is already running".into());
        }
        if source.len() > self.core.limits.source_bytes {
            return Err("shell source limit exceeded".into());
        }
        let (commands, failure) = parse_shell(source, &self.core.limits)?;
        let group = self.core.host.allocate_group();
        let cancel = Cancel::new();
        let foreground_cancel = cancel.clone();
        let context = Context {
            core: self.core.clone(),
            source: Rc::from(source),
            cancel,
            group,
            scope: 0,
            parameter_error_status: 127,
            compound_child: false,
        };
        let state = self.state.clone();
        let join = self.core.executor.spawn(async move {
            let _foreground = ForegroundGuard(context.core.clone());
            let mut processes = ProcessGroup::new(context.core.host.clone(), group);
            let mut result = script_sequence(
                commands,
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
            let code = context.finish_group(&mut processes, result.code).await;
            state.borrow_mut().status = code;
            code
        });
        *self.core.foreground.borrow_mut() = Some(Job {
            owner: 0,
            cancel: foreground_cancel,
            join: join.clone(),
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
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.interrupt();
        for job in self.core.jobs.borrow().values() {
            job.cancel.cancel();
        }
    }
}
impl Core {
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

/// Parse shell source the way the script reader and `eval` do. Resource
/// limits are errors; a syntax error keeps the complete lines before it.
fn parse_shell(
    source: &str,
    limits: &Limits,
) -> Result<(Vec<Command>, Option<ParseFailure>), String> {
    if source.len() > limits.source_bytes {
        return Err("shell source limit exceeded".into());
    }
    let parser_limits = shell_parser::limits::ExecutionLimits {
        max_input_bytes: limits.source_bytes,
        ..Default::default()
    };
    let budget = shell_parser::limits::ExecutionBudget::new(
        &parser_limits,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
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
    Ok((script.commands, failure))
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

/// `eval`: the arguments joined by spaces, read like a script in the
/// current shell. A syntax error returns 2 after the complete lines before
/// it ran; `return` and `exit` act on the caller.
async fn eval(args: Vec<String>, state: SharedState, fds: Descriptors, context: Context) -> Outcome {
    let source = args.join(" ");
    let (commands, failure) = match parse_shell(&source, context.limits()) {
        Ok(parsed) => parsed,
        Err(_) => return Outcome::status(2),
    };
    let context = Context {
        source: Rc::from(source),
        ..context
    };
    let mut result = sequence(commands, state, fds.clone(), context.clone()).await;
    if result.flow == Flow::Normal
        && let Some(failure) = failure
    {
        result = parse_failure(failure, "eval", &fds, &context).await;
        if result.code == 2 && result.flow == Flow::Exit {
            result.flow = Flow::Normal;
        }
    }
    result
}

async fn script_sequence(
    commands: Vec<Command>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut result = Outcome::status(0);
    // The parser groups each top-level read unit through its terminating
    // newline. Arithmetic expansion errors unwind functions and compound
    // commands in that unit, then Bash's reader accepts the next one.
    for command in commands {
        result = execute(command, state.clone(), fds.clone(), context.clone()).await;
        if context.cancel.is_cancelled() {
            return Outcome::status(130);
        }
        if matches!(result.flow, Flow::Exit | Flow::Return) {
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
) -> LocalBoxFuture<'static, Outcome> {
    async move {
        let mut result = Outcome::status(0);
        for command in commands {
            result = execute(command, state.clone(), fds.clone(), context.clone()).await;
            if result.flow != Flow::Normal || context.cancel.is_cancelled() {
                break;
            }
        }
        if context.cancel.is_cancelled() {
            Outcome::status(130)
        } else {
            result
        }
    }
    .boxed_local()
}
fn execute(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> LocalBoxFuture<'static, Outcome> {
    async move {
        yield_now().await;
        if context.cancel.is_cancelled() {
            return Outcome::status(130);
        }
        let preserve = matches!(command, Command::Pipeline(_) | Command::List(_));
        let result = match command {
            Command::Simple(simple) => {
                simple_command(simple, state.clone(), fds, context.clone()).await
            }
            Command::Function(function) => {
                state
                    .borrow_mut()
                    .functions
                    .insert(function.name, *function.body);
                Outcome::status(0)
            }
            Command::Pipeline(pipeline) => {
                let count = pipeline.commands.len();
                if count == 0 || count > context.limits().pipeline_stages {
                    state.borrow_mut().status = 2;
                    state.borrow_mut().pipestatus = vec![2];
                    return Outcome::status(2);
                }
                let mut previous = None;
                let mut tasks = Vec::new();
                for (index, command) in pipeline.commands.into_iter().enumerate() {
                    let mut stage_fds = fds.borrow().clone();
                    if let Some(input) = previous.take() {
                        stage_fds.insert(0, input);
                    }
                    if index + 1 < count {
                        let (reader, writer) = io::pipe();
                        stage_fds.insert(1, writer);
                        previous = Some(reader);
                    }
                    let child = if count == 1 {
                        state.clone()
                    } else {
                        state.borrow().clone().shared()
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
                    tasks.push(context.core.executor.spawn(async move {
                        let result =
                            execute(command, child, stage_fds, stage_context.clone()).await;
                        if count > 1 {
                            stage_context.cleanup_jobs().await;
                        }
                        result
                    }));
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
            Command::List(list) => list_command(list, state.clone(), fds, context.clone()).await,
            Command::Compound(CompoundCommand::Subshell(commands), redirs) => {
                subshell(commands, redirs, state.clone(), fds, context.clone()).await
            }
            Command::Compound(compound, redirs) => {
                let fds = Rc::new(RefCell::new(fds.borrow().clone()));
                let mut work = substitution_work(&context, &fds);
                match command_redirects(&redirs, &state, fds, &context, &mut work).await {
                    Err(outcome) => outcome,
                    Ok(fds) => {
                        // Only `((...))` expands words itself, after its
                        // redirections; other bodies must not retain the
                        // caller's descriptors while they run.
                        work.substitutions = matches!(compound, CompoundCommand::Arithmetic(_))
                            .then(|| Substitutions {
                                context: context.compound_body(),
                                fds: fds.clone(),
                            });
                        execute_compound_body(
                            compound,
                            state.clone(),
                            fds,
                            context.compound_body(),
                            &mut work,
                        )
                        .await
                    }
                }
            }
        };
        let mut s = state.borrow_mut();
        s.status = result.code;
        if !preserve {
            s.pipestatus = vec![result.code];
        }
        result
    }
    .boxed_local()
}
async fn command_redirects(
    redirs: &[Redirect],
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Descriptors, Outcome> {
    let original_fds = fds.clone();
    match redirects(redirs, state, fds, context, work).await {
        Ok(fds) => Ok(fds),
        Err(error) => Err(expansion_failure(error, &original_fds, context).await),
    }
}

async fn execute_compound_body(
    compound: CompoundCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &mut expand::Work,
) -> Outcome {
    match compound {
        CompoundCommand::Arithmetic(source) => {
            arithmetic_command(&source, &state, &fds, &context, work).await
        }
        CompoundCommand::BraceGroup(commands) => {
            sequence(commands, state.clone(), fds, context.clone()).await
        }
        CompoundCommand::While(loop_) => {
            let mut result = Outcome::status(0);
            loop {
                let condition = sequence(
                    loop_.condition.clone(),
                    state.clone(),
                    fds.clone(),
                    context.clone(),
                )
                .await;
                if context.cancel.is_cancelled() {
                    break Outcome::status(130);
                }
                if condition.flow != Flow::Normal {
                    break condition;
                }
                if condition.code != 0 {
                    break result;
                }
                result = sequence(
                    loop_.body.clone(),
                    state.clone(),
                    fds.clone(),
                    context.clone(),
                )
                .await;
                if result.flow != Flow::Normal {
                    break result;
                }
            }
        }
        _ => Outcome::status(2),
    }
}

async fn arithmetic_command(
    source: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Outcome {
    match crate::arithmetic::evaluate(
        source,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await
    {
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
    let CommandError { error, stderr } = error;
    let flow = if matches!(
        error,
        expand::Error::Arithmetic { .. }
            | expand::Error::Readonly { .. }
            | expand::Error::ShellBoundary {
                stage: expand::ShellBoundaryStage::Expansion,
                ..
            }
    ) {
        Flow::DiscardReadUnit
    } else {
        Flow::Exit
    };
    let (name, message, line, status) = match error {
        expand::Error::Status(code) => return Outcome::status(code),
        expand::Error::Readonly { name, line, .. } => {
            (name, "readonly variable".to_owned(), line, 1)
        }
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
        } => (name, message, line, context.parameter_error_status),
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
    let child = state.borrow().clone().shared();
    let child_context = context.isolated();
    let child_fds = Rc::new(RefCell::new(fds.borrow().clone()));
    drop(fds);
    let result =
        context
            .core
            .executor
            .spawn(async move {
                let mut work = substitution_work(&child_context, &child_fds);
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
                child_context.cleanup_jobs().await;
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
            background(command, &state, &fds, &context)
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
fn background(
    command: Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    if context.core.jobs.borrow().len() >= context.limits().jobs {
        state.borrow_mut().status = 2;
        state.borrow_mut().pipestatus = vec![2];
        return Outcome::status(2);
    }
    let group = context.core.host.allocate_group();
    let cancel = Cancel::new();
    let child_context = Context {
        core: context.core.clone(),
        source: context.source.clone(),
        cancel: cancel.clone(),
        group,
        scope: context.core.allocate_id(),
        parameter_error_status: context.child_error_status(&command),
        compound_child: matches!(command, Command::Compound(..)),
    };
    let child = state.borrow().clone().shared();
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let job = context.core.next_job.get();
    context.core.next_job.set(job + 1);
    let join = context.core.executor.spawn(async move {
        let mut processes = ProcessGroup::new(child_context.core.host.clone(), group);
        let result = execute(command, child, fds, child_context.clone()).await;
        child_context.cleanup_jobs().await;
        child_context
            .finish_group(&mut processes, result.code)
            .await
    });
    context.core.jobs.borrow_mut().insert(
        job,
        Job {
            owner: context.scope,
            cancel,
            join,
        },
    );
    state.borrow_mut().status = 0;
    state.borrow_mut().pipestatus = vec![0];
    Outcome::status(0)
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
        state: &SharedState,
    ) -> (io::Endpoint, SubstitutionTask) {
        let (reader, writer) = io::pipe();
        let child = state.borrow().clone().shared();
        let mut table = self.fds.borrow().clone();
        table.insert(1, writer);
        let fds = Rc::new(RefCell::new(table));
        let cancel = Cancel::new();
        let parent = self.context.cancel.clone();
        let context = Context {
            cancel: cancel.clone(),
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let link = cancel.clone();
        let join = self.context.core.executor.spawn(async move {
            let body = async {
                let result = sequence(commands, child, fds, context.clone()).await;
                context.cleanup_jobs().await;
                result.code
            };
            // The parent's cancellation reaches the body through its own
            // token; the body still unwinds normally and reports its status.
            let forward = async {
                parent.cancelled().await;
                link.cancel();
                futures::future::pending::<()>().await
            };
            futures::pin_mut!(body, forward);
            match futures::future::select(body, forward).await {
                futures::future::Either::Left((code, _)) => code,
                futures::future::Either::Right(((), body)) => body.await,
            }
        });
        (
            reader,
            SubstitutionTask {
                cancel,
                join,
                finished: false,
            },
        )
    }
    /// Start `<(commands)` (`is_input`) or `>(commands)` as a job of this
    /// shell and open its end of the pipe in the command's descriptor table,
    /// at the highest free descriptor from 63 down, as bash does. Returns
    /// that descriptor; the caller expands it to `/dev/fd/N`. The table is
    /// the command's own copy, so the descriptor closes with the command.
    pub(crate) fn process(
        &self,
        commands: Vec<Command>,
        is_input: bool,
        state: &SharedState,
    ) -> Result<u32, i32> {
        let fd = (3..=63u32)
            .rev()
            .find(|fd| self.fds.borrow().get(*fd).is_none())
            .ok_or(2)?;
        let core = &self.context.core;
        if core.jobs.borrow().len() >= self.context.limits().jobs {
            return Err(2);
        }
        let (reader, writer) = io::pipe();
        let mut table = self.fds.borrow().clone();
        let parent_end = if is_input {
            table.insert(1, writer);
            reader
        } else {
            table.insert(0, reader);
            writer
        };
        let fds = Rc::new(RefCell::new(table));
        let child = state.borrow().clone().shared();
        let cancel = Cancel::new();
        let context = Context {
            cancel: cancel.clone(),
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let join = core.executor.spawn(async move {
            let result = sequence(commands, child, fds, context.clone()).await;
            context.cleanup_jobs().await;
            result.code
        });
        let job = core.next_job.get();
        core.next_job.set(job + 1);
        core.jobs.borrow_mut().insert(
            job,
            Job {
                owner: self.context.scope,
                cancel,
                join,
            },
        );
        self.fds.borrow_mut().insert(fd, parent_end);
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
/// A running substitution body. Dropping it before `finish` (an expansion
/// error or cancellation) cancels the body, which then unwinds on its own.
pub(crate) struct SubstitutionTask {
    cancel: Cancel,
    join: JoinHandle<i32>,
    finished: bool,
}
impl SubstitutionTask {
    pub(crate) async fn finish(mut self) -> i32 {
        let code = self.join.clone().await;
        self.finished = true;
        code
    }
}
impl Drop for SubstitutionTask {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.cancel();
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

async fn prepare_simple_command(
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
        let fds = redirects(&simple.redirects, state, fds, context, &mut work).await?;
        work.substitutions = None;
        return Ok(PreparedCommand {
            argv,
            assigned: Vec::new(),
            fds,
            work,
        });
    }
    let fds = redirects(&simple.redirects, state, fds, context, &mut work).await?;
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

async fn dispatch_simple_command(
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
    // Prefix assignments on functions/builtins are deferred until full Bash rules.
    let function = state.borrow().functions.get(&name).cloned();
    if let Some(body) = function {
        if !assigned.is_empty() {
            return Err(2);
        }
        let _frame = FunctionFrame::enter(state.clone(), args, context.limits().function_depth)?;
        let mut outcome = execute(body, state, fds, context).await;
        if outcome.flow == Flow::Return {
            outcome.flow = Flow::Normal;
        }
        return Ok(outcome);
    }
    if name == "let" {
        if !assigned.is_empty() {
            return Err(2);
        }
        if args.is_empty() {
            return Ok(arithmetic_command("()", &state, &fds, &context, &mut work).await);
        }
        let mut result = Outcome::status(0);
        for source in &args {
            match crate::arithmetic::evaluate_literal(
                source,
                &state,
                &context.cancel,
                context.limits().expansion_bytes,
                &mut work,
            )
            .await
            {
                Ok(value) => result = Outcome::status(i32::from(value == 0)),
                Err(error) => {
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
                    result = expansion_failure(error.into(), &fds, &context).await;
                    if ordinary {
                        result.flow = Flow::Normal;
                    }
                    break;
                }
            }
        }
        return Ok(result);
    }
    if name == "eval" {
        if !assigned.is_empty() {
            return Err(2);
        }
        return Ok(eval(args, state, fds, context).await);
    }
    if builtins::is_builtin(&name) {
        if !assigned.is_empty() {
            return Err(2);
        }
        let bindings = fds.borrow().clone();
        return builtins::run(&name, args, state, bindings, context).await;
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
            context.core.host.kill(pid, 2).map_err(|_| 1)?;
            context.core.host.wait(pid).await.map_err(|_| 1)?;
            Err(130)
        }
    }
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
        let value = state.variables.get(&name).ok_or(2)?;
        *bytes = bytes
            .saturating_add(name.len())
            .saturating_add(1)
            .saturating_add(value.len());
        if *bytes > context.limits().expansion_bytes {
            return Err(2.into());
        }
        if !commit {
            assigned.push((name, value.clone()));
        }
    }
    if commit {
        frame.commit();
    }
    Ok(assigned)
}

async fn redirects(
    redirs: &[Redirect],
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Descriptors, CommandError> {
    if redirs.is_empty() {
        return Ok(fds);
    }
    let mut fds = fds.borrow().clone();
    let mut budget = Budget::default();
    for redirect in redirs {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if redirect.fd_var.is_some() {
            return Err(2.into());
        }
        let target = expand::word(
            &redirect.target,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            context.limits().expansion_bytes,
            work,
        )
        .await
        .map_err(|error| {
            CommandError::redirect(error.at_line(redirect.expansion_line), fds.get(2))
        })?;
        let input = matches!(redirect.kind, RedirectKind::Input | RedirectKind::DupInput);
        let fd = redirect.fd.unwrap_or(if input { 0 } else { 1 });
        let fd = u32::try_from(fd).map_err(|_| 2)?;
        match redirect.kind {
            RedirectKind::DupInput | RedirectKind::DupOutput => {
                if target == "-" {
                    fds.remove(fd);
                } else {
                    let source = target.parse::<u32>().map_err(|_| 2)?;
                    fds.insert(fd, fds.get(source).ok_or(1)?);
                }
            }
            RedirectKind::Input
            | RedirectKind::Output
            | RedirectKind::Clobber
            | RedirectKind::Append => {
                if let Some(endpoint) = device_endpoint(&target, &fds) {
                    fds.insert(fd, endpoint?);
                    continue;
                }
                let path = absolute(&state.borrow().cwd, &target);
                let options = OpenOptions {
                    read: input,
                    write: !input,
                    create: !input,
                    truncate: matches!(redirect.kind, RedirectKind::Output | RedirectKind::Clobber),
                    append: redirect.kind == RedirectKind::Append,
                };
                let endpoint = context
                    .cancel
                    .run(context.fs().open(&path, &options))
                    .await
                    .map_err(|_| 130)?
                    .map_err(|e| e.status())?;
                fds.insert(fd, endpoint);
            }
            _ => return Err(2.into()),
        }
    }
    Ok(Rc::new(RefCell::new(fds)))
}
