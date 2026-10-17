//! Original positional-join adapter. Field splitting continues to use its own
//! effective IFS read; quoted/scalar star joins use Bash's special-variable
//! separator snapshot when IFS is a nameref.
use super::{Error, Expansion};
use crate::state::{SharedState, State};

impl Expansion<'_> {
    pub(super) async fn positional_star_separator(
        &mut self,
        state: &SharedState,
    ) -> Result<Option<char>, Error> {
        State::admitted_positional_separator(state, self.cancel, self.work).await
    }
}
