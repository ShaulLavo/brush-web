//! Original bounded locale adapter. Bashkit's full Rust Unicode expansion is
//! deliberately not used: GNU Bash maps one character to at most one character.
use super::Error;
use crate::state::SharedState;

#[derive(Clone, Copy)]
pub(super) enum Locale {
    C,
    Utf8,
}
impl Locale {
    pub(super) fn from_state(state: &SharedState) -> Result<Self, Error> {
        let s = state.borrow();
        let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .filter_map(|name| s.variables.get(*name))
            .find(|value| !value.is_empty())
            .map(String::as_str)
            .unwrap_or("C");
        match locale {
            "C" | "POSIX" => Ok(Self::C),
            "C.UTF-8" | "C.utf8" => Ok(Self::Utf8),
            _ => Err(2.into()),
        }
    }
    pub(super) fn utf8(self) -> bool {
        matches!(self, Self::Utf8)
    }
    pub(super) fn map(self, ch: char, upper: bool) -> Result<char, Error> {
        if ch.is_ascii() {
            return Ok(if upper {
                ch.to_ascii_uppercase()
            } else {
                ch.to_ascii_lowercase()
            });
        }
        if !self.utf8() {
            return Ok(ch);
        }
        // Latin-1 input only, verified exhaustively against GNU Bash C.UTF-8.
        // U+00DF stays unchanged, rather than expanding to Rust's "SS".
        if ch > '\u{ff}' {
            return Err(2.into());
        }
        let mapped = match (upper, ch) {
            (true, '\u{e0}'..='\u{f6}' | '\u{f8}'..='\u{fe}') => ch as u32 - 32,
            (false, '\u{c0}'..='\u{d6}' | '\u{d8}'..='\u{de}') => ch as u32 + 32,
            (true, 'µ') => 'Μ' as u32,
            (true, 'ÿ') => 'Ÿ' as u32,
            _ => ch as u32,
        };
        char::from_u32(mapped).ok_or_else(|| 2.into())
    }
}
