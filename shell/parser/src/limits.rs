//! Original parser-only resource adapter, not Bashkit's execution limits.
//!
//! Fields cover the parser's actual configurable limits. Interpreter, process,
//! I/O and memory budgets belong to the future engine, not this adapter.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::time_compat::Instant;

/// Parser settings. Defaults match the pinned parser and its upstream caller.
#[derive(Debug, Clone)]
pub struct ExecutionLimits {
    pub max_input_bytes: usize,
    pub max_ast_depth: usize,
    pub max_parser_operations: usize,
    pub parser_timeout: Duration,
    pub max_work_units: u64,
    pub timeout: Duration,
}

impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: 10_000_000,
            max_ast_depth: 100,
            max_parser_operations: 100_000,
            parser_timeout: Duration::from_secs(5),
            max_work_units: 100_000_000,
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LimitExceeded {
    #[error("input too large ({0} bytes, max {1} bytes)")]
    InputTooLarge(usize, usize),
    #[error("parser timeout ({0:?})")]
    ParserTimeout(Duration),
    #[error("parser fuel exhausted ({used} operations, max {limit})")]
    ParserFuel { used: usize, limit: usize },
    #[error("AST nesting too deep ({depth} levels, max {limit})")]
    AstDepth { depth: usize, limit: usize },
    #[error("parameter expansion nesting too deep")]
    ParameterDepth,
    #[error("AST nesting too deep in parameter")]
    ParameterBoundaryDepth,
    #[error("AST nesting too deep in parameter command")]
    ParameterCommandDepth,
    #[error("parser fuel exhausted in parameter command")]
    ParameterCommandFuel,
    #[error("conditional expression nested too deeply")]
    ConditionalDepth,
    #[error("request work exhausted ({used} units requested, max {limit})")]
    WorkUnits { used: u64, limit: u64 },
    #[error("request timeout ({0:?})")]
    Timeout(Duration),
    #[error("request cancelled")]
    Cancelled,
}

struct CancellationProbe(Rc<dyn Fn() -> bool>);
impl std::fmt::Debug for CancellationProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CancellationProbe")
    }
}

#[derive(Debug)]
struct Budget {
    used: Cell<u64>,
    limit: u64,
    started_at: Instant,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
    probe: Option<CancellationProbe>,
    failure: Cell<Option<LimitExceeded>>,
}

/// Shared, monotonic parser work budget for one single-threaded request.
///
/// Clones share counters and the first failure. Nested substitutions receive the
/// same budget through the upstream parser. The cancellation flag may be set by
/// another thread; all other state stays on the parser's executor thread.
#[derive(Debug, Clone)]
pub struct ExecutionBudget(Rc<Budget>);

impl ExecutionBudget {
    pub fn new(limits: &ExecutionLimits, cancelled: Arc<AtomicBool>) -> Self {
        Self(Rc::new(Budget {
            used: Cell::new(0),
            limit: limits.max_work_units,
            started_at: Instant::now(),
            timeout: limits.timeout,
            cancelled,
            probe: None,
            failure: Cell::new(None),
        }))
    }

    /// Synchronous guest checkpoints can observe runtime signals without waiting
    /// for the browser worker message loop. The callback must never block.
    pub fn with_cancellation_probe(mut self, probe: Rc<dyn Fn() -> bool>) -> Self {
        Rc::get_mut(&mut self.0)
            .expect("install probe before sharing budget")
            .probe = Some(CancellationProbe(probe));
        self
    }

    pub fn check(&self) -> Result<(), LimitExceeded> {
        if let Some(failure) = self.0.failure.get() {
            return Err(failure);
        }
        let failure = if self.0.cancelled.load(Ordering::Relaxed)
            || self.0.probe.as_ref().is_some_and(|probe| (probe.0)())
        {
            LimitExceeded::Cancelled
        } else if self.0.started_at.elapsed() >= self.0.timeout {
            LimitExceeded::Timeout(self.0.timeout)
        } else {
            return Ok(());
        };
        self.fail(failure)
    }

    pub fn consume_work(&self, units: u64) -> Result<(), LimitExceeded> {
        self.check()?;
        let used = self.0.used.get().checked_add(units);
        if used.is_none_or(|used| used > self.0.limit) {
            return self.fail(LimitExceeded::WorkUnits {
                used: used.unwrap_or(u64::MAX),
                limit: self.0.limit,
            });
        }
        self.0.used.set(used.expect("checked above"));
        Ok(())
    }

    pub(crate) fn record_failure(&self, failure: LimitExceeded) -> LimitExceeded {
        let first = self.0.failure.get().unwrap_or(failure);
        self.0.failure.set(Some(first));
        first
    }

    fn fail(&self, failure: LimitExceeded) -> Result<(), LimitExceeded> {
        Err(self.record_failure(failure))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget(limit: u64) -> ExecutionBudget {
        ExecutionBudget::new(
            &ExecutionLimits {
                max_work_units: limit,
                ..ExecutionLimits::default()
            },
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn synchronous_guest_probe_latches_cancellation() {
        let interrupted = Rc::new(Cell::new(false));
        let probe = interrupted.clone();
        let budget = budget(10).with_cancellation_probe(Rc::new(move || probe.replace(false)));
        assert_eq!(budget.check(), Ok(()));
        interrupted.set(true);
        assert_eq!(budget.consume_work(1), Err(LimitExceeded::Cancelled));
        assert_eq!(budget.clone().check(), Err(LimitExceeded::Cancelled));
    }

    #[test]
    fn clones_share_work_and_remain_failed() {
        let budget = budget(3);
        let child = budget.clone();
        budget.consume_work(2).unwrap();
        child.consume_work(1).unwrap();
        let failure = child.consume_work(1).unwrap_err();
        assert_eq!(failure, LimitExceeded::WorkUnits { used: 4, limit: 3 });
        assert_eq!(budget.check(), Err(failure));
        assert_eq!(budget.consume_work(0), Err(failure));
    }

    #[test]
    fn work_counter_cannot_overflow() {
        let budget = budget(u64::MAX);
        budget.consume_work(u64::MAX).unwrap();
        assert!(matches!(
            budget.consume_work(1),
            Err(LimitExceeded::WorkUnits { .. })
        ));
    }

    #[test]
    fn cancellation_is_sticky() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let budget = ExecutionBudget::new(&ExecutionLimits::default(), cancelled.clone());
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(budget.check(), Err(LimitExceeded::Cancelled));
        cancelled.store(false, Ordering::Relaxed);
        assert_eq!(budget.clone().check(), Err(LimitExceeded::Cancelled));
    }

    #[test]
    fn zero_deadline_expires_immediately() {
        let limits = ExecutionLimits {
            timeout: Duration::ZERO,
            ..ExecutionLimits::default()
        };
        let budget = ExecutionBudget::new(&limits, Arc::new(AtomicBool::new(false)));
        assert_eq!(budget.check(), Err(LimitExceeded::Timeout(Duration::ZERO)));
    }
}
