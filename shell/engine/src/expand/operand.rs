//! Scalar operand quote handling adapted from Bashkit's operand_word and
//! parse_marked_operand. Unlike upstream, protection never enters string data.
use super::Work;
use crate::executor::Cancel;
use shell_parser::parser::{ParameterOp, Parser, WordPart};

pub(super) const MAX_DEPTH: usize = 32;
// Each synchronous parser call receives one admitted scalar token. Large
// literal runs stream through the scanner without entering the parser.
const MAX_TOKEN_BYTES: usize = 4096;

pub(super) fn scalar_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
fn basic_name(name: &str) -> bool {
    scalar_name(name)
        || name == "?"
        || name == "#"
        || name.bytes().all(|c| c.is_ascii_digit()) && !name.is_empty()
}

pub(super) enum Piece<'a> {
    Text { value: &'a str, protected: bool },
    Expansion { part: WordPart, protected: bool },
}
#[derive(Clone, Copy, PartialEq)]
enum Quote {
    None,
    Single,
    Double,
}

pub(super) struct Scanner<'a> {
    source: &'a str,
    cursor: usize,
    quote: Quote,
    outer_quoted: bool,
}
impl<'a> Scanner<'a> {
    pub(super) fn new(source: &'a str, outer_quoted: bool) -> Self {
        Self {
            source,
            cursor: 0,
            quote: Quote::None,
            outer_quoted,
        }
    }
    fn protected(&self) -> bool {
        self.quote != Quote::None
    }
    fn take(&mut self) -> Option<&'a str> {
        let ch = self.source[self.cursor..].chars().next()?;
        let start = self.cursor;
        self.cursor += ch.len_utf8();
        Some(&self.source[start..self.cursor])
    }
    fn peek(&self) -> Option<char> {
        self.source[self.cursor..].chars().next()
    }
    fn text(&self, value: &'a str, protected: bool) -> Piece<'a> {
        Piece::Text { value, protected }
    }
    pub(super) async fn next(
        &mut self,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<Piece<'a>>, i32> {
        work.checkpoint(cancel).await?;
        let start = self.cursor;
        let Some(value) = self.take() else {
            return if self.quote == Quote::None {
                Ok(None)
            } else {
                Err(2)
            };
        };
        let ch = value.chars().next().ok_or(2)?;
        if ch == '\0' {
            let escaped = self.take().ok_or(2)?;
            return Ok(Some(self.text(escaped, true)));
        }
        if ch == '\\' && self.quote != Quote::Single {
            return self.escape(value).map(Some);
        }
        if ch == '"' && self.quote != Quote::Single {
            self.quote = if self.quote == Quote::Double {
                Quote::None
            } else {
                Quote::Double
            };
            return Ok(Some(self.text("", true)));
        }
        if ch == '\'' && self.quote != Quote::Double && !self.outer_quoted {
            self.quote = if self.quote == Quote::Single {
                Quote::None
            } else {
                Quote::Single
            };
            return Ok(Some(self.text("", true)));
        }
        if self.quote == Quote::Single {
            return Ok(Some(self.text(value, true)));
        }
        if ch == '$' {
            return self.expansion(start, work, cancel).await.map(Some);
        }
        self.check_literal(ch)?;
        Ok(Some(self.text(value, self.protected())))
    }
    fn escape(&mut self, slash: &'a str) -> Result<Piece<'a>, i32> {
        let next = self.peek().ok_or(2)?;
        let double = self.outer_quoted || self.quote == Quote::Double;
        if double
            && !matches!(next, '$' | '`' | '"' | '\\' | '\n')
            && !(self.outer_quoted && next == '}')
        {
            return Ok(self.text(slash, true));
        }
        let value = self.take().ok_or(2)?;
        Ok(self.text(if value == "\n" { "" } else { value }, value != "\n"))
    }
    fn check_literal(&self, ch: char) -> Result<(), i32> {
        if ch == '`'
            || !self.protected()
                && !self.outer_quoted
                && matches!(ch, '<' | '>')
                && self.peek() == Some('(')
        {
            return Err(2);
        }
        if !self.protected()
            && !self.outer_quoted
            && matches!(ch, '*' | '?' | '[' | '{' | '}' | '~')
        {
            return Err(2);
        }
        Ok(())
    }
    async fn expansion(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Piece<'a>, i32> {
        match self.peek() {
            Some('{') => self.braced(work, cancel).await?,
            Some(c) if c.is_ascii_alphabetic() || c == '_' => self.identifier(work, cancel).await?,
            Some(c) if c.is_ascii_digit() || matches!(c, '?' | '#') => {
                self.take();
            }
            Some('(' | '\'' | '"' | '@' | '*' | '!' | '$' | '-') => return Err(2),
            _ => return Ok(self.text("$", self.protected())),
        }
        let token = &self.source[start..self.cursor];
        validate_token(token)?;
        work.admit_parse(token.len(), cancel).await?;
        // Validation permits only a basic variable or a scalar +/- header.
        // Their parser paths retain nested operands as raw text, never recursively
        // parsing scripts. The byte cap also bounds lexer and fallback allocation.
        let word = Parser::parse_word_string_with_limits(token, MAX_DEPTH, MAX_TOKEN_BYTES * 16);
        work.checkpoint(cancel).await?;
        let mut parts = word.parts.into_iter();
        let part = parts.next().ok_or(2)?;
        if parts.next().is_some() || !supported(&part) {
            return Err(2);
        }
        Ok(Piece::Expansion {
            part,
            protected: self.protected(),
        })
    }
    async fn identifier(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), i32> {
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            work.checkpoint(cancel).await?;
            self.take();
        }
        Ok(())
    }
    async fn braced(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), i32> {
        let start = self.cursor - 1;
        self.take();
        let mut depth: usize = 1;
        while let Some(value) = self.take() {
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2);
            }
            if value == "$" && self.peek() == Some('(') {
                self.skip_command(start, work, cancel).await?;
                continue;
            }
            self.brace_step(value, &mut depth)?;
            if depth > MAX_DEPTH {
                return Err(2);
            }
            if depth == 0 {
                return Ok(());
            }
        }
        Err(2)
    }
    // A skipped nested scalar operand may contain unsupported substitution
    // text. Match its boundary without parsing or evaluating that script.
    // Heredocs and comment syntax fail closed instead of guessing boundaries.
    async fn skip_command(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), i32> {
        self.take();
        let mut quotes = [Quote::None; MAX_DEPTH];
        let mut depth: usize = 1;
        while let Some(value) = self.take() {
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2);
            }
            let quote = &mut quotes[depth - 1];
            if value == "\\" && *quote != Quote::Single {
                self.take().ok_or(2)?;
                continue;
            }
            if value == "'" && *quote != Quote::Double {
                toggle_quote(quote, Quote::Single);
                continue;
            }
            if value == "\"" && *quote != Quote::Single {
                toggle_quote(quote, Quote::Double);
                continue;
            }
            if *quote != Quote::None {
                continue;
            }
            if value == "#" || value == "<" && self.peek() == Some('<') {
                return Err(2);
            }
            if value == "`" {
                self.skip_backticks(start, work, cancel).await?;
            }
            if value == "(" {
                depth = depth.checked_add(1).filter(|&d| d <= MAX_DEPTH).ok_or(2)?;
            }
            if value == ")" {
                depth -= 1;
            }
            if depth == 0 {
                return Ok(());
            }
        }
        Err(2)
    }
    async fn skip_backticks(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), i32> {
        while let Some(value) = self.take() {
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2);
            }
            if value == "`" {
                return Ok(());
            }
            if value == "\\" {
                self.take().ok_or(2)?;
            }
        }
        Err(2)
    }
    fn brace_step(&mut self, value: &str, depth: &mut usize) -> Result<(), i32> {
        match value {
            "\0" | "\\" => {
                self.take().ok_or(2)?;
            }
            "{" => *depth += 1,
            "}" => *depth -= 1,
            _ => {}
        }
        Ok(())
    }
}

fn toggle_quote(current: &mut Quote, quote: Quote) {
    *current = if *current == quote {
        Quote::None
    } else {
        quote
    };
}

fn validate_token(token: &str) -> Result<(), i32> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(2);
    }
    let Some(body) = token.strip_prefix("${").and_then(|s| s.strip_suffix('}')) else {
        return if basic_name(&token[1..]) {
            Ok(())
        } else {
            Err(2)
        };
    };
    if basic_name(body) {
        return Ok(());
    }
    let name_end = body
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .unwrap_or(body.len());
    let name = &body[..name_end];
    let suffix = &body[name_end..];
    let operator = suffix.strip_prefix(':').unwrap_or(suffix);
    if !scalar_name(name) || !operator.starts_with(['-', '+']) {
        return Err(2);
    }
    Ok(())
}
fn supported(part: &WordPart) -> bool {
    match part {
        WordPart::Variable(name) => basic_name(name),
        WordPart::ParameterExpansion { name, operator, .. } => {
            scalar_name(name)
                && matches!(
                    operator,
                    ParameterOp::UseDefault | ParameterOp::UseReplacement
                )
        }
        _ => false,
    }
}
