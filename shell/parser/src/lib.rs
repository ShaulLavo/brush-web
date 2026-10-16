//! Bashkit's unchanged parser and public AST, with original parser-only adapters.
//!
//! [`parse`] applies the configured input, depth, fuel, timeout and work limits.
//! The upstream [`Parser`] API is also exposed unchanged for incremental parsing
//! and shell parse options; its callers must enforce the input-size limit and
//! attach a shared [`limits::ExecutionBudget`] themselves.

pub mod error;
pub mod limits;
// Preserve the pinned upstream files byte-for-byte, including their formatting.
#[rustfmt::skip]
pub mod parser;
mod time_compat;

pub use error::{Error, Result};
pub use parser::*;

/// Parse one complete script with parser-only limits and a fresh work budget.
///
/// For multiple parses in one request (including later interpreter reparses),
/// use [`parse_with_budget`] so those operations share the same work allowance.
pub fn parse(source: &str, limits: &limits::ExecutionLimits) -> Result<Script> {
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let budget = limits::ExecutionBudget::new(limits, cancelled);
    parse_with_budget(source, limits, budget)
}

/// Parse using a shared request work budget and cancellation flag.
///
/// The unchanged parser's optional AST plausibility check, [`validate_budget`],
/// is separate: it uses upstream fixed ceilings, not interpreter runtime limits.
pub fn parse_with_budget(
    source: &str,
    limits: &limits::ExecutionLimits,
    budget: limits::ExecutionBudget,
) -> Result<Script> {
    budget.check()?;
    if source.len() > limits.max_input_bytes {
        return Err(
            limits::LimitExceeded::InputTooLarge(source.len(), limits.max_input_bytes).into(),
        );
    }
    let script = Parser::with_limits_and_timeout(
        source,
        limits.max_ast_depth,
        limits.max_parser_operations,
        Some(limits.parser_timeout),
    )
    .with_execution_budget(budget.clone())
    .parse()?;
    budget.check()?;
    Ok(script)
}
