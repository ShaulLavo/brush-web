//! Scalar replacement adapted from the pinned Bashkit expansion.rs rules.
//! Search and emission use the engine's shared admission and cancellation budget.
use super::{Error, Expansion, Protection, Segment, Segments, Work, admit_vec_slot, pattern};
use crate::state::SharedState;

enum Piece {
    Literal(char),
    Matched,
}
impl Piece {
    async fn emit(
        &self,
        matched: &str,
        out: &mut Expansion<'_>,
        protection: Protection,
    ) -> Result<(), Error> {
        match self {
            Self::Matched => out.segment(matched, protection, false).await,
            Self::Literal(ch) => {
                out.segment(ch.encode_utf8(&mut [0; 4]), protection, false)
                    .await
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Replacement {
    pieces: Vec<Piece>,
    escape: bool,
}
impl Replacement {
    pub(super) fn push(
        &mut self,
        ch: char,
        protection: Protection,
        work: &mut Work,
    ) -> Result<(), Error> {
        // A quoted ampersand/backslash supplies an escape to Bash's replacement
        // pass. Keep this typed, including an expansion-provided backslash
        // adjacent to a quoted ampersand, without inserting markers into data.
        if protection.protects(ch) && matches!(ch, '&' | '\\') {
            self.feed('\\', work)?;
        }
        self.feed(ch, work)
    }
    fn feed(&mut self, ch: char, work: &mut Work) -> Result<(), Error> {
        if std::mem::take(&mut self.escape) {
            if matches!(ch, '&' | '\\') {
                return self.piece(Piece::Literal(ch), work);
            }
            self.piece(Piece::Literal('\\'), work)?;
        }
        match ch {
            '\\' => self.escape = true,
            '&' => return self.piece(Piece::Matched, work),
            _ => return self.piece(Piece::Literal(ch), work),
        }
        Ok(())
    }
    fn piece(&mut self, piece: Piece, work: &mut Work) -> Result<(), Error> {
        admit_vec_slot(&mut self.pieces, work)?;
        self.pieces.push(piece);
        Ok(())
    }
    fn finish(&mut self, work: &mut Work) -> Result<(), Error> {
        if std::mem::take(&mut self.escape) {
            self.piece(Piece::Literal('\\'), work)?;
        }
        Ok(())
    }
    async fn emit(
        &self,
        matched: &str,
        out: &mut Expansion<'_>,
        protection: Protection,
    ) -> Result<(), Error> {
        for piece in &self.pieces {
            out.work.checkpoint(out.cancel).await?;
            piece.emit(matched, out, protection).await?;
        }
        Ok(())
    }
}

impl Expansion<'_> {
    pub(super) async fn admit_replacement_output(&mut self) -> Result<(), Error> {
        if self.segments.account_storage {
            return Ok(());
        }
        if let Some(captured) = &self.captured
            && !self.pattern_snapshots
        {
            // Earlier assignment text predates replacement output accounting.
            // Pattern snapshots already admitted this capture's capacity.
            self.work.admit_storage(captured.value.capacity())?;
        }
        if self.pattern.is_some() || self.replacement.is_some() || self.captured.is_some() {
            self.segments.account_storage = true;
            return Ok(());
        }
        self.work.admit_storage(
            self.segments
                .parts
                .capacity()
                .checked_mul(std::mem::size_of::<Segment>())
                .ok_or(2)?,
        )?;
        for part in &self.segments.parts {
            self.work.checkpoint(self.cancel).await?;
            if let Segment::Text { value, .. } = part {
                self.work.admit_storage(value.capacity())?;
            }
        }
        self.segments.account_storage = true;
        Ok(())
    }
    pub(super) async fn replace(
        &mut self,
        name: &str,
        pattern_source: &str,
        replacement_source: &str,
        global: bool,
        state: &SharedState,
        protected: bool,
        depth: usize,
    ) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        let value = {
            let s = state.borrow();
            let value = s.scalar_parameter(name);
            if value.is_some_and(|v| v.len() > self.raw_remaining.min(self.work.remaining)) {
                return Err(2.into());
            }
            self.work.admit_storage(value.map_or(0, str::len))?;
            value.map(str::to_owned)
        };
        let Some(value) = value else {
            return self
                .segment("", Protection::expansion(protected, state), protected)
                .await;
        };
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        let capacity = self.raw_remaining;
        let mut child = Expansion {
            segments: Segments::default(),
            captured: None,
            pattern: Some(pattern::Pattern::default()),
            replacement: None,
            pattern_context: true,
            pattern_snapshots: true,
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        child
            .operand(pattern_source, state, false, false, depth + 1, true)
            .await?;
        let pattern = child.pattern.take().ok_or(2)?;
        child.replacement = Some(Replacement::default());
        child
            .operand(replacement_source, state, false, false, depth + 1, false)
            .await?;
        let mut replacement = child.replacement.take().ok_or(2)?;
        replacement.finish(child.work)?;
        self.raw_remaining -= capacity - child.raw_remaining;
        let ifs_changed = child.ifs_changed;
        drop(child);
        self.ifs_changed |= ifs_changed;
        if ifs_changed {
            self.ifs = None;
        }
        let mut search = pattern.replacement(global, self.work, self.cancel).await?;
        self.admit_replacement_output().await?;
        let protection = Protection::expansion(protected, state);
        let mut last = 0;
        let mut from = 0;
        while let Some((start, end)) = search.find(&value, from, self.work, self.cancel).await? {
            self.segment(&value[last..start], protection, false).await?;
            replacement
                .emit(&value[start..end], self, protection)
                .await?;
            last = end;
            if !global || search.anchored() || end == value.len() {
                break;
            }
            self.work.checkpoint(self.cancel).await?;
            from = end;
            if end == start {
                from += value[end..].chars().next().ok_or(2)?.len_utf8();
            }
        }
        self.segment(&value[last..], protection, protected).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Cancel, expand::Captured};
    use futures::FutureExt;

    fn capture_storage(storage: usize, snapshots: bool) -> Result<usize, Error> {
        let mut value = String::with_capacity(16);
        value.push('a');
        let mut work = Work::new(64, storage, 1);
        if snapshots {
            work.admit_storage(value.capacity())?;
        }
        let cancel = Cancel::new();
        let mut expansion = Expansion {
            segments: Segments::default(),
            captured: Some(Captured {
                value,
                max_bytes: 64,
            }),
            pattern: None,
            replacement: None,
            pattern_context: snapshots,
            pattern_snapshots: snapshots,
            ifs: None,
            ifs_changed: false,
            work: &mut work,
            cancel: &cancel,
            max_raw: 64,
            raw_remaining: 64,
            elements_remaining: 1,
        };
        for _ in 0..2 {
            expansion
                .admit_replacement_output()
                .now_or_never()
                .expect("capture admission does not suspend")?;
        }
        assert!(expansion.segments.account_storage);
        Ok(work.storage_remaining)
    }

    #[test]
    fn captured_replacement_storage_is_admitted_once_at_the_exact_capacity() {
        for snapshots in [false, true] {
            assert!(matches!(
                capture_storage(15, snapshots),
                Err(Error::Status(2))
            ));
            assert_eq!(
                capture_storage(16, snapshots)
                    .unwrap_or_else(|_| panic!("the existing capture capacity must fit")),
                0,
            );
        }
    }
}
