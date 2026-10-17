use super::{Error, Expansion, Protection};
use crate::{arithmetic, state::SharedState};

impl Expansion<'_> {
    pub(super) async fn positional_substring(
        &mut self,
        offset: &str,
        length: Option<&str>,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        self.slice_boundaries(offset).await?;
        if let Some(length) = length {
            self.slice_boundaries(length).await?;
        }
        let count = state.borrow().positional.len().checked_add(1).ok_or(2)?;
        let offset =
            arithmetic::evaluate(offset, state, self.cancel, self.raw_remaining, self.work).await?;
        self.ifs = None;
        self.ifs_changed = true;
        let Some(start) = slice_start(offset, count) else {
            return Ok(());
        };
        let end = self
            .positional_slice_end(start, count, length, state)
            .await?;
        self.ifs = None;
        self.ifs_changed = true;
        if end - start > self.elements_remaining {
            return Err(2.into());
        }
        self.elements_remaining -= end - start;
        let list = !scalar;
        self.segments.needs_split |= list;
        self.segments.list_word |= list;
        if scalar {
            self.segments.empty(self.work)?;
        }
        let separator = if scalar {
            Some(' ')
        } else {
            self.ifs_separator(state).await?.or(Some(' '))
        };
        let protection = Protection::expansion(quoted || scalar, state);
        for index in start..end {
            self.element_boundary(index - start, list, separator, quoted || scalar)
                .await?;
            let value = self.positional_slice_value(index, state)?;
            self.segment(&value, protection, quoted || scalar).await?;
        }
        Ok(())
    }

    async fn positional_slice_end(
        &mut self,
        start: usize,
        count: usize,
        length: Option<&str>,
        state: &SharedState,
    ) -> Result<usize, Error> {
        let Some(length) = length else {
            return Ok(count);
        };
        let length =
            arithmetic::evaluate(length, state, self.cancel, self.raw_remaining, self.work).await?;
        if length < 0 {
            return arithmetic::fault("substring expression < 0", self.work);
        }
        Ok(start
            .saturating_add(usize::try_from(length).unwrap_or(usize::MAX))
            .min(count))
    }

    fn positional_slice_value(
        &mut self,
        index: usize,
        state: &SharedState,
    ) -> Result<String, Error> {
        let state = state.borrow();
        let value = if index == 0 {
            &state.shell_name
        } else {
            &state.positional[index - 1]
        };
        if value.len() > self.raw_remaining {
            return Err(2.into());
        }
        self.work.admit_storage(value.len())?;
        Ok(value.clone())
    }
}

fn slice_start(offset: i64, count: usize) -> Option<usize> {
    if offset < 0 {
        return count.checked_sub(usize::try_from(offset.unsigned_abs()).ok()?);
    }
    usize::try_from(offset)
        .ok()
        .filter(|&offset| offset <= count)
}
