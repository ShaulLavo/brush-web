//! Command substitution, original to this engine. The body runs as a subshell
//! task (see `interpreter::Substitutions`); its stdout streams through a pipe
//! straight into the expansion. Only a count of trailing newlines is held back,
//! so no copy of the whole output exists beyond the expansion's own fields.
use super::{Error, Expansion, Protection};
use crate::state::SharedState;
use shell_parser::parser::Command;

/// Bytes read per pipe turn, plus the same again for the decoded text that is
/// emitted per flush. Both are temporary and charged to storage while live.
const CHUNK: usize = 4096;
/// A UTF-8 sequence split across reads carries at most three bytes over.
const CARRY: usize = 3;
const NULL_WARNING: &str = "/usr/bin/bash: warning: command substitution: ignored null byte in input\n";

impl Expansion<'_> {
    pub(super) async fn command_substitution(
        &mut self,
        commands: &[Command],
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        let protection = Protection::expansion(scalar || quoted, state);
        let keeps_empty = scalar || quoted;
        // A quoted substitution is a field even when its output is empty.
        self.segment("", protection, keeps_empty).await?;
        let scratch = CHUNK + CARRY + CHUNK;
        self.work.admit_storage(scratch)?;
        let result = self
            .capture(commands, state, protection, keeps_empty)
            .await;
        self.work.release_storage(scratch);
        let code = result?;
        self.work.substitution_status = Some(code);
        // Bash updates `$?` as soon as each substitution finishes.
        state.borrow_mut().status = code;
        Ok(())
    }

    async fn capture(
        &mut self,
        commands: &[Command],
        state: &SharedState,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<i32, Error> {
        let runner = self.work.substitutions.clone().ok_or(2)?;
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(CHUNK + CARRY).map_err(|_| 2)?;
        buffer.resize(CHUNK + CARRY, 0);
        let mut text = String::new();
        text.try_reserve_exact(CHUNK).map_err(|_| 2)?;
        let (reader, task) = runner.start(commands.to_vec(), state);
        let mut carried = 0usize;
        let mut newlines = 0usize;
        let mut warned = false;
        loop {
            let count = reader
                .read_cancelled(&mut buffer[carried..carried + CHUNK], self.cancel)
                .await
                .map_err(|error| match error {
                    crate::io::IoError::Cancelled => Error::Status(130),
                    _ => Error::Status(2),
                })?;
            if count == 0 {
                break;
            }
            self.work.checkpoint(self.cancel).await?;
            let total = carried + count;
            let (valid, rest) = match std::str::from_utf8(&buffer[..total]) {
                Ok(_) => (total, 0),
                // Byte-valued strings are not representable yet: fail closed
                // rather than emit text Bash would not produce.
                Err(error) if error.error_len().is_some() => return Err(2.into()),
                Err(error) => (error.valid_up_to(), total - error.valid_up_to()),
            };
            let decoded = std::str::from_utf8(&buffer[..valid]).map_err(|_| 2)?;
            for ch in decoded.chars() {
                self.work.checkpoint(self.cancel).await?;
                match ch {
                    '\0' => {
                        if !warned {
                            warned = true;
                            self.warn_null(&runner).await?;
                        }
                    }
                    '\n' => newlines = newlines.checked_add(1).ok_or(2)?,
                    _ => {
                        while newlines > 0 {
                            self.work.checkpoint(self.cancel).await?;
                            if text.len() + 1 > CHUNK {
                                self.flush(&mut text, protection, keeps_empty).await?;
                            }
                            text.push('\n');
                            newlines -= 1;
                        }
                        if text.len() + ch.len_utf8() > CHUNK {
                            self.flush(&mut text, protection, keeps_empty).await?;
                        }
                        text.push(ch);
                    }
                }
            }
            self.flush(&mut text, protection, keeps_empty).await?;
            buffer.copy_within(valid..total, 0);
            carried = rest;
        }
        if carried != 0 {
            return Err(2.into());
        }
        drop(reader);
        Ok(task.finish().await)
    }

    async fn flush(
        &mut self,
        text: &mut String,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        if text.is_empty() {
            return Ok(());
        }
        self.segment(text, protection, keeps_empty).await?;
        text.clear();
        Ok(())
    }

    async fn warn_null(&mut self, runner: &crate::interpreter::Substitutions) -> Result<(), Error> {
        if let Some(stderr) = runner.stderr() {
            let _ = stderr
                .write_all(NULL_WARNING.as_bytes(), runner.cancel())
                .await;
        }
        if self.cancel.is_cancelled() {
            return Err(130.into());
        }
        Ok(())
    }

    /// A non-arithmetic `$((...))` span whose text is not a valid command:
    /// Bash parses it only now, in the substitution's child, which reports the
    /// syntax error and exits 2. The expansion itself is empty.
    pub(super) async fn unparsed_substitution(
        &mut self,
        source: &str,
        error: &str,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        let runner = self.work.substitutions.clone().ok_or(2)?;
        let size = source.len().saturating_add(error.len()).saturating_add(128);
        self.work.admit_storage(size)?;
        let message = format!(
            "/usr/bin/bash: command substitution: {error}\n/usr/bin/bash: command substitution: `{source}'\n"
        );
        if let Some(stderr) = runner.stderr() {
            let _ = stderr.write_all(message.as_bytes(), runner.cancel()).await;
        }
        drop(message);
        self.work.release_storage(size);
        if self.cancel.is_cancelled() {
            return Err(130.into());
        }
        self.work.substitution_status = Some(2);
        state.borrow_mut().status = 2;
        self.segment(
            "",
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
}
