use super::{Context, Descriptors, Flow, Limits, Outcome, parse_failure, parse_shell, sequence};
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
    mem::size_of,
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
    storage: Cell<usize>,
    parser: ExecutionBudget,
}

#[derive(Clone)]
pub(super) struct Scope {
    shared: Rc<Shared>,
    depth: usize,
    execution_depth: usize,
}

impl Scope {
    pub(super) fn new(limits: &Limits, probe: Option<Rc<dyn Fn() -> bool>>) -> Self {
        let parser = ExecutionBudget::new(
            &ExecutionLimits {
                max_input_bytes: limits.source_bytes,
                timeout: Duration::MAX,
                ..ExecutionLimits::default()
            },
            Arc::new(AtomicBool::new(false)),
        );
        let parser = match probe {
            Some(probe) => parser.with_cancellation_probe(probe),
            None => parser,
        };
        Self {
            shared: Rc::new(Shared {
                storage: Cell::new(limits.expansion_bytes),
                parser,
            }),
            depth: 0,
            execution_depth: 0,
        }
    }

    pub(super) fn parser_budget(&self) -> &ExecutionBudget {
        &self.shared.parser
    }

    // Fixed execution allocations spend their byte size from shared request work
    // before allocation. Source/AST copies also keep their storage admission.
    // Rejection is inline, including when no allocation allowance remains.
    pub(super) fn frame<'a, T: 'a, F: Future<Output = T> + 'a>(
        &self,
        future: F,
        failure: impl FnOnce(i32) -> T,
    ) -> Frame<'a, T> {
        if self.admit_execution(size_of::<F>()).is_err() {
            return Either::Left(ready(failure(2)));
        }
        Either::Right(future.boxed_local())
    }

    pub(super) fn admit_execution(&self, bytes: usize) -> Result<(), i32> {
        let bytes = u64::try_from(bytes).map_err(|_| 2)?.max(1);
        self.shared.parser.consume_work(bytes).map_err(|_| 2)
    }

    pub(super) fn new_task(&self) -> Self {
        Self {
            shared: self.shared.clone(),
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

    fn admit_storage(&self, bytes: usize) -> Result<(), i32> {
        let remaining = self.shared.storage.get().checked_sub(bytes).ok_or(2)?;
        self.shared.storage.set(remaining);
        Ok(())
    }

    async fn checkpoint(&self, budget: &mut Budget, cancel: &Cancel) -> Result<(), i32> {
        if cancel.is_cancelled() {
            return Err(130);
        }
        self.shared.parser.consume_work(1).map_err(|_| 2)?;
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

// Charges remain cumulative for this request, including evals that have returned.
// Context clones keep the same allowance when jobs or substitutions outlive eval.
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
) -> Frame<'a, Result<String, i32>> {
    scope.frame(join_body(args, scope, context), Err)
}

async fn join_body(args: Vec<String>, scope: &Scope, context: &Context) -> Result<String, i32> {
    let mut budget = Budget::default();
    let mut bytes = args.len().saturating_sub(1);
    for arg in &args {
        scope.checkpoint(&mut budget, &context.cancel).await?;
        bytes = bytes.checked_add(arg.len()).ok_or(2)?;
    }
    if bytes > context.limits().source_bytes {
        return Err(2);
    }
    // String plus the later Rc<str> copy and its reference-count header.
    let storage = bytes
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(size_of::<usize>() * 2))
        .ok_or(2)?;
    scope.admit_storage(storage)?;
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
    scope.admit_storage(shape.storage()?)?;
    scope.checkpoint(&mut budget, &context.cancel).await?;
    Ok(source)
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
    let (commands, failure) =
        match parse_shell(&source, context.limits(), evaluation.parser_budget()) {
            Ok(parsed) => parsed,
            Err(_) => return Outcome::status(2),
        };
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    let context = Context {
        source: Rc::from(source),
        evaluation,
        ..context
    };
    // A joined reader task breaks the recursive poll/drop chain. Keep the
    // caller's shell and evaluation scopes, including both depth counters.
    // Shape already admitted this reader's fixed executor/queue metadata.
    let mut result = context
        .core
        .executor
        .spawn(sequence(commands, state, fds.clone(), context.clone()))
        .await;
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
