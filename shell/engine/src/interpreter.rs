//! Original task-oriented interpreter for the engine gate, not a Bashkit
//! interpreter fork. Unsupported syntax returns status 2 rather than guessing.
use crate::{
    builtins,
    executor::{Cancel, Executor, JoinHandle, yield_now},
    expand,
    io::{self, FdTable, FileSystem, OpenOptions},
    process::{GroupId, ProcessGroup, ProcessHost, SpawnRequest},
    state::{FunctionFrame, SharedState, State, absolute},
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
    pub expansion_bytes: usize,
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
            arguments: 4096,
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
type Descriptors = Rc<RefCell<FdTable>>;
struct Job {
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
    pub cancel: Cancel,
    pub group: GroupId,
}
impl Context {
    pub(crate) fn fs(&self) -> &dyn FileSystem {
        self.core.fs.as_ref()
    }
    pub(crate) fn limits(&self) -> &Limits {
        &self.core.limits
    }
    pub(crate) async fn wait_job(&self, id: Option<u64>) -> Result<i32, i32> {
        let jobs: Vec<_> = self
            .core
            .jobs
            .borrow()
            .iter()
            .filter(|(key, _)| id.is_none_or(|id| id == **key))
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
        self.core.jobs.borrow().get(&id).ok_or(1)?.cancel.cancel();
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
        let parser_limits = shell_parser::limits::ExecutionLimits {
            max_input_bytes: self.core.limits.source_bytes,
            ..Default::default()
        };
        let script = shell_parser::parse(source, &parser_limits).map_err(|e| e.to_string())?;
        let group = self.core.allocate_id();
        let cancel = Cancel::new();
        let foreground_cancel = cancel.clone();
        let context = Context {
            core: self.core.clone(),
            cancel,
            group,
        };
        let state = self.state.clone();
        let join = self.core.executor.spawn(async move {
            let _foreground = ForegroundGuard(context.core.clone());
            let mut processes = ProcessGroup::new(context.core.host.clone(), group);
            let result = sequence(
                script.commands,
                state.clone(),
                context.core.descriptors.clone(),
                context.clone(),
            )
            .await;
            let code = if context.cancel.is_cancelled() {
                processes.terminate(2).await.map(|_| 130).unwrap_or(1)
            } else {
                context
                    .core
                    .host
                    .wait_group(group)
                    .await
                    .map(|_| result.code)
                    .unwrap_or(1)
            };
            state.borrow_mut().status = code;
            code
        });
        *self.core.foreground.borrow_mut() = Some(Job {
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
                match simple_command(simple, state.clone(), fds, context.clone()).await {
                    Ok(result) => result,
                    Err(code) => Outcome::status(code),
                }
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
                    tasks.push(context.core.executor.spawn(execute(
                        command,
                        child,
                        Rc::new(RefCell::new(stage_fds)),
                        context.clone(),
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
            Command::List(list) => list_command(list, state.clone(), fds, context.clone()).await,
            Command::Compound(compound, redirs) => {
                match redirects(&redirs, &state, fds, &context).await {
                    Err(code) => Outcome::status(code),
                    Ok(fds) => match compound {
                        CompoundCommand::BraceGroup(commands) => {
                            sequence(commands, state.clone(), fds, context.clone()).await
                        }
                        CompoundCommand::Subshell(commands) => {
                            let child = state.borrow().clone().shared();
                            let result = context
                                .core
                                .executor
                                .spawn(sequence(
                                    commands,
                                    child,
                                    Rc::new(RefCell::new(fds.borrow().clone())),
                                    context.clone(),
                                ))
                                .await;
                            Outcome::status(result.code)
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
                    },
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
        return Outcome::status(2);
    }
    let group = context.core.allocate_id();
    let cancel = Cancel::new();
    let child_context = Context {
        core: context.core.clone(),
        cancel: cancel.clone(),
        group,
    };
    let child = state.borrow().clone().shared();
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let job = context.core.next_job.get();
    context.core.next_job.set(job + 1);
    let join = context.core.executor.spawn(async move {
        let mut processes = ProcessGroup::new(child_context.core.host.clone(), group);
        let result = execute(command, child, fds, child_context.clone()).await;
        if child_context.cancel.is_cancelled() {
            processes.terminate(2).await.map(|_| 130).unwrap_or(1)
        } else {
            child_context
                .core
                .host
                .wait_group(group)
                .await
                .map(|_| result.code)
                .unwrap_or(1)
        }
    });
    context
        .core
        .jobs
        .borrow_mut()
        .insert(job, Job { cancel, join });
    Outcome::status(0)
}
async fn simple_command(
    simple: SimpleCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Result<Outcome, i32> {
    if simple.args.len() > context.limits().arguments {
        return Err(2);
    }
    let mut assigned = Vec::new();
    for assignment in simple.assignments {
        if assignment.index.is_some() || assignment.append {
            return Err(2);
        }
        let AssignmentValue::Scalar(word) = assignment.value else {
            return Err(2);
        };
        let value = expand::word(
            &word,
            &state,
            &context.cancel,
            context.limits().expansion_bytes,
        )
        .await?;
        assigned.push((assignment.name, value));
    }
    let original_fds = fds.clone();
    let fds = redirects(&simple.redirects, &state, fds, &context).await?;
    let name = expand::word(
        &simple.name,
        &state,
        &context.cancel,
        context.limits().expansion_bytes,
    )
    .await?;
    let mut args = Vec::new();
    let mut bytes = name.len();
    for word in simple.args {
        let value = expand::word(
            &word,
            &state,
            &context.cancel,
            context.limits().expansion_bytes,
        )
        .await?;
        bytes += value.len();
        if bytes > context.limits().expansion_bytes {
            return Err(2);
        }
        args.push(value);
    }
    if name == "exec" {
        if !args.is_empty() || !assigned.is_empty() {
            return Err(2);
        }
        *original_fds.borrow_mut() = fds.borrow().clone();
        return Ok(Outcome::status(0));
    }
    // Prefix assignments for external commands belong only to their environment.
    // Prefix assignments on functions/builtins are deferred until full Bash rules.
    if name.is_empty() {
        for (key, value) in assigned {
            state.borrow_mut().variables.insert(key, value);
        }
        return Ok(Outcome::status(0));
    }
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
    match context.cancel.run(context.core.host.wait(pid)).await {
        Ok(result) => Ok(Outcome::status(result.map_err(|_| 1)?)),
        Err(_) => {
            context.core.host.kill(pid, 2).map_err(|_| 1)?;
            context.core.host.wait(pid).await.map_err(|_| 1)?;
            Err(130)
        }
    }
}
async fn redirects(
    redirs: &[Redirect],
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
) -> Result<Descriptors, i32> {
    if redirs.is_empty() {
        return Ok(fds);
    }
    let mut fds = fds.borrow().clone();
    for redirect in redirs {
        if redirect.fd_var.is_some() {
            return Err(2);
        }
        let target = expand::word(
            &redirect.target,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
        )
        .await?;
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
            _ => return Err(2),
        }
    }
    Ok(Rc::new(RefCell::new(fds)))
}
