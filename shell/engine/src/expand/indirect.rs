//! Scalar indirection adapted from Bashkit's IndirectExpansion/indirect_target
//! at 491c3281. This original adapter resolves typed names directly; it never
//! desugars a target string into syntax. Generic IndirectSuffix stays unsupported.
use super::{Error, Expansion, Protection, operand};
use crate::state::SharedState;
use shell_parser::parser::ParameterOp;

#[derive(PartialEq)]
enum TargetKind {
    Scalar,
    Unsupported,
    Invalid,
}

impl Expansion<'_> {
    pub(super) async fn indirect(
        &mut self,
        name: &str,
        operator: Option<&ParameterOp>,
        source: &str,
        colon: bool,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> Result<(), Error> {
        if depth >= operand::MAX_DEPTH || operator.is_some_and(|op| !operand::indirect_operator(op))
        {
            return Err(2.into());
        }
        if self.indirect_kind(name).await? != TargetKind::Scalar {
            return Err(2.into());
        }
        let Some(target) = self.indirect_snapshot(name, state, true).await? else {
            return Err(self.invalid_indirect(name, true)?);
        };
        match self.indirect_kind(&target).await? {
            TargetKind::Unsupported => return Err(2.into()),
            TargetKind::Invalid => return Err(self.invalid_indirect(&target, false)?),
            TargetKind::Scalar => {}
        }
        if operator.is_none() && state.borrow().is_nameref(name) {
            return self
                .segment(
                    &target,
                    Protection::expansion(scalar || quoted, state),
                    scalar || quoted,
                )
                .await;
        }
        let Some(operator) = operator else {
            // A bare indirection reads its resolved target. Lazy operators
            // below only test target presence; their selected operands enforce
            // nounset through ordinary expansion instead.
            if let Err(error) = self.require_bound(&target, state).await {
                return Err(match error {
                    Error::Unbound { line, .. } => {
                        // Bash names the indirect expression (`!p`), not its
                        // resolved target. Admit both diagnostic spellings
                        // before allocating this replacement name.
                        self.work
                            .admit_storage(name.len().saturating_add(1).saturating_mul(2))?;
                        Error::Unbound {
                            name: format!("!{name}"),
                            line,
                        }
                    }
                    other => other,
                });
            }
            let value = self
                .indirect_snapshot(&target, state, false)
                .await?
                .unwrap_or_default();
            return self
                .segment(
                    &value,
                    Protection::expansion(scalar || quoted, state),
                    scalar || quoted,
                )
                .await;
        };
        // The pointer must coexist with snapshots retained by a selected scalar
        // operator, including diagnostics and enclosing trim patterns.
        let snapshots = self.pattern_snapshots;
        self.pattern_snapshots = true;
        let result = self
            .parameter(
                &target,
                operator,
                source,
                colon,
                state,
                quoted,
                scalar,
                depth,
                Some(name),
            )
            .await;
        self.pattern_snapshots = snapshots;
        result
    }

    async fn indirect_kind(&mut self, name: &str) -> Result<TargetKind, Error> {
        let mut valid = !name.is_empty();
        let mut digits = !name.is_empty();
        let mut subscript = false;
        for (index, byte) in name.bytes().enumerate() {
            self.work.checkpoint(self.cancel).await?;
            valid &=
                byte == b'_' || byte.is_ascii_alphabetic() || index > 0 && byte.is_ascii_digit();
            digits &= byte.is_ascii_digit();
            subscript |= byte == b'[';
        }
        if name == "PIPESTATUS" {
            return Ok(TargetKind::Unsupported);
        }
        if valid {
            return Ok(TargetKind::Scalar);
        }
        // These categories need typed semantics, never target-string reparsing.
        if subscript || digits || matches!(name, "@" | "*" | "#" | "?" | "$" | "!" | "-") {
            return Ok(TargetKind::Unsupported);
        }
        Ok(TargetKind::Invalid)
    }

    async fn indirect_snapshot(
        &mut self,
        name: &str,
        state: &SharedState,
        pointer: bool,
    ) -> Result<Option<String>, Error> {
        self.work.checkpoint(self.cancel).await?;
        crate::state::State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let value = {
            let state = state.borrow();
            let value = if pointer {
                state.indirect_parameter(name)?
            } else {
                state.scalar_parameter(name)
            };
            let Some(value) = value else {
                return Ok(None);
            };
            if value.len() > self.raw_remaining.min(self.work.remaining) {
                return Err(2.into());
            }
            self.work.admit_storage(value.len())?;
            value.to_owned()
        };
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        Ok(Some(value))
    }

    fn invalid_indirect(&mut self, name: &str, unset: bool) -> Result<Error, Error> {
        // Same owning diagnostic layer and bounded allocation as scalar errors,
        // but GNU Bash invalid indirection has unconditional fatal status 1.
        self.work
            .admit_storage(name.len().saturating_mul(2).saturating_add(96))?;
        Ok(Error::Indirect {
            name: name.to_owned(),
            unset,
            line: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;

    fn expand_indirect(
        steps: usize,
        storage: usize,
        raw: usize,
    ) -> Result<(Vec<String>, usize, usize), Error> {
        let state = crate::state::State::default().shared();
        state
            .borrow_mut()
            .variables
            .insert("p".into(), "target".into());
        state
            .borrow_mut()
            .variables
            .insert("target".into(), "v".into());
        let token = shell_parser::Parser::parse_word_string_with_limits("${!p}", 10, 1000);
        let mut work = Work::new(steps, storage, 1);
        let cancel = Cancel::new();
        let value = fields(&token, &state, &cancel, 64, 1, raw, &mut work)
            .now_or_never()
            .expect("the tiny expansion uses fewer than 64 checkpoints")?;
        Ok((value, steps - work.remaining, work.storage_remaining))
    }

    #[test]
    fn indirect_pointer_and_value_share_exact_snapshot_storage_and_work() {
        assert!(matches!(expand_indirect(64, 6, 64), Err(Error::Status(2))));
        let (value, used, remaining) = expand_indirect(64, 7, 64)
            .unwrap_or_else(|_| panic!("six pointer bytes and one value byte fit exactly"));
        assert_eq!(value, ["v"]);
        assert_eq!(remaining, 0);
        assert!(matches!(
            expand_indirect(used - 1, 7, 64),
            Err(Error::Status(2))
        ));
        assert!(expand_indirect(used, 7, 64).is_ok());
        assert!(matches!(expand_indirect(64, 7, 5), Err(Error::Status(2))));
    }

    #[test]
    fn indirect_cancel_before_snapshot_spends_no_storage() {
        let state = crate::state::State::default().shared();
        state
            .borrow_mut()
            .variables
            .insert("p".into(), "target".into());
        let token = shell_parser::Parser::parse_word_string_with_limits("${!p}", 10, 1000);
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(64, 7, 1);
        assert!(matches!(
            fields(&token, &state, &cancel, 64, 1, 64, &mut work).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(work.storage_remaining, 7);
    }
}
