//! Scalar operand quote handling adapted from Bashkit's operand_word and
//! parse_marked_operand. Unlike upstream, protection never enters string data.
use super::{Error, Work};
use crate::executor::Cancel;
use shell_parser::parser::parameter_scan::{ParameterScan, Step};
use shell_parser::parser::{ParameterOp, Parser, WordPart};

// Keep scalar expansion/parser recursion below the native test-thread stack
// limit. The parser's general hard cap is intentionally higher for scripts,
// but scalar operands are reparsed from nested futures and need a smaller
// bound so malformed/deep operands return status 2 instead of overflowing.
pub(super) const MAX_DEPTH: usize = 16;
// Each synchronous parser call receives one admitted scalar token. Large
// literal runs stream through the scanner without entering the parser.
const MAX_TOKEN_BYTES: usize = 4096;
// The boundary scanner keeps a frame per open `$(`/quote, the current
// keyword and here-document delimiter and line text: linear in input.
const SCANNER_BASE: usize = 2048;
const SCANNER_PER_CHAR: usize = 128;

pub(super) fn scalar_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
pub(super) fn length_name(name: &str) -> bool {
    scalar_name(name)
        || matches!(name, "?" | "#")
        || name.bytes().all(|c| c.is_ascii_digit()) && name.bytes().any(|c| c != b'0')
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
    pattern: bool,
    pattern_source: bool,
}
impl<'a> Scanner<'a> {
    pub(super) fn new(
        source: &'a str,
        outer_quoted: bool,
        pattern: bool,
        pattern_source: bool,
    ) -> Self {
        Self {
            source,
            cursor: 0,
            quote: Quote::None,
            outer_quoted,
            pattern,
            pattern_source,
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
    ) -> Result<Option<Piece<'a>>, Error> {
        work.checkpoint(cancel).await?;
        let start = self.cursor;
        let Some(value) = self.take() else {
            return if self.quote == Quote::None {
                Ok(None)
            } else {
                Err(2.into())
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
        if ch == '`' {
            let part = self.backticks(start, work, cancel).await?;
            return Ok(Some(Piece::Expansion {
                part,
                protected: self.protected(),
            }));
        }
        if !self.protected()
            && !self.outer_quoted
            && matches!(ch, '<' | '>')
            && self.peek() == Some('(')
        {
            let part = self.process(start, ch == '<', work, cancel).await?;
            return Ok(Some(Piece::Expansion {
                part,
                protected: false,
            }));
        }
        self.check_literal(ch)?;
        // Bash protects source spaces in a pattern, but not source tabs/newlines.
        // Expansion-provided spaces retain the expansion's existing IFS rules.
        let protected = self.protected() || self.pattern_source && ch == ' ';
        Ok(Some(self.text(value, protected)))
    }
    fn escape(&mut self, slash: &'a str) -> Result<Piece<'a>, Error> {
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
    fn check_literal(&self, ch: char) -> Result<(), Error> {
        if !self.protected()
            && !self.outer_quoted
            && matches!(ch, '<' | '>')
            && self.peek() == Some('(')
        {
            return Err(2.into());
        }
        if !self.protected()
            && !self.outer_quoted
            && (ch == '~' || !self.pattern && matches!(ch, '*' | '?' | '['))
        {
            return Err(2.into());
        }
        Ok(())
    }
    async fn expansion(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Piece<'a>, Error> {
        match self.peek() {
            Some('{') => self.braced(work, cancel).await?,
            Some(c) if c.is_ascii_alphabetic() || c == '_' => self.identifier(work, cancel).await?,
            Some(c) if c.is_ascii_digit() || matches!(c, '?' | '#') => {
                self.take();
            }
            Some('(') => {
                self.skip_command(start, work, cancel).await?;
                let part = substitution(&self.source[start..self.cursor], work, cancel).await?;
                return Ok(Piece::Expansion {
                    part,
                    protected: self.protected(),
                });
            }
            Some('\'' | '"' | '@' | '*' | '!' | '$' | '-') => return Err(2.into()),
            _ => return Ok(self.text("$", self.protected())),
        }
        let token = &self.source[start..self.cursor];
        validate_token(token, work)?;
        work.admit_parse(token.len(), cancel).await?;
        // Bound the scalar AST's owned strings and parser token allocations
        // before entering the synchronous, byte-capped parser.
        if work.arithmetic_depth != 0 || matches_substring(token) {
            work.admit_storage(token.len().saturating_mul(16).saturating_add(512))?;
        }
        // Validation permits only a basic variable or a scalar operator header.
        // Their parser paths retain nested operands as raw text, never recursively
        // parsing scripts. The byte cap also bounds lexer and fallback allocation.
        let part = if token.starts_with("${") {
            Parser::parse_parameter_token_with_limits(
                token,
                MAX_DEPTH,
                MAX_TOKEN_BYTES * 16,
                self.outer_quoted || self.quote == Quote::Double,
                self.quote != Quote::Double && (self.pattern || self.pattern_source),
            )
            .map_err(|_| Error::from(2))?
        } else {
            let word =
                Parser::parse_word_string_with_limits(token, MAX_DEPTH, MAX_TOKEN_BYTES * 16);
            let mut parts = word.parts.into_iter();
            let part = parts.next().ok_or(2)?;
            if parts.next().is_some() {
                return Err(2.into());
            }
            part
        };
        work.checkpoint(cancel).await?;
        if !supported(&part) {
            return Err(2.into());
        }
        Ok(Piece::Expansion {
            part,
            protected: self.protected(),
        })
    }
    async fn identifier(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            work.checkpoint(cancel).await?;
            self.take();
        }
        Ok(())
    }
    async fn braced(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        let start = self.cursor - 1;
        self.take();
        let mut scanner = ParameterScan::<MAX_DEPTH>::new(
            self.outer_quoted || self.quote == Quote::Double,
            self.quote != Quote::Double && (self.pattern || self.pattern_source),
        );
        while let Some(value) = self.take() {
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2.into());
            }
            match scanner.feed(value.chars().next().ok_or(2)?, self.peek()) {
                Step::Copy => {}
                Step::Escape | Step::Open => {
                    work.checkpoint(cancel).await?;
                    self.take().ok_or(2)?;
                }
                Step::Command => self.skip_command(start, work, cancel).await?,
                Step::Closed => return Ok(()),
                Step::Limit | Step::Delimiter => return Err(2.into()),
            }
        }
        bad_substitution("no closing `}'", work)
    }
    /// Find the `)` closing a `$(` (the cursor is at its `(`) with the
    /// parser's own boundary scanner, so quotes, comments, `case` patterns
    /// and here-documents inside the body hide a `)` exactly as when the
    /// script was parsed. The scanner's state is charged while it lives.
    async fn skip_command(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        self.take();
        let mut charged = SCANNER_BASE;
        work.admit_storage(SCANNER_BASE)?;
        let result = self.scan_command(start, &mut charged, work, cancel).await;
        work.release_storage(charged);
        result
    }
    async fn scan_command(
        &mut self,
        start: usize,
        charged: &mut usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let mut scanner = shell_parser::parser::CommandBoundaryScanner::new();
        while let Some(value) = self.take() {
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2.into());
            }
            work.admit_storage(SCANNER_PER_CHAR)?;
            *charged += SCANNER_PER_CHAR;
            let ch = value.chars().next().ok_or(2)?;
            if scanner.feed(ch) == shell_parser::parser::CommandBoundaryStep::Close {
                return Ok(());
            }
        }
        bad_substitution("no closing `)'", work)
    }
    /// An unquoted `<(...)` or `>(...)` (the cursor is at its `(`).
    async fn process(
        &mut self,
        start: usize,
        is_input: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<WordPart, Error> {
        self.skip_command(start, work, cancel).await?;
        let body = &self.source[start + 2..self.cursor - 1];
        work.admit_parse(body.len().saturating_add(2), cancel).await?;
        admit_syntax(body, work)?;
        match backtick_part(body).map_err(|_| Error::Status(2))? {
            WordPart::CommandSubstitution(commands) => {
                Ok(WordPart::ProcessSubstitution { commands, is_input })
            }
            _ => Err(2.into()),
        }
    }
    /// A backtick body, after Bash's backslash processing (`\$`, `` \` ``,
    /// `\\` and `\<newline>` lose their backslash), parsed only now.
    async fn backticks(
        &mut self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<WordPart, Error> {
        let mut body = String::new();
        loop {
            let Some(value) = self.take() else {
                return bad_substitution("no closing backtick", work).and(Err(2.into()));
            };
            work.checkpoint(cancel).await?;
            if self.cursor - start > MAX_TOKEN_BYTES {
                return Err(2.into());
            }
            if value == "`" {
                break;
            }
            let mut piece = value;
            if value == "\\" {
                let next = self.take().ok_or(2)?;
                if !matches!(next, "$" | "`" | "\\" | "\n") {
                    super::admit_string_growth(&mut body, 1, work)?;
                    body.push('\\');
                }
                piece = next;
            }
            super::admit_string_growth(&mut body, piece.len(), work)?;
            body.push_str(piece);
        }
        let token_parse = body.len().saturating_add(2);
        work.admit_parse(token_parse, cancel).await?;
        admit_syntax(&body, work)?;
        backtick_part(&body).map_err(|_| Error::Status(2))
    }
}

// Only a selected operand reaches these EOF failures. Unsupported complete
// substitutions and every byte/work/depth/cancellation limit retain their own
// status; malformed lazy substitution syntax is Bash's fatal status 1.
fn bad_substitution(message: &'static str, work: &mut Work) -> Result<(), Error> {
    // The renderer owns name/message and their formatted diagnostic together.
    work.admit_storage(("bad substitution".len() + message.len()) * 2 + 96)?;
    Err(Error::BadSubstitution {
        message,
        line: None,
    })
}

fn toggle_quote(current: &mut Quote, quote: Quote) {
    *current = if *current == quote {
        Quote::None
    } else {
        quote
    };
}

fn matches_substring(token: &str) -> bool {
    token
        .strip_prefix("${")
        .and_then(|body| body.split_once(':'))
        .is_some_and(|(_, suffix)| !suffix.starts_with(['-', '+', '=', '?']))
}
fn validate_token(token: &str, work: &mut Work) -> Result<(), Error> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(2.into());
    }
    let Some(body) = token.strip_prefix("${").and_then(|s| s.strip_suffix('}')) else {
        return if basic_name(&token[1..]) {
            Ok(())
        } else {
            Err(2.into())
        };
    };
    let indirect = body.starts_with('!');
    let body = body.strip_prefix('!').unwrap_or(body);
    if basic_name(body) && (!indirect || scalar_name(body)) {
        return Ok(());
    }
    if !indirect && body.strip_prefix('#').is_some_and(length_name) {
        return Ok(());
    }
    if !indirect
        && (body.starts_with("#!")
            || body.starts_with("#,")
            || body.starts_with("#^")
            || body.strip_prefix('#').is_some_and(|inner| {
                inner.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
                    && !basic_name(inner)
                    && !inner.contains('[')
            }))
    {
        return bad_substitution("invalid length parameter", work);
    }
    let name_end = if body.starts_with(['#', '?', '@']) {
        1
    } else {
        body.find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(body.len())
    };
    let name = &body[..name_end];
    let suffix = &body[name_end..];
    let operator = suffix.strip_prefix(':').unwrap_or(suffix);
    let trim = suffix.starts_with(['#', '%', '/', '^', ',']);
    let substring =
        !indirect && suffix.starts_with(':') && !operator.starts_with(['-', '+', '=', '?']);
    if !(scalar_name(name) || substring && (length_name(name) || name == "@"))
        || !(substring || !indirect && trim || operator.starts_with(['-', '+', '=', '?']))
    {
        return Err(2.into());
    }
    Ok(())
}
fn supported(part: &WordPart) -> bool {
    match part {
        WordPart::ArithmeticExpansion(_) | WordPart::BadSubstitution(_) => true,
        WordPart::Substring { name, .. } => length_name(name) || name == "@",
        WordPart::Variable(name) => basic_name(name),
        WordPart::Length(name) => length_name(name),
        WordPart::IndirectExpansion { name, operator, .. } => {
            scalar_name(name) && operator.as_ref().is_none_or(indirect_operator)
        }
        WordPart::ParameterExpansion { name, operator, .. } => {
            scalar_name(name)
                && matches!(
                    operator,
                    ParameterOp::UseDefault
                        | ParameterOp::UseReplacement
                        | ParameterOp::AssignDefault
                        | ParameterOp::Error
                        | ParameterOp::RemovePrefixShort
                        | ParameterOp::RemovePrefixLong
                        | ParameterOp::RemoveSuffixShort
                        | ParameterOp::RemoveSuffixLong
                        | ParameterOp::UpperFirst
                        | ParameterOp::UpperAll
                        | ParameterOp::LowerFirst
                        | ParameterOp::LowerAll
                        | ParameterOp::ReplaceFirst { .. }
                        | ParameterOp::ReplaceAll { .. }
                )
        }
        _ => false,
    }
}

// The AST already separates these operators from arbitrary indirect suffixes.
pub(super) fn indirect_operator(operator: &ParameterOp) -> bool {
    matches!(
        operator,
        ParameterOp::UseDefault
            | ParameterOp::UseReplacement
            | ParameterOp::AssignDefault
            | ParameterOp::Error
    )
}

/// Parse one `$(...)` token. The synchronous parser runs with the token's
/// admitted fuel; its AST is charged before it is built.
async fn substitution(token: &str, work: &mut Work, cancel: &Cancel) -> Result<WordPart, Error> {
    work.admit_parse(token.len(), cancel).await?;
    admit_syntax(token, work)?;
    substitution_part(token).map_err(|_| Error::Status(2))
}
/// AST storage for parsed shell text, as for reparsed brace words: owned
/// text and lexical metadata scale with bytes, nodes with syntax characters.
fn admit_syntax(text: &str, work: &mut Work) -> Result<(), Error> {
    let syntax = text
        .chars()
        .filter(|&ch| ch.is_whitespace() || "$\\'\"`<>()|;&{}".contains(ch))
        .count();
    let slot = std::mem::size_of::<WordPart>()
        + std::mem::size_of::<shell_parser::parser::Word>()
        + std::mem::size_of::<shell_parser::parser::Command>();
    work.admit_storage(
        text.len()
            .saturating_mul(128)
            .saturating_add(syntax.saturating_mul(4).saturating_mul(slot))
            .saturating_add(512),
    )
}
// Keep the parser's synchronous frames out of the recursive expansion future.
#[inline(never)]
fn substitution_part(token: &str) -> shell_parser::Result<WordPart> {
    Parser::parse_substitution_token_with_limits(
        token,
        shell_parser::limits::ExecutionLimits::default().max_ast_depth,
        token.len().saturating_add(3).saturating_mul(16),
    )
}
#[inline(never)]
fn backtick_part(body: &str) -> shell_parser::Result<WordPart> {
    Parser::parse_backtick_body_with_limits(
        body,
        shell_parser::limits::ExecutionLimits::default().max_ast_depth,
        body.len().saturating_add(3).saturating_mul(16),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_diagnostics_admit_both_owned_and_formatted_copies() {
        let message = "no closing backtick";
        let bytes = ("bad substitution".len() + message.len()) * 2 + 96;
        let mut rejected = Work::new(1, bytes - 1, 1);
        assert!(matches!(
            bad_substitution(message, &mut rejected),
            Err(Error::Status(2))
        ));
        assert_eq!(rejected.storage_remaining, bytes - 1);
        let mut admitted = Work::new(1, bytes, 1);
        assert!(matches!(
            bad_substitution(message, &mut admitted),
            Err(Error::BadSubstitution { .. })
        ));
        assert_eq!(admitted.storage_remaining, 0);
    }
}
