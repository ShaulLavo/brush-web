//! Original parser error adapter; no Bashkit interpreter error machinery.

use std::fmt::{self, Write};

use crate::limits::LimitExceeded;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("parse error at line {line}, column {column}: {message}")]
    Parse {
        message: String,
        line: usize,
        column: usize,
    },
    #[error("resource limit exceeded: {0}")]
    ResourceLimit(#[from] LimitExceeded),
}

impl Error {
    pub fn parse(message: impl Into<String>) -> Self {
        Self::parse_at(message, 0, 0)
    }

    pub fn parse_at(message: impl Into<String>, line: usize, column: usize) -> Self {
        Self::Parse {
            message: message.into(),
            line,
            column,
        }
    }
}

// Format directly into a bounded UTF-8 buffer. Formatting first and truncating
// afterwards would allocate an entire attacker-controlled token diagnostic.
const MAX_DIAGNOSTIC_BYTES: usize = 1024;

struct Diagnostic(String);

impl Write for Diagnostic {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let available = MAX_DIAGNOSTIC_BYTES - self.0.len();
        let mut end = text.len().min(available);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.0.push_str(&text[..end]);
        if end < text.len() {
            return Err(fmt::Error);
        }
        Ok(())
    }
}

pub(crate) fn bounded_diagnostic(args: fmt::Arguments<'_>) -> String {
    let mut output = Diagnostic(String::with_capacity(MAX_DIAGNOSTIC_BYTES));
    let _ = output.write_fmt(args);
    output.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_bounded_in_bytes_and_preserve_utf8() {
        let token = "界".repeat(100_000);
        let message = bounded_diagnostic(format_args!("near `{token}'"));
        assert!(message.len() <= MAX_DIAGNOSTIC_BYTES);
        assert_eq!(message.capacity(), MAX_DIAGNOSTIC_BYTES);
        assert!(message.starts_with("near `界"));
    }

    #[test]
    fn short_diagnostics_are_unchanged() {
        assert_eq!(bounded_diagnostic(format_args!("near `fi'")), "near `fi'");
    }
}
