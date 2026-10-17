use super::{
    Context, Descriptors, Flow, Limits, Outcome, parse_failure, parse_shell, script_sequence,
};
use crate::{
    executor::{Budget, Cancel},
    state::SharedState,
};
use futures::{
    FutureExt,
    future::{Either, LocalBoxFuture, Ready, ready},
};
use shell_parser::{
    limits::{ExecutionBudget, ExecutionLimits},
    parser::{Command, Word, WordPart},
};
use std::{
    cell::Cell,
    future::Future,
    mem::{size_of, size_of_val},
    ops::Deref,
    rc::Rc,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

const MAX_EVAL_DEPTH: usize = 16;
const MAX_EXECUTION_DEPTH: usize = 256;
const TEXT_BYTES_PER_LEVEL: usize = 16;
const READER_METADATA_BYTES: usize = 4096;

pub(super) type Frame<'a, T = Outcome> = Either<Ready<T>, LocalBoxFuture<'a, T>>;

struct Shared {
    storage: StorageBudget,
    source_bytes: usize,
    /// Bytes retained by currently active boxed execution frames. This is an
    /// active-memory bound, so a loop may keep running after each iteration's
    /// frame has been dropped instead of spending a cumulative parser budget.
    execution: Cell<usize>,
    execution_limit: usize,
}

#[derive(Clone, Debug)]
pub(super) struct StorageBudget(Rc<Cell<usize>>);

impl StorageBudget {
    pub(super) fn new(bytes: usize) -> Self {
        Self(Rc::new(Cell::new(bytes)))
    }

    fn admit(&self, bytes: usize) -> Result<StorageAllocation, i32> {
        let remaining = self.0.get().checked_sub(bytes).ok_or(2)?;
        self.0.set(remaining);
        Ok(StorageAllocation {
            budget: self.clone(),
            bytes,
        })
    }
}

#[derive(Debug)]
pub(crate) struct StorageAllocation {
    budget: StorageBudget,
    bytes: usize,
}

impl StorageAllocation {
    fn grow(&mut self, bytes: usize) -> Result<(), i32> {
        let total = self.bytes.checked_add(bytes).ok_or(2)?;
        let remaining = self.budget.0.get().checked_sub(bytes).ok_or(2)?;
        self.budget.0.set(remaining);
        self.bytes = total;
        Ok(())
    }
}

impl Drop for StorageAllocation {
    fn drop(&mut self) {
        self.budget.0.set(self.budget.0.get() + self.bytes);
    }
}

pub(crate) type RetainedStorage = Rc<StorageAllocation>;

#[derive(Clone)]
pub(super) struct Source {
    text: Rc<str>,
    storage: Option<RetainedStorage>,
}

impl Source {
    pub(super) fn root(text: &str) -> Self {
        Self {
            text: Rc::from(text),
            storage: None,
        }
    }
}

impl Deref for Source {
    type Target = str;

    fn deref(&self) -> &str {
        &self.text
    }
}

struct JoinedSource {
    text: String,
    storage: StorageAllocation,
}

impl JoinedSource {
    fn retain(self) -> Source {
        Source {
            text: Rc::from(self.text),
            storage: Some(Rc::new(self.storage)),
        }
    }
}

pub(super) struct Allocation {
    shared: Rc<Shared>,
    bytes: usize,
}

impl Drop for Allocation {
    fn drop(&mut self) {
        self.shared
            .execution
            .set(self.shared.execution.get().saturating_sub(self.bytes));
    }
}

fn frame_bytes<F>(_: &impl FnOnce(Allocation) -> F) -> usize {
    size_of::<F>()
}

#[derive(Clone)]
pub(super) struct Scope {
    shared: Rc<Shared>,
    retained: Option<RetainedStorage>,
    depth: usize,
    execution_depth: usize,
}

impl Scope {
    pub(super) fn new(limits: &Limits, storage: StorageBudget) -> Self {
        Self {
            shared: Rc::new(Shared {
                storage,
                source_bytes: limits.source_bytes,
                execution: Cell::new(0),
                // Reuse the former execution-byte ceiling, now for live
                // memory instead of the sum of every frame ever executed.
                execution_limit: usize::try_from(ExecutionLimits::default().max_work_units)
                    .unwrap_or(usize::MAX),
            }),
            retained: None,
            depth: 0,
            execution_depth: 0,
        }
    }

    // Each input has its own parser allowance. Nested syntax within that input
    // still shares the parser's work/fuel and cancellation state.
    pub(super) fn parser_budget(&self, probe: Option<Rc<dyn Fn() -> bool>>) -> ExecutionBudget {
        let parser = ExecutionBudget::new(
            &ExecutionLimits {
                max_input_bytes: self.shared.source_bytes,
                timeout: Duration::MAX,
                ..ExecutionLimits::default()
            },
            Arc::new(AtomicBool::new(false)),
        );
        match probe {
            Some(probe) => parser.with_cancellation_probe(probe),
            None => parser,
        }
    }

    pub(super) fn retained(&self) -> Option<RetainedStorage> {
        self.retained.clone()
    }

    pub(super) fn with_retained(mut self, retained: Option<RetainedStorage>) -> Self {
        self.retained = retained;
        self
    }

    // Fixed execution allocations are charged while their boxed futures are
    // live. Source/AST copies keep their separate storage/work admission.
    // Task metadata retains its allocation until reaping. Rejection is inline,
    // including when no active execution allowance remains.
    pub(super) fn frame<'a, T: 'a, F: Future<Output = T> + 'a>(
        &self,
        future: F,
        failure: impl FnOnce(i32) -> T,
    ) -> Frame<'a, T> {
        // Map stores the future once and retains its guard until completion or
        // drop. An async wrapper can reserve both initial and suspended copies
        // of F; size the actual combinator type before its heap allocation.
        let frame = move |allocation: Allocation| {
            future.map(move |value| {
                drop(allocation);
                value
            })
        };
        let bytes = frame_bytes(&frame);
        let allocation = match self.admit_execution(bytes) {
            Ok(allocation) => allocation,
            Err(code) => return Either::Left(ready(failure(code))),
        };
        let future = frame(allocation);
        debug_assert_eq!(size_of_val(&future), bytes);
        Either::Right(future.boxed_local())
    }

    pub(super) fn admit_execution(&self, bytes: usize) -> Result<Allocation, i32> {
        let used = self.shared.execution.get().checked_add(bytes).ok_or(2)?;
        if used > self.shared.execution_limit {
            return Err(2);
        }
        self.shared.execution.set(used);
        Ok(Allocation {
            shared: self.shared.clone(),
            bytes,
        })
    }

    pub(super) fn new_task(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            retained: self.retained.clone(),
            depth: 0,
            execution_depth: 0,
        }
    }

    pub(super) fn descend(&self) -> Result<Self, i32> {
        if self.execution_depth >= MAX_EXECUTION_DEPTH {
            return Err(2);
        }
        Ok(Self {
            execution_depth: self.execution_depth + 1,
            ..self.clone()
        })
    }

    fn enter(&self) -> Result<Self, i32> {
        if self.depth >= MAX_EVAL_DEPTH {
            return Err(2);
        }
        Ok(Self {
            depth: self.depth + 1,
            ..self.clone()
        })
    }

    pub(super) fn admit_storage(&self, bytes: usize) -> Result<StorageAllocation, i32> {
        self.shared.storage.admit(bytes)
    }

    async fn checkpoint(&self, budget: &mut Budget, cancel: &Cancel) -> Result<(), i32> {
        if cancel.is_cancelled() {
            return Err(130);
        }
        budget.checkpoint(cancel).await.map_err(|_| 130)
    }

    async fn copy_bytes(
        &self,
        bytes: usize,
        budget: &mut Budget,
        cancel: &Cancel,
    ) -> Result<(), i32> {
        for _ in 0..bytes {
            self.checkpoint(budget, cancel).await?;
        }
        Ok(())
    }
}

// Reserve source/AST storage before growth. Its shared owner follows the reader,
// stored functions and descendant contexts; the final owner returns admission.
struct Shape {
    bytes: usize,
    syntax: usize,
}

impl Shape {
    fn character(&mut self, ch: char) {
        self.bytes += ch.len_utf8();
        self.syntax +=
            usize::from(ch.is_whitespace() || "$\\'\"`<>()|;&{}\0\u{1e}\u{1f}".contains(ch));
    }

    fn storage(&self) -> Result<usize, i32> {
        // Nested raw words/operands can retain the surrounding source at every
        // admitted level. Tokens and delimiters bound those levels; flat AST
        // slots, vector growth, lexical metadata and parser frames are separate.
        let layers = self
            .syntax
            .checked_add(1)
            .ok_or(2)?
            .min(ExecutionLimits::default().max_ast_depth);
        let text = self
            .bytes
            .checked_mul(layers)
            .and_then(|bytes| bytes.checked_mul(TEXT_BYTES_PER_LEVEL))
            .ok_or(2)?;
        let slot = size_of::<Command>() + size_of::<Word>() + size_of::<WordPart>();
        let nodes = self
            .syntax
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .and_then(|count| count.checked_mul(slot))
            .ok_or(2)?;
        let parsers = layers
            .checked_mul(size_of::<shell_parser::Parser<'static>>())
            .ok_or(2)?;
        text.checked_add(nodes)
            .and_then(|bytes| bytes.checked_add(parsers))
            .and_then(|bytes| bytes.checked_add(4096))
            .and_then(|bytes| bytes.checked_add(READER_METADATA_BYTES))
            .ok_or(2)
    }
}

#[inline(never)]
fn join<'a>(
    args: Vec<String>,
    scope: &'a Scope,
    context: &'a Context,
) -> Frame<'a, Result<JoinedSource, i32>> {
    scope.frame(join_body(args, scope, context), Err)
}

async fn join_body(
    args: Vec<String>,
    scope: &Scope,
    context: &Context,
) -> Result<JoinedSource, i32> {
    let mut budget = Budget::default();
    let mut bytes = args.len().saturating_sub(1);
    for arg in &args {
        scope.checkpoint(&mut budget, &context.cancel).await?;
        bytes = bytes.checked_add(arg.len()).ok_or(2)?;
    }
    if bytes > context.limits().source_bytes {
        return Err(2);
    }
    // String plus the later Rc<str> copy and both reference-count headers.
    let storage = bytes
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(size_of::<usize>() * 4))
        .and_then(|bytes| bytes.checked_add(size_of::<StorageAllocation>()))
        .ok_or(2)?;
    let mut storage = scope.admit_storage(storage)?;
    let mut source = String::new();
    source.try_reserve_exact(bytes).map_err(|_| 2)?;
    let mut shape = Shape {
        bytes: 0,
        syntax: 0,
    };
    for (index, arg) in args.into_iter().enumerate() {
        if index != 0 {
            scope.checkpoint(&mut budget, &context.cancel).await?;
            shape.character(' ');
            source.push(' ');
        }
        for ch in arg.chars() {
            scope
                .copy_bytes(ch.len_utf8(), &mut budget, &context.cancel)
                .await?;
            shape.character(ch);
            source.push(ch);
        }
    }
    storage.grow(shape.storage()?)?;
    scope.checkpoint(&mut budget, &context.cancel).await?;
    Ok(JoinedSource {
        text: source,
        storage,
    })
}

/// Read admitted eval text in the current shell. Complete earlier lines and
/// the caller's return/exit behavior survive a later syntax error.
#[inline(never)]
pub(super) fn run(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Frame<'static> {
    if context.cancel.is_cancelled() {
        return Either::Left(ready(Outcome::status(130)));
    }
    if args.is_empty() || args.len() == 1 && args[0].is_empty() {
        return Either::Left(ready(Outcome::status(0)));
    }
    let evaluation = match context.evaluation.enter() {
        Ok(scope) => scope,
        Err(code) => return Either::Left(ready(Outcome::status(code))),
    };

    evaluation.frame(
        run_body(args, state, fds, context, evaluation.clone()),
        Outcome::status,
    )
}

async fn run_body(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    evaluation: Scope,
) -> Outcome {
    let source = match join(args, &evaluation, &context).await {
        Ok(source) => source,
        Err(code) => return Outcome::status(code),
    };
    let parser = context.parser_budget();
    let (script, failure) = match parse_shell(&source.text, context.limits(), &parser) {
        Ok(parsed) => parsed,
        Err(_)
            if matches!(
                parser.check(),
                Err(shell_parser::limits::LimitExceeded::Cancelled)
            ) =>
        {
            context.cancel.cancel();
            return Outcome::status(130);
        }
        Err(_) => return Outcome::status(2),
    };
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    let source = source.retain();
    let context = Context {
        evaluation: evaluation.with_retained(source.storage.clone()),
        source,
        ..context
    };
    // A joined reader task breaks the recursive poll/drop chain. Keep the
    // caller's shell and evaluation scopes, including both depth counters.
    // Shape already admitted this reader's fixed executor/queue metadata.
    let mut result = context
        .core
        .executor
        .spawn(script_sequence(
            script.commands,
            script.command_end_lines,
            state,
            fds.clone(),
            context.clone(),
        ))
        .await;
    // Discard belongs to this eval reader. Resume its next input/error, then
    // return a status to the caller instead of discarding the caller's line.
    if result.flow == Flow::DiscardReadUnit {
        result.flow = Flow::Normal;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_growth_is_admitted_atomically_and_refunded_by_the_last_owner() {
        let storage = StorageBudget::new(64);
        let mut allocation = storage.admit(48).unwrap();
        assert!(allocation.grow(17).is_err());
        assert_eq!(storage.0.get(), 16);
        allocation.grow(16).unwrap();
        assert!(storage.admit(1).is_err());
        let retained = Rc::new(allocation);
        let limits = Limits::default();
        let scope = Scope::new(&limits, storage.clone()).with_retained(Some(retained.clone()));
        let child = scope.new_task();
        drop(retained);
        drop(scope);
        assert!(storage.admit(1).is_err());
        drop(child);
        assert_eq!(storage.0.get(), 64);
    }

    #[test]
    fn cancelling_owned_storage_returns_admission_without_waiting_for_a_later_request() {
        let storage = StorageBudget::new(64);
        let allocation = storage.admit(64).unwrap();
        let cancel = Cancel::new();
        let body = async move {
            let _allocation = allocation;
            futures::future::pending::<()>().await;
        };
        let wait = cancel.run(body);
        futures::pin_mut!(wait);
        assert!(wait.as_mut().now_or_never().is_none());
        assert_eq!(storage.0.get(), 0);
        cancel.cancel();
        assert!(matches!(wait.as_mut().now_or_never(), Some(Err(_))));
        assert_eq!(storage.0.get(), 64);
    }

    #[test]
    fn parser_work_is_shared_inside_an_input_and_fresh_for_a_later_input() {
        let limits = Limits::default();
        let scope = Scope::new(&limits, StorageBudget::new(limits.expansion_bytes));
        let parser = scope.parser_budget(None);
        parser
            .consume_work(ExecutionLimits::default().max_work_units)
            .unwrap();
        assert!(parser.clone().consume_work(1).is_err());
        assert!(parser.consume_work(0).is_err());
        assert!(scope.parser_budget(None).consume_work(1).is_ok());
    }

    #[test]
    fn fresh_parser_inputs_preserve_interrupt_probes() {
        let limits = Limits::default();
        let interrupted = Rc::new(Cell::new(false));
        let observed = interrupted.clone();
        let probe: Rc<dyn Fn() -> bool> = Rc::new(move || observed.get());
        let scope = Scope::new(&limits, StorageBudget::new(limits.expansion_bytes));
        let parser = scope.parser_budget(Some(probe.clone()));
        assert!(parser.consume_work(1).is_ok());
        interrupted.set(true);
        assert!(matches!(
            parser.check(),
            Err(shell_parser::limits::LimitExceeded::Cancelled)
        ));
        assert!(matches!(
            scope.parser_budget(Some(probe)).check(),
            Err(shell_parser::limits::LimitExceeded::Cancelled)
        ));
    }

    #[test]
    fn live_execution_admission_rejects_growth_and_releases_dropped_allocations() {
        let limits = Limits::default();
        let scope = Scope::new(&limits, StorageBudget::new(limits.expansion_bytes));
        let allocation = scope.admit_execution(scope.shared.execution_limit).unwrap();
        assert!(scope.admit_execution(1).is_err());
        drop(allocation);
        assert_eq!(scope.shared.execution.get(), 0);
        let frame = scope.frame(futures::future::pending::<()>(), |_| ());
        assert!(scope.shared.execution.get() > 0);
        drop(frame);
        assert_eq!(scope.shared.execution.get(), 0);
        assert_eq!(scope.frame(ready(7), |_| 2).now_or_never(), Some(7));
        assert_eq!(scope.shared.execution.get(), 0);
        let frame = scope.frame(ready([7u8; 4096]), |_| [0; 4096]);
        let Either::Right(body) = &frame else {
            panic!("the bounded future fits the execution allowance");
        };
        assert_eq!(
            scope.shared.execution.get(),
            size_of_val(body.as_ref().get_ref())
        );
        assert_eq!(frame.now_or_never(), Some([7; 4096]));
        assert_eq!(scope.shared.execution.get(), 0);
    }
}
