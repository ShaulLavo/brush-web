//! Parser module for Bashkit
//!
//! Implements a recursive descent parser for bash scripts.
//!
//! # Design Notes
//!
//! Substitution parsers share the enclosing AST depth and start time. Keep child
//! parsers heap-owned and nonrecursive AST assembly out of recursive frames so
//! the hard depth ceiling is safe on default 2 MiB test-thread stacks (TM-DOS-044).
//!
//! Reserved words (like `done`, `fi`, `then`) are only treated as special in command
//! position - when they would start a command. In argument position, they are regular
//! words. The termination of compound commands is handled by `parse_compound_list_until`
//! which checks for terminators BEFORE parsing each command.
//!
//! Grammar errors are worded the way bash words them, by the token the parse
//! stopped at (see `Parser::error`): `syntax error near unexpected token
//! `fi'`, or `syntax error: unexpected end of file` reported on the line after
//! the last when the input ran out inside a construct.

// Parser uses chars().next().unwrap() after validating character presence.
// This is safe because we check bounds before accessing.
#![allow(clippy::unwrap_used)]

mod ast;
pub mod budget;
mod lexer;
mod lexical;
pub mod parameter_scan;
mod print_cmd;
mod raw;
mod span;
mod subst_scan;
mod substring;
mod tokens;

pub use ast::*;
pub use budget::{BudgetError, validate as validate_budget};
pub use lexer::{Lexer, SpannedToken};
pub use print_cmd::function_string;
pub(crate) use print_cmd::word_text;
pub use span::{Position, Span};
pub use subst_scan::{Step as CommandBoundaryStep, SubstScanner as CommandBoundaryScanner};

use crate::error::{Error, Result};
use crate::limits::LimitExceeded;
use crate::time_compat::Instant;
use lexical::{LiteralEscape, WordChars};
use raw::{heredoc_eof_from_raw, single_quote, split_raw_words};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Shell state that changes how text parses, taken from the interpreter
/// when a parse starts (bash reads and parses a line at a time, so an
/// `alias` or `shopt -s extglob` affects the lines after it).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParseOptions {
    /// Aliases to expand (`shopt -s expand_aliases` on); `None` when off.
    pub aliases: Option<Arc<HashMap<String, String>>>,
    /// `shopt -s extglob`: `!(` starts a pattern group, not `!` + subshell.
    pub extglob: bool,
}

/// Default maximum AST depth (matches ExecutionLimits default)
const DEFAULT_MAX_AST_DEPTH: usize = 100;

/// Hard cap on AST depth to prevent stack overflow even if caller misconfigures limits.
/// THREAT[TM-DOS-022]: Protects against deeply nested input attacks where
/// a large max_depth setting allows recursion deep enough to overflow the native stack.
/// This cap cannot be overridden by the caller.
///
/// Set conservatively to avoid stack overflow on tokio's blocking threads (default 2MB
/// stack in debug builds). Each parser recursion level uses ~4-8KB of stack in debug
/// mode. 100 levels × ~8KB = ~800KB, well within 2MB.
/// In release builds this could safely be higher, but we use one value for consistency.
pub(crate) const HARD_MAX_AST_DEPTH: usize = 100;

/// Default maximum parser operations (matches ExecutionLimits default)
const DEFAULT_MAX_PARSER_OPERATIONS: usize = 100_000;

/// Parser for bash scripts.
pub struct Parser<'a> {
    input: &'a str,
    lexer: Lexer<'a>,
    current_token: Option<tokens::Token>,
    /// Span of the current token
    current_span: Span,
    /// Lookahead token for function parsing
    peeked_token: Option<SpannedToken>,
    /// Source text of the current word token, before quote removal and
    /// parameter parsing. Brace expansion precedes those transformations.
    current_raw: Option<String>,
    current_escapes: Vec<LiteralEscape>,
    /// Maximum allowed AST nesting depth
    max_depth: usize,
    /// Current nesting depth
    current_depth: usize,
    /// Remaining fuel for parsing operations
    fuel: Cell<usize>,
    /// Maximum fuel (for error reporting)
    max_fuel: usize,
    /// Optional parser timeout enforced via cooperative checks in `tick`.
    timeout: Option<Duration>,
    /// Parse start time used with `timeout`.
    started_at: Instant,
    /// A syntax error raised inside `parse_word`, which is infallible because
    /// it is also reachable from the interpreter's lazy expansion path. Set
    /// when a `$(...)` body fails to parse; `parse_script` converts it into a
    /// hard parse error so the script is rejected the way bash rejects it.
    deferred_error: Cell<Option<Error>>,
    parameter_word_boundaries: bool,
    /// The returned error came from (or coexisted with) a deferred `$(...)`
    /// error, whose position is unreliable; see [`Parser::parse_recovering`].
    error_was_deferred: bool,
    /// Line the top-level command being parsed starts on; on failure, only
    /// commands that ended on earlier lines are runnable.
    failed_command_line: usize,
    /// Aggregate request budget shared by every child parser.
    execution_budget: Option<crate::limits::ExecutionBudget>,
    /// Shell options that change parsing (aliases, extglob).
    options: ParseOptions,
    strict_command_separators: bool,
    /// Parse `$(...)`/`<(...)` bodies with strict separators even when this
    /// level is lenient (see `with_strict_substitution_bodies`).
    strict_substitution_bodies: bool,
    /// The current token is a word with no quoting (alias candidate).
    current_plain: bool,
    /// The current token follows a blank-ending alias value.
    current_after_blank: bool,
    /// End offset of the token consumed last: a token that starts there
    /// touches it (`x<(true)` is one word, see `join_adjacent_word`).
    prev_token_end: usize,
    /// End line of the consumed token, before lookahead advances the lexer.
    last_token_line: usize,
    /// The next `parse_command_list` call reads a top-level command: a
    /// newline after `;` or `&` ends it, as bash's reader ends a line.
    top_level_list: bool,
    /// Byte offset and line where each top-level command starts.
    top_starts: Vec<(usize, usize)>,
    /// Offset and line of the top-level command being parsed.
    failed_command_start: (usize, usize),
}

impl<'a> Parser<'a> {
    /// Create a new parser for the given input.
    pub fn new(input: &'a str) -> Self {
        Self::with_limits(input, DEFAULT_MAX_AST_DEPTH, DEFAULT_MAX_PARSER_OPERATIONS)
    }

    /// Create a new parser with a custom maximum AST depth.
    pub fn with_max_depth(input: &'a str, max_depth: usize) -> Self {
        Self::with_limits(input, max_depth, DEFAULT_MAX_PARSER_OPERATIONS)
    }

    /// Create a new parser with a custom fuel limit.
    pub fn with_fuel(input: &'a str, max_fuel: usize) -> Self {
        Self::with_limits(input, DEFAULT_MAX_AST_DEPTH, max_fuel)
    }

    /// Create a new parser with custom depth and fuel limits.
    ///
    /// THREAT[TM-DOS-022]: `max_depth` is clamped to `HARD_MAX_AST_DEPTH` (100)
    /// to prevent stack overflow from misconfiguration. Even if the caller passes
    /// `max_depth = 1_000_000`, the parser will cap it at 100.
    pub fn with_limits(input: &'a str, max_depth: usize, max_fuel: usize) -> Self {
        Self::with_limits_and_timeout(input, max_depth, max_fuel, None)
    }

    /// Create a new parser with custom limits and optional timeout.
    pub fn with_limits_and_timeout(
        input: &'a str,
        max_depth: usize,
        max_fuel: usize,
        timeout: Option<Duration>,
    ) -> Self {
        Self::with_limits_timeout_options(
            input,
            max_depth,
            max_fuel,
            timeout,
            ParseOptions {
                aliases: None,
                extglob: true,
            },
        )
    }

    /// Set lexical options before reading the first token, including when the
    /// entire input is an extended-pattern lookalike.
    pub fn with_limits_and_options(
        input: &'a str,
        max_depth: usize,
        max_fuel: usize,
        options: ParseOptions,
    ) -> Self {
        Self::with_limits_timeout_options(input, max_depth, max_fuel, None, options)
    }

    fn with_limits_timeout_options(
        input: &'a str,
        max_depth: usize,
        max_fuel: usize,
        timeout: Option<Duration>,
        options: ParseOptions,
    ) -> Self {
        let mut lexer = Lexer::with_max_subst_depth(input, max_depth.min(HARD_MAX_AST_DEPTH));
        lexer.set_extglob_bang(options.extglob);
        lexer.set_capture_raw(true);
        let spanned = lexer.next_spanned_token();
        let (current_token, current_span, current_escapes, current_raw) = match spanned {
            Some(st) => (Some(st.token), st.span, st.literal_escapes, st.raw),
            None => (None, Span::new(), Vec::new(), None),
        };
        // The first token was lexed before any alias table was attached:
        // it is plain when it reads exactly as its source text.
        let current_plain = matches!(&current_token, Some(tokens::Token::Word(w))
            if input.get(current_span.start.offset..current_span.end.offset) == Some(w.as_str()));
        let mut parser = Self {
            input,
            lexer,
            current_token,
            current_span,
            peeked_token: None,
            current_raw,
            current_escapes,
            max_depth: max_depth.min(HARD_MAX_AST_DEPTH),
            current_depth: 0,
            fuel: Cell::new(max_fuel),
            max_fuel,
            timeout,
            started_at: Instant::now(),
            deferred_error: Cell::new(None),
            parameter_word_boundaries: true,
            error_was_deferred: false,
            failed_command_line: 0,
            execution_budget: None,
            options,
            strict_command_separators: false,
            strict_substitution_bodies: false,
            current_plain,
            current_after_blank: false,
            prev_token_end: usize::MAX,
            last_token_line: 1,
            top_level_list: false,
            top_starts: Vec::new(),
            failed_command_start: (0, 1),
        };
        parser.charge_literal_escapes();
        parser
    }

    /// Parse with the shell's alias table and `extglob` setting.
    pub fn with_options(mut self, options: ParseOptions) -> Self {
        self.set_options(options);
        self
    }

    /// Require separators between completed commands when validating a captured
    /// shell body. Whole-script callers retain the original parser behavior.
    /// Aliases may change command boundaries when the interpreter reads a unit.
    pub fn with_strict_command_separators(mut self) -> Self {
        self.strict_command_separators = true;
        self
    }

    /// Bash parses command substitution bodies with the script but without
    /// expanding aliases (`parse_comsub`), so a word after a completed
    /// compound command (`$( (x) y)`) is always a syntax error there. A
    /// whole-script caller that stays lenient for aliases defined while the
    /// script runs still gets bash's grammar inside substitution bodies.
    pub fn with_strict_substitution_bodies(mut self) -> Self {
        self.strict_substitution_bodies = true;
        self
    }

    fn set_options(&mut self, options: ParseOptions) {
        self.lexer.set_track_plain(options.aliases.is_some());
        self.lexer.set_extglob_bang(options.extglob);
        self.options = options;
    }

    /// Count lines from `line` (text taken from later in a larger source).
    pub(crate) fn starting_at_line(mut self, line: usize) -> Self {
        let shift = line.saturating_sub(1);
        if shift > 0 {
            self.lexer.shift_lines(shift);
            self.current_span.start.line += shift;
            self.current_span.end.line += shift;
        }
        self
    }

    /// Expand an alias named by the current word, if it is one: its value
    /// is read in place of the word (bash `alias_expand_token`).
    /// THREAT[TM-DOS-030]: each expansion is charged to parser fuel by its
    /// length, so chains of blank-ending aliases cannot grow without bound.
    fn try_expand_alias(&mut self) -> bool {
        let Some(aliases) = self.options.aliases.as_ref() else {
            return false;
        };
        let Some(tokens::Token::Word(w)) = &self.current_token else {
            return false;
        };
        if !self.current_plain || self.peeked_token.is_some() || self.lexer.alias_active(w) {
            return false;
        }
        let Some(text) = aliases.get(w.as_str()) else {
            return false;
        };
        let text = text.clone();
        let name = w.clone();
        if let Err(e) = self.tick_units(text.len() + 1) {
            self.deferred_error.set(Some(e));
            return false;
        }
        self.lexer.push_alias(&name, &text);
        self.advance_token();
        true
    }

    /// Expand aliases in command position (also through values that name
    /// another alias: `alias FOR2='FOR1 '`).
    fn expand_command_alias(&mut self) {
        if self.options.aliases.is_some() {
            while self.try_expand_alias() {}
        }
    }

    /// Attach the non-resettable aggregate budget for this request.
    pub fn with_execution_budget(mut self, budget: crate::limits::ExecutionBudget) -> Self {
        self.attach_execution_budget(budget);
        self
    }

    fn attach_execution_budget(&mut self, budget: crate::limits::ExecutionBudget) {
        // The first token is lexed during construction, before the parent's
        // shared budget can be attached. Include its replay/escape work too.
        if let Err(err) = budget.consume_work(
            u64::try_from(self.max_fuel.saturating_sub(self.fuel.get())).unwrap_or(u64::MAX),
        ) {
            let first = self.deferred_error.take();
            self.deferred_error.set(first.or(Some(err.into())));
        }
        self.execution_budget = Some(budget);
    }

    /// Get the current token's span.
    pub fn current_span(&self) -> Span {
        self.current_span
    }

    /// Parse a string as a word (handling $var, $((expr)), ${...}, etc.).
    /// Used by the interpreter to expand operands in parameter expansions lazily.
    pub fn parse_word_string(input: &str) -> Word {
        let parser = Parser::new(input);
        parser.parse_word(input.to_string())
    }

    /// THREAT[TM-DOS-050]: Parse a word string with caller-configured limits.
    /// Prevents bypass of parser limits in parameter expansion contexts.
    pub fn parse_word_string_with_limits(input: &str, max_depth: usize, max_fuel: usize) -> Word {
        let parser = Parser::with_limits(input, max_depth, max_fuel);
        parser.parse_word(input.to_string())
    }

    /// Parse one already-admitted word produced by textual brace expansion.
    /// This is word lexing only: reserved words, assignments and a standalone
    /// `{` are data, not command grammar. The caller bounds input and admits
    /// synchronous work/storage before entering this API. Generated syntax
    /// characters that are literal data must retain their lexical protection.
    /// No brace expansion is performed here.
    pub fn parse_expanded_word_with_limits(
        input: &str,
        max_depth: usize,
        max_fuel: usize,
    ) -> Result<Word> {
        // First read an inert word to leave lexical assignment position:
        // a generated `[` is a literal, not an unterminated array subscript.
        // A second inert prefix forces word context for empty text, reserved
        // words and standalone braces. Remove only that prefix structurally.
        let size = input
            .len()
            .checked_add(3)
            .filter(|size| *size <= max_fuel)
            .ok_or(LimitExceeded::ParserFuel {
                used: max_fuel,
                limit: max_fuel,
            })?;
        // Admit storage before copying, then share work across every child:
        // sibling substitutions must not each receive a fresh allowance.
        let budget = crate::limits::ExecutionBudget::new(
            &crate::limits::ExecutionLimits {
                max_work_units: u64::try_from(max_fuel).unwrap_or(u64::MAX),
                timeout: Duration::MAX,
                ..crate::limits::ExecutionLimits::default()
            },
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let mut prefixed = String::with_capacity(size);
        prefixed.push_str("x x");
        prefixed.push_str(input);
        let mut parser = Parser::with_limits(&prefixed, max_depth, max_fuel)
            .with_execution_budget(budget.clone());
        parser.tick_units(size)?;
        parser.advance();
        parser.check_error_token()?;
        let (text, quoted, glob) = match &parser.current_token {
            Some(tokens::Token::Word(text)) => (text.clone(), false, false),
            Some(tokens::Token::QuotedWord(text)) => (text.clone(), true, false),
            Some(tokens::Token::QuotedGlobWord(text)) => (text.clone(), true, true),
            _ => return Err(parser.error("expected one expanded word")),
        };
        let mut word = parser.parse_word_inner(text, &parser.current_escapes, true);
        budget.check()?;
        if let Some(error) = parser.deferred_error.take() {
            return Err(error);
        }
        let Some(WordPart::Literal(prefix)) = word.parts.first_mut() else {
            return Err(parser.error("expanded word lost its literal prefix"));
        };
        if !prefix.starts_with('x') {
            return Err(parser.error("expanded word lost its literal prefix"));
        }
        prefix.remove(0);
        if prefix.is_empty() && word.parts.len() > 1 {
            word.parts.remove(0);
            word.part_quoted.remove(0);
        }
        // A plain quoted token uses the whole-word flag; mixed tokens retain
        // per-part protection. Removing the prefix can make every part quoted.
        word.quoted = quoted || word.part_quoted.iter().all(|quoted| *quoted);
        word.has_unquoted_glob |= glob;
        word.raw = Some(input.to_string());
        parser.advance();
        parser.check_error_token()?;
        if parser.current_token.is_some() {
            return Err(parser.error("expected one expanded word"));
        }
        if let Some(error) = parser.deferred_error.take() {
            return Err(error);
        }
        budget.check()?;
        Ok(word)
    }

    /// Parse one already-admitted, boundary-scanned `$(...)` token from lazy
    /// operand text into the part a word would hold: a command substitution,
    /// an arithmetic `$((...))`, or a `$((` span bash parses only when it
    /// expands. Bodies use bash's substitution grammar. Work is bounded by
    /// `max_fuel`, depth by `max_depth`.
    pub fn parse_substitution_token_with_limits(
        input: &str,
        max_depth: usize,
        max_fuel: usize,
    ) -> Result<WordPart> {
        let budget = crate::limits::ExecutionBudget::new(
            &crate::limits::ExecutionLimits {
                max_work_units: u64::try_from(max_fuel).unwrap_or(u64::MAX),
                timeout: Duration::MAX,
                ..crate::limits::ExecutionLimits::default()
            },
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let parser = Parser::with_limits("", max_depth, max_fuel)
            .with_execution_budget(budget.clone())
            .with_strict_substitution_bodies();
        let mut chars = WordChars::new(input, &[]);
        if chars.next() != Some('$') || chars.next() != Some('(') {
            return Err(parser.error("expected command substitution token"));
        }
        let part = match parser.read_word_substitution(&mut chars)? {
            WordSubstitution::Arithmetic { expression, nested } => {
                for body in nested {
                    parser.validate_parameter_command(&body)?;
                }
                WordPart::ArithmeticExpansion(expression)
            }
            WordSubstitution::Command {
                body,
                fused,
                nested,
            } => {
                for body in nested {
                    parser.validate_parameter_command(&body)?;
                }
                match parser.parse_substitution_body(&body) {
                    Ok(script) => WordPart::CommandSubstitution(script.commands),
                    Err(error) => substitution_error(body, fused, error, 1)?,
                }
            }
        };
        budget.check()?;
        if chars.next().is_some() {
            return Err(parser.error("expected one command substitution"));
        }
        if let Some(error) = parser.deferred_error.take() {
            return Err(error);
        }
        Ok(part)
    }

    /// Parse a backtick body after its backslashes were processed. Bash
    /// parses it only when it expands: a syntax error becomes an unparsed
    /// substitution that reports itself and exits 2 in the child.
    pub fn parse_backtick_body_with_limits(
        body: &str,
        max_depth: usize,
        max_fuel: usize,
    ) -> Result<WordPart> {
        let budget = crate::limits::ExecutionBudget::new(
            &crate::limits::ExecutionLimits {
                max_work_units: u64::try_from(max_fuel).unwrap_or(u64::MAX),
                timeout: Duration::MAX,
                ..crate::limits::ExecutionLimits::default()
            },
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let parser = Parser::with_limits("", max_depth, max_fuel)
            .with_execution_budget(budget.clone())
            .with_strict_substitution_bodies();
        let part = match parser.parse_substitution_body(body) {
            Ok(script) => WordPart::CommandSubstitution(script.commands),
            Err(error @ Error::ResourceLimit(_)) => return Err(error),
            Err(Error::Parse { message, .. }) => WordPart::UnparsedCommandSubstitution {
                source: body.to_string(),
                error: message,
            },
            Err(Error::ShellWord { line }) => WordPart::UnparsedCommandSubstitution {
                source: body.to_string(),
                error: format!("syntax error while looking for matching `)' at line {line}"),
            },
        };
        budget.check()?;
        Ok(part)
    }

    /// Parse one already-admitted `${...}` token, retaining its enclosing
    /// operand context. Unlike a whole word this token has no quote markers.
    pub fn parse_parameter_token_with_limits(
        input: &str,
        max_depth: usize,
        max_fuel: usize,
        outer_quoted: bool,
        pattern: bool,
    ) -> Result<WordPart> {
        // The token has already been admitted and boundary-scanned by the
        // caller. Do not lex it again in an invented top-level quote context.
        let mut parser = Parser::with_limits("", max_depth, max_fuel);
        // The enclosing word reader has already checked lexical boundaries.
        // This API is also used inside opaque arithmetic text at expansion time.
        parser.parameter_word_boundaries = false;
        let mut chars = WordChars::new(input, &[]);
        if chars.next() != Some('$') || chars.peek() != Some(&'{') {
            return Err(parser.error("expected scalar parameter token"));
        }
        let mut parts = Vec::new();
        let mut quoted = Vec::new();
        // Boundary validation is off here, so no operand bodies are collected.
        parser.parse_braced_parameter(
            &mut chars,
            &mut parts,
            &mut quoted,
            outer_quoted,
            pattern,
            &mut Vec::new(),
        );
        if let Some(error) = parser.deferred_error.take() {
            return Err(error);
        }
        if chars.next().is_some() || parts.len() != 1 {
            return Err(parser.error("expected one scalar parameter token"));
        }
        Ok(parts.pop().unwrap())
    }

    /// Parse `input` as an unquoted here-document body: expansions apply,
    /// `"` is literal, and only `\$`, `` \` `` and `\\` are escapes. Used for
    /// prompt strings (`${x@P}`, PS1), which bash expands the same way.
    pub fn parse_heredoc_body_with_limits(input: &str, max_depth: usize, max_fuel: usize) -> Word {
        let parser = Parser::with_limits(input, max_depth, max_fuel);
        parser.parse_word(heredoc_body_escapes(input))
    }

    /// Prompt reparses must charge the same request budget as their caller.
    pub(crate) fn parse_prompt_body(
        input: &str,
        max_depth: usize,
        max_fuel: usize,
        budget: crate::limits::ExecutionBudget,
    ) -> Result<Word> {
        let parser =
            Parser::with_limits(input, max_depth, max_fuel).with_execution_budget(budget.clone());
        let word = parser.parse_word(heredoc_body_escapes(input));
        // Word parsing can turn child parse errors into literal text. A poisoned
        // request must still fail closed rather than continue with that fallback.
        budget.check()?;
        Ok(word)
    }

    /// Create a parse error with the current position. A grammar error
    /// (a construct that cannot continue with the current token) gets bash's
    /// wording instead of `message`; see [`Self::bash_grammar_error`].
    fn error(&self, message: impl Into<String>) -> Error {
        let message = message.into();
        if let Some(err) = self.bash_grammar_error(&message) {
            return err;
        }
        Error::parse_at(
            message,
            self.current_span.start.line,
            self.current_span.start.column,
        )
    }

    /// bash reports a grammar error by the token it stopped at: `syntax error
    /// near unexpected token `T'` (a line end is `newline`), or, when input
    /// ran out inside an unfinished construct, `syntax error: unexpected end
    /// of file` on the line after the last one.
    fn bash_grammar_error(&self, message: &str) -> Option<Error> {
        // Constructs that may continue on later lines: running out of input
        // is an unexpected end of file.
        // (`f(` must close on its own line: bash stops at `newline`.)
        let unfinished = message.starts_with("syntax error: empty ")
            || (message.starts_with("expected '") && !message.ends_with("function definition"))
            || message.starts_with("expected command after");
        if !unfinished
            && !message.starts_with("unexpected token")
            && !message.starts_with("expected '")
        {
            return None;
        }
        let line = self.current_span.start.line;
        let near = |token: &str| {
            Some(Error::parse_at(
                // THREAT[TM-DOS-136]: a quoted token may span the whole input.
                crate::error::bounded_diagnostic(format_args!(
                    "syntax error near unexpected token `{token}'"
                )),
                line,
                self.current_span.start.column,
            ))
        };
        match &self.current_token {
            None if unfinished => Some(Error::parse_at(
                "syntax error: unexpected end of file",
                self.input.lines().count() + 1,
                1,
            )),
            None | Some(tokens::Token::Newline) => near("newline"),
            Some(_) => {
                let span = self.current_span;
                match self.input.get(span.start.offset..span.end.offset) {
                    Some(text) if !text.is_empty() => near(text),
                    _ => None,
                }
            }
        }
    }

    fn current_command_end_offset(&self) -> usize {
        if self.current_token.is_some() {
            self.current_span.start.offset
        } else {
            // Important decision: EOF keeps `current_span` on the last real token;
            // use that token end so skipped trailing comments are not retained in
            // persistent function source snapshots.
            self.current_span.end.offset
        }
    }

    /// Attach the current token's source text to a word built from it.
    fn with_raw(&self, mut word: Word) -> Word {
        if word.raw.is_none() {
            word.raw = self.current_raw.clone();
        }
        word
    }

    fn source_slice(&self, start_offset: usize, end_offset: usize) -> Option<String> {
        self.input.get(start_offset..end_offset).map(str::to_owned)
    }

    fn limit_error(&self, limit: LimitExceeded) -> Error {
        // Infallible word readers defer errors and can keep scanning. Poison
        // their shared budget so an earlier syntax error cannot mask a limit.
        self.execution_budget
            .as_ref()
            .map_or(limit, |budget| budget.record_failure(limit))
            .into()
    }

    /// Consume one unit of fuel, returning an error if exhausted
    fn tick(&self) -> Result<()> {
        if let Some(budget) = &self.execution_budget {
            budget.consume_work(1)?;
        }
        if let Some(timeout) = self.timeout
            && self.started_at.elapsed() > timeout
        {
            return Err(Error::ResourceLimit(LimitExceeded::ParserTimeout(timeout)));
        }
        if self.fuel.get() == 0 {
            let used = self.max_fuel;
            return Err(self.limit_error(LimitExceeded::ParserFuel {
                used,
                limit: self.max_fuel,
            }));
        }
        self.fuel.set(self.fuel.get() - 1);
        Ok(())
    }

    /// Consume multiple parser fuel units for lexer work that can scale with input size.
    /// THREAT[TM-DOS-064]: Heredoc rest-of-line re-injection copies command suffixes;
    /// charge each copied character so repeated heredocs cannot hide quadratic work
    /// outside parser fuel accounting.
    fn tick_units(&self, units: usize) -> Result<()> {
        if let Some(budget) = &self.execution_budget {
            budget.consume_work(u64::try_from(units).unwrap_or(u64::MAX))?;
        }
        if let Some(timeout) = self.timeout
            && self.started_at.elapsed() > timeout
        {
            return Err(Error::ResourceLimit(LimitExceeded::ParserTimeout(timeout)));
        }
        if self.fuel.get() < units {
            let used = self.max_fuel;
            return Err(self.limit_error(LimitExceeded::ParserFuel {
                used,
                limit: self.max_fuel,
            }));
        }
        self.fuel.set(self.fuel.get() - units);
        Ok(())
    }

    /// Push nesting depth and check limit
    fn push_depth(&mut self) -> Result<()> {
        self.current_depth += 1;
        if self.current_depth > self.max_depth {
            return Err(self.limit_error(LimitExceeded::AstDepth {
                depth: self.current_depth,
                limit: self.max_depth,
            }));
        }
        Ok(())
    }

    /// Pop nesting depth
    fn pop_depth(&mut self) {
        if self.current_depth > 0 {
            self.current_depth -= 1;
        }
    }

    /// Check if current token is an error token and return the error if so
    fn check_error_token(&self) -> Result<()> {
        if let Some(limit) = self.lexer.limit_exceeded() {
            return Err(self.limit_error(limit));
        }
        if let Some(tokens::Token::Error(msg)) = &self.current_token {
            self.classify_unterminated_token(msg == "unterminated command substitution")?;
            // bash: `unexpected EOF while looking for matching `"'`.
            let close = match msg.as_str() {
                "unterminated double quote" => Some('"'),
                "unterminated single quote" => Some('\''),
                "unterminated subscript" => Some(']'),
                "unterminated command substitution" => Some(')'),
                _ => None,
            };
            if let Some(close) = close {
                return Err(self.error(format!(
                    "unexpected EOF while looking for matching `{close}'"
                )));
            }
            return Err(self.error(format!("syntax error: {}", msg)));
        }
        Ok(())
    }

    /// Before an end-of-input error: bash has parsed the substitutions this
    /// token closed, then (for an unterminated `$(`/`<(` span) its open body.
    #[inline(never)]
    fn classify_unterminated_token(&self, substitution: bool) -> Result<()> {
        for body in self.lexer.token_substitutions() {
            self.classify_substitution_text(body, true)?;
        }
        if substitution && let Some(span) = self.lexer.unterminated_substitution() {
            for body in &span.closed {
                self.classify_substitution_text(body, true)?;
            }
            if let Some(body) = &span.open {
                self.classify_substitution_text(body, false)?;
            }
        }
        Ok(())
    }

    /// Bash parses the command text of an unterminated span before it sees
    /// the end of input. Any error in a body closed inside it, or stopping
    /// at an unexpected token in the open body, is a command-substitution
    /// syntax error (status 127); only the open body running out of input is
    /// the plain EOF error (status 2).
    #[inline(never)]
    fn classify_substitution_text(&self, body: &str, closed: bool) -> Result<()> {
        // Bash's reader ends the open text with a newline before the end of
        // input: `$(echo <` is a token error (127), `$(echo |` waits (2).
        let text;
        let continued = body
            .strip_suffix('\n')
            .is_some_and(|line| line.chars().rev().take_while(|&c| c == '\\').count() % 2 == 1);
        // A trailing line continuation joins the end of input instead.
        let body = if closed || continued {
            body
        } else {
            text = format!("{body}\n");
            text.as_str()
        };
        let mut parser = self.nested_parser(body)?;
        let result = parser.parse_inner();
        self.fuel.set(self.fuel.get().min(parser.fuel.get()));
        let at_end = matches!(parser.current_token, None | Some(tokens::Token::Error(_)));
        let line = self.current_span.start.line;
        match result {
            Err(error @ Error::ResourceLimit(_)) => Err(error),
            // A nested substitution's own syntax error, wherever it surfaced.
            Err(Error::ShellWord { .. }) => Err(Error::ShellWord { line }),
            Err(_) if closed || !at_end => Err(Error::ShellWord { line }),
            _ => Ok(()),
        }
    }

    /// Parse the input and return the AST.
    pub fn parse(mut self) -> Result<Script> {
        self.parse_inner()
    }

    // Child parsers remain heap-owned throughout recursion; consuming a
    // boxed Parser through `parse(self)` would move it back onto the stack.
    // THREAT[TM-DOS-044]: every nested substitution re-enters here.
    fn parse_inner(&mut self) -> Result<Script> {
        let mut commands = Vec::new();
        let start_span = self.current_span;
        self.parse_script_into(&mut commands)?;
        Ok(self.finish_script(commands, start_span))
    }

    #[inline(never)]
    fn finish_script(&mut self, commands: Vec<(Command, usize)>, start_span: Span) -> Script {
        let end_span = self.current_span;
        let (commands, command_end_lines) = commands.into_iter().unzip();
        let command_starts = std::mem::take(&mut self.top_starts);
        Script {
            commands,
            span: start_span.merge(end_span),
            trailing_error: None,
            command_end_lines,
            source: Some(Arc::from(self.input)),
            command_starts,
        }
    }

    pub fn parse_recovering(mut self) -> (Script, Option<Error>) {
        let mut commands = Vec::new();
        let start_span = self.current_span;
        let result = self.parse_script_into(&mut commands);
        let end_span = self.current_span;
        let (keep, err) = match result {
            Ok(()) => (commands.len(), None),
            Err(mut e) => {
                if let Some(deferred) = self.deferred_error.take() {
                    self.error_was_deferred = true;
                    if matches!(deferred, Error::ShellWord { .. }) {
                        e = deferred;
                    }
                }
                let keep = match &e {
                    Error::ShellWord { line } => {
                        commands.iter().take_while(|(_, end)| end < line).count()
                    }
                    Error::Parse { .. } if !self.error_was_deferred => {
                        let failed_line = self.failed_command_line;
                        commands
                            .iter()
                            .take_while(|(_, end)| *end < failed_line)
                            .count()
                    }
                    _ => 0,
                };
                (keep, Some(e))
            }
        };
        commands.truncate(keep);
        let (commands, command_end_lines) = commands.into_iter().unzip();
        let mut command_starts = std::mem::take(&mut self.top_starts);
        if err.is_some() {
            // Where the unparsed rest starts: the first dropped command, or
            // the one that failed.
            let rest = command_starts
                .get(keep)
                .copied()
                .unwrap_or(self.failed_command_start);
            command_starts.truncate(keep);
            command_starts.push(rest);
        }
        (
            Script {
                commands,
                span: start_span.merge(end_span),
                trailing_error: None,
                command_end_lines,
                source: Some(Arc::from(self.input)),
                command_starts,
            },
            err,
        )
    }

    /// Top-level command loop. Each command is stored with the line its
    /// terminator (newline, `;`, `&` or EOF) sits on.
    // THREAT[TM-DOS-044]: on the recursive path; bookkeeping is out of line.
    fn parse_script_into(&mut self, commands: &mut Vec<(Command, usize)>) -> Result<()> {
        self.check_error_token()?;
        while let Some(start) = self.next_script_command()? {
            let parsed = self.parse_command_list()?;
            self.end_script_command(commands, parsed, start)?;
        }
        self.take_script_deferred_error()
    }

    /// Skip to the next top-level command; `None` at the end of input.
    #[inline(never)]
    fn next_script_command(&mut self) -> Result<Option<(usize, usize)>> {
        if self.current_token.is_none() {
            return Ok(None);
        }
        self.tick()?;
        self.skip_newlines()?;
        self.check_error_token()?;
        if self.current_token.is_none() {
            return Ok(None);
        }
        let start_offset = self.current_span.start.offset;
        let start_line = self.current_span.start.line;
        self.failed_command_line = start_line;
        self.failed_command_start = (start_offset, start_line);
        // bash reads a top-level command up to the end of its line.
        self.top_level_list = true;
        Ok(Some((start_offset, start_line)))
    }

    #[inline(never)]
    fn end_script_command(
        &mut self,
        commands: &mut Vec<(Command, usize)>,
        parsed: Option<Box<Command>>,
        (start_offset, start_line): (usize, usize),
    ) -> Result<()> {
        let parsed = parsed.is_some_and(|cmd| {
            self.top_starts.push((start_offset, start_line));
            commands.push((*cmd, self.current_span.start.line));
            true
        });
        self.check_error_token()?;
        // A remaining token on this line cannot silently start a second
        // command after a completed compound command or its redirections.
        if self.strict_command_separators
            && parsed
            && self.current_token.is_some()
            && !matches!(self.current_token, Some(tokens::Token::Newline))
        {
            return Err(self.error("unexpected token"));
        }
        if !parsed
            && self.current_token.is_some()
            && self.current_span.start.offset == start_offset
        {
            return Err(self.error("unexpected token"));
        }
        Ok(())
    }

    /// A `$(...)` body that failed to parse is a syntax error in the whole
    /// script, exactly as in bash. Surfaced here because word parsing cannot
    /// return `Result`.
    #[inline(never)]
    fn take_script_deferred_error(&mut self) -> Result<()> {
        if let Some(err) = self.deferred_error.take() {
            self.error_was_deferred = true;
            return Err(err);
        }
        Ok(())
    }

    fn advance(&mut self) {
        self.advance_token();
        // The word after a blank-ending alias value is checked too.
        while self.current_after_blank && self.try_expand_alias() {}
    }

    fn advance_token(&mut self) {
        let next = match self.peeked_token.take() {
            Some(peeked) => Some(peeked),
            None => self.lexer.next_spanned_token(),
        };
        if self.current_token.is_some() {
            self.prev_token_end = self.current_span.end.offset;
            self.last_token_line = self.current_span.end.line;
        }
        match next {
            Some(st) => {
                self.current_token = Some(st.token);
                self.current_span = st.span;
                self.current_raw = st.raw;
                self.current_escapes = st.literal_escapes;
                self.current_plain = st.plain;
                self.current_after_blank = st.after_blank_alias;
            }
            None => {
                self.current_token = None;
                self.current_raw = None;
                self.current_escapes.clear();
                self.current_plain = false;
                self.current_after_blank = false;
                // Keep the last span for error reporting
            }
        }
        self.charge_literal_escapes();
    }

    fn charge_literal_escapes(&mut self) {
        let units = self
            .current_escapes
            .len()
            .saturating_add(self.lexer.take_boundary_scan_work());
        if let Err(err) = self.tick_units(units) {
            let first = self.deferred_error.take();
            self.deferred_error.set(first.or(Some(err)));
        }
    }

    /// Peek at the next token without consuming the current one
    fn peek_next(&mut self) -> Option<&tokens::Token> {
        if self.peeked_token.is_none() {
            self.peeked_token = self.lexer.next_spanned_token();
            let units = self.lexer.take_boundary_scan_work();
            if let Err(err) = self.tick_units(units) {
                let first = self.deferred_error.take();
                self.deferred_error.set(first.or(Some(err)));
            }
        }
        self.peeked_token.as_ref().map(|st| &st.token)
    }

    fn skip_newlines(&mut self) -> Result<()> {
        while matches!(self.current_token, Some(tokens::Token::Newline)) {
            self.tick()?;
            self.advance();
        }
        Ok(())
    }

    // THREAT[TM-DOS-044]: Command enums are large. Heap-owned grammar results
    // avoid retaining their move temporaries on every recursive parser frame.
    // Unbox only when inserting into the public AST's command vectors.
    /// Parse a command list (commands connected by && or ||)
    // THREAT[TM-DOS-044]: on the recursive path of every nested substitution.
    // Operator handling and Command moves live in out-of-line helpers.
    fn parse_command_list(&mut self) -> Result<Option<Box<Command>>> {
        let top_level = self.begin_command_list()?;
        let start_span = self.current_span;
        let first = self.parse_pipeline()?;
        if first.is_none() {
            return Ok(None);
        }
        let mut rest = Vec::new();
        while let Some(op) = self.list_operator(top_level, &mut rest)? {
            match self.parse_pipeline()? {
                Some(cmd) => push_list_command(&mut rest, op, cmd),
                None => {
                    end_list_without_command(&mut rest, op, self.current_span);
                    break;
                }
            }
        }
        self.check_list_end()?;
        finish_command_list(first, rest, start_span.merge(self.current_span))
    }

    #[inline(never)]
    fn begin_command_list(&mut self) -> Result<bool> {
        self.tick()?;
        let top_level = std::mem::take(&mut self.top_level_list);
        match self.current_token {
            Some(tokens::Token::Pipe) => return Err(self.error("unexpected token: |")),
            Some(tokens::Token::And) => return Err(self.error("unexpected token: &&")),
            Some(tokens::Token::Or) => return Err(self.error("unexpected token: ||")),
            _ => {}
        }
        Ok(top_level)
    }

    /// Consume the operator after a pipeline and the newlines after it. `None`
    /// ends the list (a trailing `;` or `&` before a newline or EOF included).
    #[inline(never)]
    fn list_operator(
        &mut self,
        top_level: bool,
        rest: &mut Vec<(ListOperator, Command)>,
    ) -> Result<Option<ListOperator>> {
        let op = match &self.current_token {
            Some(tokens::Token::And) => {
                self.advance();
                ListOperator::And
            }
            Some(tokens::Token::Or) => {
                self.advance();
                ListOperator::Or
            }
            Some(tokens::Token::Semicolon) => {
                self.advance();
                // bash's reader ends a top-level command at the end
                // of its line: `{ls;` NL `}` runs `{ls` first.
                if top_level && matches!(self.current_token, Some(tokens::Token::Newline)) {
                    return Ok(None);
                }
                self.skip_newlines()?;
                // Check if there's more to parse
                if self.current_token.is_none()
                    || matches!(self.current_token, Some(tokens::Token::Newline))
                {
                    return Ok(None);
                }
                ListOperator::Semicolon
            }
            Some(tokens::Token::Background) => {
                self.advance();
                if top_level && matches!(self.current_token, Some(tokens::Token::Newline)) {
                    rest.push(empty_background(self.current_span));
                    return Ok(None);
                }
                self.skip_newlines()?;
                // Check if there's more to parse after &
                if self.current_token.is_none()
                    || matches!(self.current_token, Some(tokens::Token::Newline))
                {
                    // Just & at end - return as background
                    rest.push(empty_background(self.current_span));
                    return Ok(None);
                }
                ListOperator::Background
            }
            _ => return Ok(None),
        };

        self.skip_newlines()?;
        Ok(Some(op))
    }

    #[inline(never)]
    fn check_list_end(&self) -> Result<()> {
        if self.strict_command_separators
            && matches!(
                self.current_token,
                Some(tokens::Token::LeftParen | tokens::Token::DoubleLeftParen)
            )
        {
            return Err(self.error("unexpected token"));
        }
        Ok(())
    }

    // THREAT[TM-DOS-044]: on the recursive path; helpers hold the rest.
    fn parse_pipeline(&mut self) -> Result<Option<Box<Command>>> {
        let start_span = self.current_span;
        let negated = self.pipeline_negation();
        let first = self.parse_command()?;
        if !self.pipeline_continues(first.is_some(), negated)? {
            return Ok(first);
        }
        let mut commands = pipeline_commands(first);
        while self.next_pipeline_stage(&mut commands)? {
            match self.parse_command()? {
                Some(cmd) => push_pipeline_command(&mut commands, cmd),
                None => return Err(self.error("expected command after |")),
            }
        }
        finish_pipeline(commands, negated, start_span.merge(self.current_span))
    }

    #[inline(never)]
    fn pipeline_negation(&mut self) -> bool {
        match &self.current_token {
            Some(tokens::Token::Word(w)) if w == "!" && self.current_escapes.is_empty() => {
                self.advance();
                true
            }
            _ => false,
        }
    }

    /// Whether the first command starts a multi-stage or negated pipeline.
    #[inline(never)]
    fn pipeline_continues(&self, parsed: bool, negated: bool) -> Result<bool> {
        if !parsed {
            if negated {
                return Err(self.error("expected command after !"));
            }
            return Ok(false);
        }
        Ok(negated
            || matches!(
                self.current_token,
                Some(tokens::Token::Pipe | tokens::Token::PipeBoth)
            ))
    }

    /// Consume `|` or `|&` (and newlines after it) before the next stage.
    #[inline(never)]
    fn next_pipeline_stage(&mut self, commands: &mut [Command]) -> Result<bool> {
        if !matches!(
            self.current_token,
            Some(tokens::Token::Pipe | tokens::Token::PipeBoth)
        ) {
            return Ok(false);
        }
        if matches!(self.current_token, Some(tokens::Token::PipeBoth))
            && let Some(prev) = commands.last_mut()
        {
            add_stderr_to_pipe(prev);
        }
        self.advance();
        self.skip_newlines()?;
        Ok(true)
    }

    fn parse_trailing_redirects(&mut self) -> Result<Vec<Redirect>> {
        let mut redirects = Vec::new();
        loop {
            match &self.current_token {
                Some(tokens::Token::RedirectOut) | Some(tokens::Token::Clobber) => {
                    let kind = if matches!(&self.current_token, Some(tokens::Token::Clobber)) {
                        RedirectKind::Clobber
                    } else {
                        RedirectKind::Output
                    };
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: None,
                            fd_var: None,
                            kind,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectAppend) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: None,
                            fd_var: None,
                            kind: RedirectKind::Append,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectIn) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: None,
                            fd_var: None,
                            kind: RedirectKind::Input,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectBoth) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: None,
                            fd_var: None,
                            kind: RedirectKind::OutputBoth,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectBothAppend) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        Self::push_append_both(&mut redirects, None, target);
                    }
                }
                Some(tokens::Token::DupOutput) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(1),
                            fd_var: None,
                            kind: RedirectKind::DupOutput,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectFd(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(fd),
                            fd_var: None,
                            kind: RedirectKind::Output,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::RedirectFdAppend(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(fd),
                            fd_var: None,
                            kind: RedirectKind::Append,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::DupFd(src_fd, dst_fd)) => {
                    let src_fd = *src_fd;
                    let dst_fd = *dst_fd;
                    self.advance();
                    redirects.push(Redirect {
                        expansion_line: None,
                        fd: Some(src_fd),
                        fd_var: None,
                        kind: RedirectKind::DupOutput,
                        target: Word::literal(dst_fd.to_string()),
                        heredoc_delim: None,
                    });
                }
                Some(tokens::Token::DupFdCloseOut(fd)) => {
                    let fd = *fd;
                    self.advance();
                    redirects.push(Redirect {
                        expansion_line: None,
                        fd: Some(fd),
                        fd_var: None,
                        kind: RedirectKind::DupOutput,
                        target: Word::literal("-"),
                        heredoc_delim: None,
                    });
                }
                Some(tokens::Token::DupFdWord(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(fd),
                            fd_var: None,
                            kind: RedirectKind::DupOutput,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::DupInput) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(0),
                            fd_var: None,
                            kind: RedirectKind::DupInput,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::DupFdIn(src_fd, dst_fd)) => {
                    let src_fd = *src_fd;
                    let dst_fd = *dst_fd;
                    self.advance();
                    redirects.push(Redirect {
                        expansion_line: None,
                        fd: Some(src_fd),
                        fd_var: None,
                        kind: RedirectKind::DupInput,
                        target: Word::literal(dst_fd.to_string()),
                        heredoc_delim: None,
                    });
                }
                Some(tokens::Token::DupFdClose(fd)) => {
                    let fd = *fd;
                    self.advance();
                    redirects.push(Redirect {
                        expansion_line: None,
                        fd: Some(fd),
                        fd_var: None,
                        kind: RedirectKind::DupInput,
                        target: Word::literal("-"),
                        heredoc_delim: None,
                    });
                }
                Some(tokens::Token::RedirectFdIn(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: Some(fd),
                            fd_var: None,
                            kind: RedirectKind::Input,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::HereString) => {
                    self.advance();
                    if let Ok(target) = self.expect_word() {
                        redirects.push(Redirect {
                            expansion_line: None,
                            fd: None,
                            fd_var: None,
                            kind: RedirectKind::HereString,
                            target,
                            heredoc_delim: None,
                        });
                    }
                }
                Some(tokens::Token::HereDoc)
                | Some(tokens::Token::HereDocStrip)
                | Some(tokens::Token::HereDocFd(..)) => {
                    // Rest-of-line tokens are re-injected by the lexer: more
                    // redirects may follow (`done <<A 3<<B`, `} <<A >out`).
                    self.parse_heredoc_redirect(&mut redirects, None)?;
                }
                Some(
                    tokens::Token::RedirectReadWrite
                    | tokens::Token::RedirectFdReadWrite(_)
                    | tokens::Token::HereStringFd(_),
                ) => {
                    self.parse_simple_redirect(&mut Vec::new(), &mut redirects)?;
                }
                // `} {fd}>file`: a `{name}` word followed by a redirect
                // operator names the fd variable.
                Some(tokens::Token::Word(w)) if Self::is_fd_var_word(w) => {
                    let mut words = vec![Word::literal(w.clone())];
                    if !matches!(
                        self.peek_next(),
                        Some(
                            tokens::Token::RedirectOut
                                | tokens::Token::Clobber
                                | tokens::Token::RedirectAppend
                                | tokens::Token::RedirectIn
                                | tokens::Token::HereString
                                | tokens::Token::DupOutput
                                | tokens::Token::DupInput
                                | tokens::Token::RedirectReadWrite
                                | tokens::Token::RedirectBothAppend
                                | tokens::Token::HereDoc
                                | tokens::Token::HereDocStrip
                        )
                    ) {
                        break;
                    }
                    self.advance();
                    match self.current_token {
                        Some(tokens::Token::HereDoc | tokens::Token::HereDocStrip) => {
                            let fd_var = Self::pop_fd_var(&mut words);
                            self.parse_heredoc_redirect(&mut redirects, fd_var)?;
                        }
                        Some(tokens::Token::RedirectBothAppend) => {
                            self.parse_append_both(&mut words, &mut redirects)?;
                        }
                        _ => self.parse_simple_redirect(&mut words, &mut redirects)?,
                    }
                }
                _ => break,
            }
        }
        Ok(redirects)
    }

    /// Parse a compound command and any trailing redirections
    fn parse_compound_with_redirects(
        &mut self,
        parser: impl FnOnce(&mut Self) -> Result<CompoundCommand>,
    ) -> Result<Option<Box<Command>>> {
        let compound = parser(self)?;
        let closing_line = self.last_token_line;
        let mut redirects = self.parse_trailing_redirects()?;
        let line = if matches!(compound, CompoundCommand::Subshell(_)) {
            closing_line
        } else {
            self.last_token_line
        };
        self.anchor_redirects(&mut redirects, Some(line))?;
        Ok(Some(Box::new(Command::Compound(compound, redirects))))
    }

    /// A redirect list uses one grammar-selected diagnostic anchor, even when
    /// an earlier target fails. Charge the pass to the existing parser budget.
    fn anchor_redirects(&mut self, redirects: &mut [Redirect], line: Option<usize>) -> Result<()> {
        for redirect in redirects {
            self.tick()?;
            redirect.expansion_line = line;
        }
        Ok(())
    }

    fn anchor_function_redirects(
        &mut self,
        mut command: Command,
        body_line: usize,
    ) -> Result<Command> {
        if matches!(command, Command::Compound(CompoundCommand::Subshell(_), _)) {
            return Ok(command);
        }
        let Command::Compound(compound, redirects) = &mut command else {
            return Ok(command);
        };
        let line = matches!(compound, CompoundCommand::BraceGroup(_)).then_some(body_line);
        self.anchor_redirects(redirects, line)?;
        Ok(command)
    }

    /// The subscript of `name[sub]=...` as written in the source.
    fn raw_subscript(raw: &str, name: &str) -> Option<String> {
        let rest = raw.strip_prefix(name)?.strip_prefix('[')?;
        let mut depth = 1usize;
        let mut quote: Option<char> = None;
        let mut escaped = false;
        for (i, c) in rest.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match (quote, c) {
                (Some('\''), '\'') => quote = None,
                (Some('\''), _) => {}
                (_, '\\') => escaped = true,
                (Some('"'), '"') => quote = None,
                (Some(_), _) => {}
                (None, '\'' | '"') => quote = Some(c),
                (None, '[') => depth += 1,
                (None, ']') => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(rest[..i].to_string());
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// `name=...`, `name+=...`, `name[sub]=...` with a valid name: an
    /// assignment, never a function name (`func-name=x () {...}` is one).
    fn is_assignment_like(word: &str) -> bool {
        let Some(eq) = word.find('=') else {
            return false;
        };
        let lhs = word[..eq].strip_suffix('+').unwrap_or(&word[..eq]);
        let name = lhs.split('[').next().unwrap_or(lhs);
        !name.is_empty()
            && !name.starts_with(|c: char| c.is_ascii_digit())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    }

    /// Parse a single command (simple or compound)
    // THREAT[TM-DOS-044]: on the recursive path. Classification and the
    // compound dispatch (with its closure instantiations) stay out of line.
    fn parse_command(&mut self) -> Result<Option<Box<Command>>> {
        match self.command_start()? {
            CommandStart::Simple => self.parse_simple_command(),
            start => self.parse_compound_start(start),
        }
    }

    #[inline(never)]
    fn command_start(&mut self) -> Result<CommandStart> {
        self.skip_newlines()?;
        self.check_error_token()?;
        self.expand_command_alias();

        if let Some(tokens::Token::Word(w)) = &self.current_token
            && self.current_escapes.is_empty()
        {
            let word = w.clone();
            let start = match word.as_str() {
                "if" => CommandStart::If,
                "for" => CommandStart::For,
                "while" => CommandStart::While,
                "until" => CommandStart::Until,
                "case" => CommandStart::Case,
                "select" => CommandStart::Select,
                "time" => CommandStart::Time,
                "coproc" => CommandStart::Coproc,
                "function" => CommandStart::FunctionKeyword,
                _ => {
                    if !Self::is_assignment_like(&word)
                        && !matches!(
                            word.as_str(),
                            "then" | "else" | "elif" | "fi" | "do" | "done" | "esac" | "in" | "!"
                        )
                        && matches!(self.peek_next(), Some(tokens::Token::LeftParen))
                    {
                        CommandStart::FunctionPosix
                    } else {
                        CommandStart::Simple
                    }
                }
            };
            if start != CommandStart::Simple {
                return Ok(start);
            }
        }
        Ok(match self.current_token {
            Some(tokens::Token::DoubleLeftBracket) => CommandStart::Conditional,
            Some(tokens::Token::DoubleLeftParen) => CommandStart::Arithmetic,
            Some(tokens::Token::LeftParen) => CommandStart::Subshell,
            Some(tokens::Token::LeftBrace) => CommandStart::BraceGroup,
            _ => CommandStart::Simple,
        })
    }

    #[inline(never)]
    fn parse_compound_start(&mut self, start: CommandStart) -> Result<Option<Box<Command>>> {
        match start {
            CommandStart::If => self.parse_compound_with_redirects(|s| s.parse_if()),
            CommandStart::For => self.parse_compound_with_redirects(|s| s.parse_for()),
            CommandStart::While => self.parse_compound_with_redirects(|s| s.parse_while()),
            CommandStart::Until => self.parse_compound_with_redirects(|s| s.parse_until()),
            CommandStart::Case => self.parse_compound_with_redirects(|s| s.parse_case()),
            CommandStart::Select => self.parse_compound_with_redirects(|s| s.parse_select()),
            CommandStart::Time => self.parse_compound_with_redirects(|s| s.parse_time()),
            CommandStart::Coproc => self.parse_compound_with_redirects(|s| s.parse_coproc()),
            CommandStart::FunctionKeyword => {
                self.parse_function_keyword().map(|cmd| Some(Box::new(cmd)))
            }
            CommandStart::FunctionPosix => {
                self.parse_function_posix().map(|cmd| Some(Box::new(cmd)))
            }
            CommandStart::Conditional => {
                self.parse_compound_with_redirects(|s| s.parse_conditional())
            }
            CommandStart::Arithmetic => {
                self.parse_compound_with_redirects(|s| s.parse_arithmetic_command())
            }
            CommandStart::Subshell => self.parse_compound_with_redirects(|s| s.parse_subshell()),
            CommandStart::BraceGroup => {
                self.parse_compound_with_redirects(|s| s.parse_brace_group())
            }
            CommandStart::Simple => unreachable!("simple commands are parsed directly"),
        }
    }

    fn parse_if(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'if'
        self.skip_newlines()?;

        // Parse condition
        let condition = self.parse_compound_list("then")?;
        if condition.is_empty() {
            // bash: `if then` stops at `then`.
            self.pop_depth();
            return Err(self.error("syntax error: empty if condition"));
        }

        // Expect 'then'
        self.expect_keyword("then")?;
        self.skip_newlines()?;

        // Parse then branch
        let then_branch = self.parse_compound_list_until(&["elif", "else", "fi"])?;

        // Bash requires at least one command in then branch
        if then_branch.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty then clause"));
        }

        // Parse elif branches
        let mut elif_branches = Vec::new();
        while self.is_keyword("elif") {
            self.advance(); // consume 'elif'
            self.skip_newlines()?;

            let elif_condition = self.parse_compound_list("then")?;
            if elif_condition.is_empty() {
                self.pop_depth();
                return Err(self.error("syntax error: empty elif condition"));
            }
            self.expect_keyword("then")?;
            self.skip_newlines()?;

            let elif_body = self.parse_compound_list_until(&["elif", "else", "fi"])?;

            // Bash requires at least one command in elif branch
            if elif_body.is_empty() {
                self.pop_depth();
                return Err(self.error("syntax error: empty elif clause"));
            }

            elif_branches.push((elif_condition, elif_body));
        }

        // Parse else branch
        let else_branch = if self.is_keyword("else") {
            self.advance(); // consume 'else'
            self.skip_newlines()?;
            let branch = self.parse_compound_list("fi")?;

            // Bash requires at least one command in else branch
            if branch.is_empty() {
                self.pop_depth();
                return Err(self.error("syntax error: empty else clause"));
            }

            Some(branch)
        } else {
            None
        };

        // Expect 'fi'
        self.expect_keyword("fi")?;

        self.pop_depth();
        Ok(CompoundCommand::If(IfCommand {
            condition,
            then_branch,
            elif_branches,
            else_branch,
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse a for loop
    fn parse_for(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'for'
        // Bash requires the next word on the same line (`for` then a newline
        // is "unexpected token `newline'").

        // Check for C-style for loop: for ((init; cond; step))
        if matches!(self.current_token, Some(tokens::Token::DoubleLeftParen)) {
            let result = self.parse_arithmetic_for_inner(start_span);
            self.pop_depth();
            return result;
        }

        // Expect variable name
        let variable = match &self.current_token {
            Some(tokens::Token::Word(w))
            | Some(tokens::Token::LiteralWord(w))
            | Some(tokens::Token::QuotedWord(w))
            | Some(tokens::Token::QuotedGlobWord(w)) => w.clone(),
            _ => {
                self.pop_depth();
                return Err(Error::parse(
                    "expected variable name in for loop".to_string(),
                ));
            }
        };
        self.advance();
        // `for i` NL `in a b`: newlines may come before `in` (not a `;`).
        self.skip_newlines()?;

        // Check for 'in' keyword
        let words = if self.is_keyword("in") {
            self.advance(); // consume 'in'

            // Parse word list until a list terminator (newline/;)
            let mut words = Vec::new();
            loop {
                match &self.current_token {
                    // `do`/`done` are reserved words only in command position.
                    // Inside the `in` list they are ordinary words until a list
                    // terminator (`;`/newline), matching bash: `for a in do; do
                    // echo $a; done` iterates over the single word `do`.
                    Some(tokens::Token::Word(w))
                    | Some(tokens::Token::QuotedWord(w))
                    | Some(tokens::Token::QuotedGlobWord(w)) => {
                        let is_quoted = matches!(
                            &self.current_token,
                            Some(tokens::Token::QuotedWord(_))
                                | Some(tokens::Token::QuotedGlobWord(_))
                        );
                        let mut word = self.parse_current_word(w.clone());
                        if is_quoted {
                            word.quoted = true;
                        }
                        if matches!(&self.current_token, Some(tokens::Token::QuotedGlobWord(_))) {
                            word.has_unquoted_glob = true;
                        }
                        words.push(self.with_raw(word));
                        self.advance();
                    }
                    Some(tokens::Token::LiteralWord(w)) => {
                        words.push(Word {
                            parts: vec![WordPart::Literal(w.clone())],
                            quoted: true,
                            has_unquoted_glob: false,
                            part_quoted: Vec::new(),
                            raw: self.current_raw.clone(),
                        });
                        self.advance();
                    }
                    Some(tokens::Token::Newline) | Some(tokens::Token::Semicolon) => {
                        self.advance();
                        break;
                    }
                    _ => break,
                }
            }
            Some(words)
        } else {
            // for var; do ... (iterates over positional params)
            // Consume optional semicolon before 'do'
            if matches!(self.current_token, Some(tokens::Token::Semicolon)) {
                self.advance();
            }
            None
        };

        self.skip_newlines()?;

        let body = match self.parse_for_body() {
            Ok(body) => body,
            Err(e) => {
                self.pop_depth();
                return Err(e);
            }
        };

        self.pop_depth();
        Ok(CompoundCommand::For(ForCommand {
            variable,
            words,
            body,
            span: start_span.merge(self.current_span),
        }))
    }

    /// A `for` body: `do list; done`, or bash's `{ list; }` form
    /// (`for ((i=0; i<3; i++)) { echo $i; }`).
    fn parse_for_body(&mut self) -> Result<Vec<Command>> {
        if matches!(self.current_token, Some(tokens::Token::LeftBrace)) {
            let group = self.parse_brace_group()?;
            return Ok(vec![Command::Compound(group, Vec::new())]);
        }
        self.expect_keyword("do")?;
        self.skip_newlines()?;
        let body = self.parse_compound_list("done")?;
        // Bash requires at least one command in loop body
        if body.is_empty() {
            return Err(self.error("syntax error: empty for loop body"));
        }
        self.expect_keyword("done")?;
        Ok(body)
    }

    /// Parse select loop: select var in list; do body; done
    fn parse_select(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'select'
        // Bash requires the next word on the same line (`select` then a newline
        // is "unexpected token `newline'").

        // Expect variable name
        let variable = match &self.current_token {
            Some(tokens::Token::Word(w))
            | Some(tokens::Token::LiteralWord(w))
            | Some(tokens::Token::QuotedWord(w))
            | Some(tokens::Token::QuotedGlobWord(w)) => w.clone(),
            _ => {
                self.pop_depth();
                return Err(Error::parse("expected variable name in select".to_string()));
            }
        };
        self.advance();
        // Bash's grammar matches `for`: newlines may come before `in`, and
        // without `in` the list is `"$@"` (`select i; do`, `select i NL do`).
        self.skip_newlines()?;
        let mut words = Vec::new();
        if !self.is_keyword("in") {
            if matches!(self.current_token, Some(tokens::Token::Semicolon)) {
                self.advance();
            }
            words.push(Word {
                parts: vec![WordPart::Variable("@".to_string())],
                quoted: true,
                has_unquoted_glob: false,
                part_quoted: Vec::new(),
                raw: Some("\"$@\"".to_string()),
            });
        } else {
            self.advance(); // consume 'in'
            self.parse_select_words(&mut words)?;
        }

        self.skip_newlines()?;

        let body = match self.parse_for_body() {
            Ok(body) => body,
            Err(e) => {
                self.pop_depth();
                return Err(e);
            }
        };

        self.pop_depth();
        Ok(CompoundCommand::Select(SelectCommand {
            variable,
            words,
            body,
            span: start_span.merge(self.current_span),
        }))
    }

    /// The `in` word list of a `select`, through its list terminator.
    fn parse_select_words(&mut self, words: &mut Vec<Word>) -> Result<()> {
        loop {
            match &self.current_token {
                // `do`/`done` are reserved words only in command position.
                // Inside the `in` list they are ordinary words until a list
                // terminator (`;`/newline), matching bash.
                Some(tokens::Token::Word(w))
                | Some(tokens::Token::QuotedWord(w))
                | Some(tokens::Token::QuotedGlobWord(w)) => {
                    let is_quoted = matches!(
                        &self.current_token,
                        Some(tokens::Token::QuotedWord(_)) | Some(tokens::Token::QuotedGlobWord(_))
                    );
                    let mut word = self.parse_current_word(w.clone());
                    if is_quoted {
                        word.quoted = true;
                    }
                    if matches!(&self.current_token, Some(tokens::Token::QuotedGlobWord(_))) {
                        word.has_unquoted_glob = true;
                    }
                    words.push(self.with_raw(word));
                    self.advance();
                }
                Some(tokens::Token::LiteralWord(w)) => {
                    words.push(Word {
                        parts: vec![WordPart::Literal(w.clone())],
                        quoted: true,
                        has_unquoted_glob: false,
                        part_quoted: Vec::new(),
                        raw: self.current_raw.clone(),
                    });
                    self.advance();
                }
                Some(tokens::Token::Newline) | Some(tokens::Token::Semicolon) => {
                    self.advance();
                    break;
                }
                _ => break,
            }
        }
        Ok(())
    }

    /// Parse C-style arithmetic for loop inner: for ((init; cond; step)); do body; done
    /// Note: depth tracking is done by parse_for which calls this
    fn parse_arithmetic_for_inner(&mut self, start_span: Span) -> Result<CompoundCommand> {
        // Read the three expressions separated by semicolons
        let mut parts: Vec<String> = Vec::new();
        let mut raw_parts: Option<Vec<String>> = None;
        let mut current_expr = String::new();
        let mut paren_depth = 0;

        if self.peeked_token.is_none() {
            // Read `((init; cond; step))` as written (see read_dparen_body).
            let Some(body) = self.lexer.read_dparen_body() else {
                return Err(Error::parse(
                    "unexpected end of input in for loop".to_string(),
                ));
            };
            let raws = split_arith_for_parts(&body);
            if raws.len() != 3 {
                return Err(self.error("syntax error: arithmetic expression required"));
            }
            parts = raws.iter().map(|p| arith_exec_text(p)).collect();
            raw_parts = Some(raws);
            self.advance();
        } else {
            self.advance(); // consume '(('
        }

        while raw_parts.is_none() {
            match &self.current_token {
                Some(tokens::Token::DoubleRightParen) => {
                    // End of the (( )) section
                    parts.push(current_expr.trim().to_string());
                    self.advance();
                    break;
                }
                Some(tokens::Token::LeftParen) => {
                    paren_depth += 1;
                    current_expr.push('(');
                    self.advance();
                }
                Some(tokens::Token::RightParen) => {
                    if paren_depth > 0 {
                        paren_depth -= 1;
                        current_expr.push(')');
                        self.advance();
                    } else {
                        // Unexpected - probably error
                        self.advance();
                    }
                }
                Some(tokens::Token::Semicolon) => {
                    if paren_depth == 0 {
                        // Separator between init, cond, step
                        parts.push(current_expr.trim().to_string());
                        current_expr.clear();
                    } else {
                        current_expr.push(';');
                    }
                    self.advance();
                }
                Some(tokens::Token::Word(w))
                | Some(tokens::Token::LiteralWord(w))
                | Some(tokens::Token::QuotedWord(w))
                | Some(tokens::Token::QuotedGlobWord(w)) => {
                    // Don't add space when joining operator pairs like < + =3 → <=3
                    let skip_space = current_expr.ends_with('<')
                        || current_expr.ends_with('>')
                        || current_expr.ends_with(' ')
                        || current_expr.ends_with('(')
                        || current_expr.is_empty();
                    if !skip_space {
                        current_expr.push(' ');
                    }
                    current_expr.push_str(w);
                    self.advance();
                }
                Some(tokens::Token::Newline) => {
                    self.advance();
                }
                // Handle operators that are normally special tokens but valid in arithmetic
                Some(tokens::Token::RedirectIn) => {
                    current_expr.push('<');
                    self.advance();
                }
                Some(tokens::Token::RedirectOut) => {
                    current_expr.push('>');
                    self.advance();
                }
                Some(tokens::Token::And) => {
                    current_expr.push_str("&&");
                    self.advance();
                }
                Some(tokens::Token::Or) => {
                    current_expr.push_str("||");
                    self.advance();
                }
                Some(tokens::Token::Pipe) => {
                    current_expr.push('|');
                    self.advance();
                }
                Some(tokens::Token::Background) => {
                    current_expr.push('&');
                    self.advance();
                }
                None => {
                    return Err(Error::parse(
                        "unexpected end of input in for loop".to_string(),
                    ));
                }
                _ => {
                    self.advance();
                }
            }
        }

        // Ensure we have exactly 3 parts
        while parts.len() < 3 {
            parts.push(String::new());
        }

        let init = parts.first().cloned().unwrap_or_default();
        let condition = parts.get(1).cloned().unwrap_or_default();
        let step = parts.get(2).cloned().unwrap_or_default();

        self.skip_newlines()?;

        // Skip optional semicolon after ))
        if matches!(self.current_token, Some(tokens::Token::Semicolon)) {
            self.advance();
        }
        self.skip_newlines()?;

        let body = self.parse_for_body()?;

        Ok(CompoundCommand::ArithmeticFor(ArithmeticForCommand {
            init,
            condition,
            step,
            raw: raw_parts,
            body,
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse a while loop
    fn parse_while(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'while'
        self.skip_newlines()?;

        // Parse condition
        let condition = self.parse_compound_list("do")?;
        if condition.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty while condition"));
        }

        // Expect 'do'
        self.expect_keyword("do")?;
        self.skip_newlines()?;

        // Parse body
        let body = self.parse_compound_list("done")?;

        // Bash requires at least one command in loop body
        if body.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty while loop body"));
        }

        // Expect 'done'
        self.expect_keyword("done")?;

        self.pop_depth();
        Ok(CompoundCommand::While(WhileCommand {
            condition,
            body,
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse an until loop
    fn parse_until(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'until'
        self.skip_newlines()?;

        // Parse condition
        let condition = self.parse_compound_list("do")?;
        if condition.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty until condition"));
        }

        // Expect 'do'
        self.expect_keyword("do")?;
        self.skip_newlines()?;

        // Parse body
        let body = self.parse_compound_list("done")?;

        // Bash requires at least one command in loop body
        if body.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty until loop body"));
        }

        // Expect 'done'
        self.expect_keyword("done")?;

        self.pop_depth();
        Ok(CompoundCommand::Until(UntilCommand {
            condition,
            body,
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse a case statement: case WORD in pattern) commands ;; ... esac
    fn parse_case(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.push_depth()?;
        self.advance(); // consume 'case'
        // Bash requires the next word on the same line (`case` then a newline
        // is "unexpected token `newline'").

        // Get the word to match against
        let word = self.expect_word()?;
        self.skip_newlines()?;

        // Expect 'in'
        self.expect_keyword("in")?;
        self.skip_newlines()?;

        // Parse case items
        let mut cases = Vec::new();
        while !self.is_keyword("esac") && self.current_token.is_some() {
            self.skip_newlines()?;
            if self.is_keyword("esac") {
                break;
            }

            // Parse patterns (pattern1 | pattern2 | ...)
            // Optional leading (
            if matches!(self.current_token, Some(tokens::Token::LeftParen)) {
                self.advance();
            }

            let mut patterns = Vec::new();
            while matches!(
                &self.current_token,
                Some(tokens::Token::Word(_))
                    | Some(tokens::Token::LiteralWord(_))
                    | Some(tokens::Token::QuotedWord(_))
                    | Some(tokens::Token::QuotedGlobWord(_))
            ) {
                let pattern = match &self.current_token {
                    Some(tokens::Token::LiteralWord(w)) => Word {
                        // LiteralWord already decoded lexer-only sentinels and must not
                        // be reparsed; otherwise escaped dollars can become expansions.
                        parts: vec![WordPart::Literal(w.clone())],
                        quoted: true,
                        has_unquoted_glob: false,
                        part_quoted: Vec::new(),
                        raw: self.current_raw.clone(),
                    },
                    Some(tokens::Token::Word(w))
                    | Some(tokens::Token::QuotedWord(w))
                    | Some(tokens::Token::QuotedGlobWord(w)) => {
                        // Keep the quoting flags: quoted pattern text matches
                        // literally (`"$x")`, `a\*)`).
                        let mut word = self.parse_current_word(w.clone());
                        match &self.current_token {
                            Some(tokens::Token::QuotedWord(_)) => word.quoted = true,
                            Some(tokens::Token::QuotedGlobWord(_)) => {
                                word.quoted = true;
                                word.has_unquoted_glob = true;
                            }
                            _ => {}
                        }
                        word
                    }
                    _ => unreachable!(),
                };
                patterns.push(self.with_raw(pattern));
                self.advance();

                // Check for | between patterns
                if matches!(self.current_token, Some(tokens::Token::Pipe)) {
                    self.advance();
                } else {
                    break;
                }
            }

            // Expect )
            if !matches!(self.current_token, Some(tokens::Token::RightParen)) {
                self.pop_depth();
                return Err(self.error("expected ')' after case pattern"));
            }
            self.advance();
            self.skip_newlines()?;

            // Parse commands until ;; or esac
            let mut commands = Vec::new();
            while !self.is_case_terminator()
                && !self.is_keyword("esac")
                && self.current_token.is_some()
            {
                if let Some(cmd) = self.parse_command_list()? {
                    commands.push(*cmd);
                }
                self.skip_newlines()?;
            }

            let terminator = self.parse_case_terminator();
            cases.push(CaseItem {
                patterns,
                commands,
                terminator,
            });
            self.skip_newlines()?;
        }

        // Expect 'esac'
        self.expect_keyword("esac")?;

        self.pop_depth();
        Ok(CompoundCommand::Case(CaseCommand {
            word,
            cases,
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse the reserved-word pipeline form, plus the useful GNU report flags.
    fn parse_time(&mut self) -> Result<CompoundCommand> {
        let start_span = self.current_span;
        self.advance(); // consume 'time'
        self.skip_newlines()?;

        let mut posix_format = false;
        let mut format = None;
        let mut output = None;
        let mut append = false;
        let mut verbose = false;
        let mut option_error = None;

        while let Some(option) = self.current_word_str() {
            if option == "--" {
                self.advance();
                self.skip_newlines()?;
                break;
            }
            if !option.starts_with('-') || option == "-" {
                break;
            }

            self.advance();
            match option.as_str() {
                "-p" => posix_format = true,
                "-a" | "--append" => append = true,
                "-v" | "--verbose" => verbose = true,
                "-f" | "--format" => {
                    format = self.current_word_to_word();
                    if format.is_some() {
                        self.advance();
                    } else {
                        option_error = Some(format!("option '{option}' requires an argument"));
                    }
                }
                "-o" | "--output" => {
                    output = self.current_word_to_word();
                    if output.is_some() {
                        self.advance();
                    } else {
                        option_error = Some(format!("option '{option}' requires an argument"));
                    }
                }
                _ if option.starts_with("--format=") => {
                    format = Some(Word::literal(option[9..].to_string()));
                }
                _ if option.starts_with("--output=") => {
                    output = Some(Word::literal(option[9..].to_string()));
                }
                _ if option.starts_with("-f") && option.len() > 2 => {
                    format = Some(Word::literal(option[2..].to_string()));
                }
                _ if option.starts_with("-o") && option.len() > 2 => {
                    output = Some(Word::literal(option[2..].to_string()));
                }
                _ => option_error = Some(format!("unrecognized option '{option}'")),
            }
            self.skip_newlines()?;
            if option_error.is_some() {
                break;
            }
        }

        let command = self.parse_pipeline()?;

        Ok(CompoundCommand::Time(Box::new(TimeCommand {
            posix_format,
            format,
            output,
            append,
            verbose,
            option_error,
            command,
            span: start_span.merge(self.current_span),
        })))
    }

    /// Parse a coproc command: `coproc [NAME] command`
    ///
    /// If the token after `coproc` is a simple word followed by a compound
    /// command (`{`, `(`, `while`, `for`, etc.), it is treated as the coproc
    /// name. Otherwise the command starts immediately and the default name
    /// "COPROC" is used.
    fn parse_coproc(&mut self) -> Result<CompoundCommand> {
        self.tick()?;
        self.push_depth()?;

        let result = (|| {
            let start_span = self.current_span;
            self.advance(); // consume 'coproc'
            self.skip_newlines()?;

            // Determine if next token is a NAME (simple word that is NOT a compound-
            // command keyword and is followed by a compound command start).
            let (name, consumed_name) = if let Some(tokens::Token::Word(w)) = &self.current_token {
                let word = w.clone();
                let is_compound_keyword = matches!(
                    word.as_str(),
                    "if" | "for" | "while" | "until" | "case" | "select" | "time" | "coproc"
                );
                let next_is_compound_start = matches!(
                    self.peek_next(),
                    Some(tokens::Token::LeftBrace) | Some(tokens::Token::LeftParen)
                );
                if !is_compound_keyword && next_is_compound_start {
                    self.advance(); // consume the NAME
                    self.skip_newlines()?;
                    (word, true)
                } else {
                    ("COPROC".to_string(), false)
                }
            } else {
                ("COPROC".to_string(), false)
            };

            let _ = consumed_name;

            // Parse the command body (could be simple, compound, or pipeline)
            let body = self.parse_pipeline()?;
            let body = body.ok_or_else(|| self.error("coproc: missing command"))?;

            Ok(CompoundCommand::Coproc(ast::CoprocCommand {
                name,
                body,
                span: start_span.merge(self.current_span),
            }))
        })();

        self.pop_depth();
        result
    }

    /// Check if current token is ;; (case terminator)
    fn is_case_terminator(&self) -> bool {
        matches!(
            self.current_token,
            Some(tokens::Token::DoubleSemicolon)
                | Some(tokens::Token::SemiAmp)
                | Some(tokens::Token::DoubleSemiAmp)
        )
    }

    /// Parse case terminator: `;;` (break), `;&` (fallthrough), `;;&` (continue matching)
    fn parse_case_terminator(&mut self) -> ast::CaseTerminator {
        match self.current_token {
            Some(tokens::Token::SemiAmp) => {
                self.advance();
                ast::CaseTerminator::FallThrough
            }
            Some(tokens::Token::DoubleSemiAmp) => {
                self.advance();
                ast::CaseTerminator::Continue
            }
            Some(tokens::Token::DoubleSemicolon) => {
                self.advance();
                ast::CaseTerminator::Break
            }
            _ => ast::CaseTerminator::Break,
        }
    }

    /// Parse a subshell (commands in parentheses)
    fn parse_subshell(&mut self) -> Result<CompoundCommand> {
        self.push_depth()?;
        self.advance(); // consume '('
        self.skip_newlines()?;

        let mut commands = Vec::new();
        while !matches!(
            self.current_token,
            Some(tokens::Token::RightParen) | Some(tokens::Token::DoubleRightParen) | None
        ) {
            self.skip_newlines()?;
            if matches!(
                self.current_token,
                Some(tokens::Token::RightParen) | Some(tokens::Token::DoubleRightParen)
            ) {
                break;
            }
            if let Some(cmd) = self.parse_command_list()? {
                commands.push(*cmd);
            }
        }

        if matches!(self.current_token, Some(tokens::Token::DoubleRightParen)) {
            // `))` at end of nested subshells: consume as single `)`, leave `)` for parent
            self.current_token = Some(tokens::Token::RightParen);
        } else if !matches!(self.current_token, Some(tokens::Token::RightParen)) {
            self.pop_depth();
            return Err(self.error("expected ')' to close subshell"));
        } else {
            self.advance(); // consume ')'
        }

        self.pop_depth();
        Ok(CompoundCommand::Subshell(commands))
    }

    /// Parse a brace group
    fn parse_brace_group(&mut self) -> Result<CompoundCommand> {
        self.push_depth()?;
        self.advance(); // consume '{'
        self.skip_newlines()?;

        let mut commands = Vec::new();
        while !matches!(self.current_token, Some(tokens::Token::RightBrace) | None) {
            self.skip_newlines()?;
            if matches!(self.current_token, Some(tokens::Token::RightBrace)) {
                break;
            }
            if let Some(cmd) = self.parse_command_list()? {
                commands.push(*cmd);
            }
        }

        if !matches!(self.current_token, Some(tokens::Token::RightBrace)) {
            self.pop_depth();
            return Err(self.error("expected '}' to close brace group"));
        }

        // Bash requires at least one command in a brace group
        if commands.is_empty() {
            self.pop_depth();
            return Err(self.error("syntax error: empty brace group"));
        }

        self.advance(); // consume '}'

        self.pop_depth();
        Ok(CompoundCommand::BraceGroup(commands))
    }

    /// Parse arithmetic command ((expression))
    /// Parse [[ conditional expression ]]
    fn parse_conditional(&mut self) -> Result<CompoundCommand> {
        self.advance(); // consume '[['

        let mut words = Vec::new();
        // Token shapes for the grammar check below, one per word.
        let mut kinds: Vec<CondTok> = Vec::new();
        let mut saw_regex_op = false;

        loop {
            match &self.current_token {
                Some(tokens::Token::DoubleRightBracket) => {
                    self.advance(); // consume ']]'
                    break;
                }
                Some(tokens::Token::Word(w))
                | Some(tokens::Token::LiteralWord(w))
                | Some(tokens::Token::QuotedWord(w))
                | Some(tokens::Token::QuotedGlobWord(w)) => {
                    let w_clone = w.clone();
                    let is_quoted = matches!(
                        self.current_token,
                        Some(tokens::Token::QuotedWord(_)) | Some(tokens::Token::QuotedGlobWord(_))
                    );
                    let is_literal =
                        matches!(self.current_token, Some(tokens::Token::LiteralWord(_)));
                    // Only a bare unquoted word can be an operator (`'!'` and
                    // `$op` are operands).
                    let op_text = (matches!(self.current_token, Some(tokens::Token::Word(_)))
                        && self.current_escapes.is_empty()
                        && !w_clone.contains(['$', '`', '\\', '\x00', '\u{1e}', '\u{1f}']))
                    .then(|| w_clone.clone());

                    // After =~, handle regex pattern.
                    // If the pattern contains $ (variable reference), parse it as a
                    // normal word so variables expand. Keep quoted/literal tokens as
                    // literal regex patterns to preserve shell quoting semantics.
                    if saw_regex_op {
                        if w_clone.contains('$') && !is_quoted && !is_literal {
                            // Variable reference — parse normally for expansion
                            let parsed = self.parse_current_word(w_clone);
                            words.push(self.with_raw(parsed));
                            self.advance();
                        } else {
                            let pattern = self.collect_conditional_regex_pattern(&w_clone);
                            words.push(Word::literal(&pattern));
                        }
                        kinds.push(CondTok::Word(None));
                        saw_regex_op = false;
                        continue;
                    }

                    if op_text.as_deref() == Some("=~") && self.peeked_token.is_none() {
                        // Read the operand from source: bash lexes it as one
                        // regex word, where `#`, `|` and spaces in groups are
                        // pattern text, not comments or operators.
                        words.push(Word::literal("=~"));
                        kinds.push(CondTok::Word(Some("=~".to_string())));
                        let (raw, unclosed) = self.lexer.read_cond_regex_checked();
                        if unclosed {
                            // bash reads the group to end of input, then the
                            // conditional grammar rejects the missing operand
                            // there: two diagnostics, the second on the line
                            // after the last.
                            let eof_line = self.input.lines().count() + 1;
                            return Err(Error::parse_at(
                                format!(
                                    "unexpected EOF while looking for matching `)'\n\
                                     line {eof_line}: unexpected argument to conditional binary operator"
                                ),
                                self.current_span.start.line,
                                self.current_span.start.column,
                            ));
                        }
                        if let Some(raw) = raw {
                            let mut word = self.cond_regex_word(raw.clone());
                            word.raw = Some(raw.trim().to_string());
                            words.push(word);
                            kinds.push(CondTok::Word(None));
                        }
                        self.advance();
                        continue;
                    }
                    if op_text.as_deref() == Some("=~") {
                        saw_regex_op = true;
                    }

                    let word = if is_literal {
                        Word {
                            parts: vec![WordPart::Literal(w_clone)],
                            quoted: true,
                            has_unquoted_glob: false,
                            part_quoted: Vec::new(),
                            raw: self.current_raw.clone(),
                        }
                    } else {
                        let mut parsed = self.parse_current_word(w_clone);
                        if is_quoted {
                            parsed.quoted = true;
                        }
                        if matches!(self.current_token, Some(tokens::Token::QuotedGlobWord(_))) {
                            parsed.has_unquoted_glob = true;
                        }
                        parsed
                    };
                    words.push(self.with_raw(word));
                    // bash reads the pattern after `==`/`!=`/`=` with extglob
                    // on: `[[ x == --!(a|b) ]]` needs no `shopt -s extglob`.
                    let pattern_next = matches!(op_text.as_deref(), Some("==" | "!=" | "="));
                    kinds.push(CondTok::Word(op_text));
                    if pattern_next {
                        let saved = self.lexer.extglob_bang();
                        self.lexer.set_extglob_bang(true);
                        self.advance();
                        self.lexer.set_extglob_bang(saved);
                    } else {
                        self.advance();
                    }
                }
                // Operators that the lexer tokenizes separately
                Some(tokens::Token::And) => {
                    words.push(Word::literal("&&"));
                    kinds.push(CondTok::Op("&&"));
                    self.advance();
                }
                Some(tokens::Token::Or) => {
                    words.push(Word::literal("||"));
                    kinds.push(CondTok::Op("||"));
                    self.advance();
                }
                Some(tokens::Token::LeftParen) => {
                    if saw_regex_op {
                        // Regex pattern starts with '(' — collect it
                        let pattern = self.collect_conditional_regex_pattern("(");
                        words.push(Word::literal(&pattern));
                        kinds.push(CondTok::Word(None));
                        saw_regex_op = false;
                        continue;
                    }
                    words.push(Word::literal("("));
                    kinds.push(CondTok::Op("("));
                    self.advance();
                }
                Some(tokens::Token::RightParen) => {
                    words.push(Word::literal(")"));
                    kinds.push(CondTok::Op(")"));
                    self.advance();
                }
                // Inside `[[ ]]` these are string comparison operators, not
                // redirections (bash's conditional grammar has no redirects).
                Some(tokens::Token::RedirectIn) => {
                    words.push(Word::literal("<"));
                    kinds.push(CondTok::Op("<"));
                    self.advance();
                }
                Some(tokens::Token::RedirectOut) => {
                    words.push(Word::literal(">"));
                    kinds.push(CondTok::Op(">"));
                    self.advance();
                }
                // `[[ { =~ "{" ]]`: braces are plain words here.
                Some(tokens::Token::LeftBrace) | Some(tokens::Token::RightBrace) => {
                    let text = if matches!(self.current_token, Some(tokens::Token::LeftBrace)) {
                        "{"
                    } else {
                        "}"
                    };
                    words.push(Word::literal(text));
                    kinds.push(CondTok::Word(None));
                    self.advance();
                }
                // `[[ a\n&& b\n]]`: newlines inside are blanks.
                Some(tokens::Token::Newline) => {
                    self.advance();
                }
                None => {
                    return Err(crate::error::Error::parse(
                        "unexpected end of input in [[ ]]".to_string(),
                    ));
                }
                _ => {
                    // Any other token (`;`, `3<`, `|`) is outside the
                    // conditional grammar.
                    kinds.push(CondTok::Op("token"));
                    self.advance();
                }
            }
        }

        if let Err(error) = check_conditional(&kinds) {
            return Err(match error {
                ConditionalError::Syntax(message) => Error::parse_at(
                    message,
                    self.current_span.start.line,
                    self.current_span.start.column,
                ),
                ConditionalError::Depth => self.limit_error(LimitExceeded::ConditionalDepth),
            });
        }
        Ok(CompoundCommand::Conditional(words))
    }

    /// Build the `=~` operand from its raw source (see
    /// [`Lexer::read_cond_regex`]). Plain text stays a literal pattern;
    /// unquoted `$` parts expand; quoted forms keep the token-by-token
    /// concatenation used before raw reading.
    fn cond_regex_word(&self, raw: String) -> Word {
        if !cond_regex_expands(&raw) {
            return Word::literal(cond_regex_literal(&raw));
        }
        if !raw.contains(['\'', '"']) {
            return self.parse_word(raw);
        }
        // Quotes mixed with expansions: keep the token-by-token
        // concatenation used before raw reading.
        let mut lexer = Lexer::new(&raw);
        let mut pattern = String::new();
        let mut last_end = None;
        while let Some(st) = lexer.next_spanned_token() {
            if last_end.is_some_and(|end| st.span.start.offset > end) {
                pattern.push(' ');
            }
            last_end = Some(st.span.end.offset);
            match st.token {
                tokens::Token::Word(w)
                | tokens::Token::LiteralWord(w)
                | tokens::Token::QuotedWord(w)
                | tokens::Token::QuotedGlobWord(w) => pattern.push_str(&w),
                tokens::Token::LeftParen => pattern.push('('),
                tokens::Token::RightParen => pattern.push(')'),
                tokens::Token::Pipe => pattern.push('|'),
                _ => {}
            }
        }
        Word::literal(&pattern)
    }

    /// Collect a regex pattern after =~ in [[ ]], handling parens and special chars.
    fn collect_conditional_regex_pattern(&mut self, first_word: &str) -> String {
        let mut pattern = first_word.to_string();
        self.advance(); // consume the first word

        // Concatenate adjacent tokens that are part of the regex pattern
        loop {
            match &self.current_token {
                Some(tokens::Token::DoubleRightBracket) => break,
                Some(tokens::Token::And) | Some(tokens::Token::Or) => break,
                Some(tokens::Token::LeftParen) => {
                    pattern.push('(');
                    self.advance();
                }
                Some(tokens::Token::RightParen) => {
                    pattern.push(')');
                    self.advance();
                }
                Some(tokens::Token::Word(w))
                | Some(tokens::Token::LiteralWord(w))
                | Some(tokens::Token::QuotedWord(w))
                | Some(tokens::Token::QuotedGlobWord(w)) => {
                    pattern.push_str(w);
                    self.advance();
                }
                _ => break,
            }
        }

        pattern
    }

    /// Check if current token starts with `=` (e.g., Word("=5") from `>=5`).
    /// If so, return the rest of the word after `=`.
    fn current_token_starts_with_eq(&self) -> Option<String> {
        match &self.current_token {
            Some(tokens::Token::Assignment) => Some(String::new()),
            Some(tokens::Token::Word(w)) | Some(tokens::Token::LiteralWord(w)) => {
                w.strip_prefix('=').map(|rest| rest.to_string())
            }
            _ => None,
        }
    }

    fn parse_arithmetic_command(&mut self) -> Result<CompoundCommand> {
        if self.peeked_token.is_none() {
            // Read `(( expr ))` as written (see read_dparen_body); the
            // command keeps that text, so `type` prints it unchanged.
            let saved = self.lexer.clone();
            let body = match self.lexer.read_dparen_body_checked() {
                Ok(body) => body,
                Err(true) => {
                    // `((cmd) ...)`: two subshells, as bash reads it. Re-read
                    // from just after `((`, with the second `(` put back.
                    self.lexer = saved;
                    self.lexer.unread_char('(');
                    self.current_token = Some(tokens::Token::LeftParen);
                    return self.parse_subshell();
                }
                Err(false) => {
                    return Err(Error::parse(
                        "unexpected end of input in arithmetic command".to_string(),
                    ));
                }
            };
            self.advance();
            return Ok(CompoundCommand::Arithmetic(body));
        }
        self.advance(); // consume '(('

        // Read expression until we find ))
        let mut expr = String::new();
        let mut depth = 1;

        loop {
            match &self.current_token {
                Some(tokens::Token::DoubleLeftParen) => {
                    depth += 1;
                    expr.push_str("((");
                    self.advance();
                }
                Some(tokens::Token::DoubleRightParen) => {
                    depth -= 1;
                    if depth == 0 {
                        self.advance(); // consume '))'
                        break;
                    }
                    expr.push_str("))");
                    self.advance();
                }
                Some(tokens::Token::LeftParen) => {
                    expr.push('(');
                    self.advance();
                }
                Some(tokens::Token::RightParen) => {
                    expr.push(')');
                    self.advance();
                }
                Some(tokens::Token::Word(w))
                | Some(tokens::Token::LiteralWord(w))
                | Some(tokens::Token::QuotedWord(w))
                | Some(tokens::Token::QuotedGlobWord(w)) => {
                    if !expr.is_empty() && !expr.ends_with(' ') && !expr.ends_with('(') {
                        expr.push(' ');
                    }
                    // Quotes are removed inside `((...))`; drop the lexer's
                    // quote-boundary markers so `c["x y"]` keys stay clean.
                    expr.extend(w.chars().filter(|&c| c != '\u{1e}' && c != '\u{1f}'));
                    self.advance();
                }
                Some(tokens::Token::Semicolon) => {
                    expr.push(';');
                    self.advance();
                }
                Some(tokens::Token::Newline) => {
                    self.advance();
                }
                // Handle operators that are normally special tokens but valid in arithmetic
                Some(tokens::Token::RedirectIn) => {
                    self.advance();
                    // Check if next token starts with '=' to form '<='
                    if let Some(rest) = self.current_token_starts_with_eq() {
                        expr.push_str("<=");
                        if !rest.is_empty() {
                            expr.push_str(&rest);
                        }
                        self.advance();
                    } else {
                        expr.push('<');
                    }
                }
                Some(tokens::Token::RedirectOut) => {
                    self.advance();
                    // Check if next token starts with '=' to form '>='
                    if let Some(rest) = self.current_token_starts_with_eq() {
                        expr.push_str(">=");
                        if !rest.is_empty() {
                            expr.push_str(&rest);
                        }
                        self.advance();
                    } else {
                        expr.push('>');
                    }
                }
                Some(tokens::Token::And) => {
                    expr.push_str("&&");
                    self.advance();
                }
                Some(tokens::Token::Or) => {
                    expr.push_str("||");
                    self.advance();
                }
                Some(tokens::Token::Pipe) => {
                    expr.push('|');
                    self.advance();
                }
                Some(tokens::Token::Background) => {
                    expr.push('&');
                    self.advance();
                }
                Some(tokens::Token::Assignment) => {
                    expr.push('=');
                    self.advance();
                }
                // In arithmetic context, N> is a number followed by >, not a fd redirect
                Some(tokens::Token::RedirectFd(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Some(rest) = self.current_token_starts_with_eq() {
                        // N>= → number >= ...
                        expr.push_str(&format!("{}>=", fd));
                        if !rest.is_empty() {
                            expr.push_str(&rest);
                        }
                        self.advance();
                    } else {
                        expr.push_str(&format!("{}>", fd));
                    }
                }
                Some(tokens::Token::RedirectFdAppend(fd)) => {
                    // N>> in arithmetic is N >> (right shift)
                    let fd = *fd;
                    expr.push_str(&format!("{}>>", fd));
                    self.advance();
                }
                Some(tokens::Token::RedirectFdIn(fd)) => {
                    let fd = *fd;
                    self.advance();
                    if let Some(rest) = self.current_token_starts_with_eq() {
                        expr.push_str(&format!("{}<=", fd));
                        if !rest.is_empty() {
                            expr.push_str(&rest);
                        }
                        self.advance();
                    } else {
                        expr.push_str(&format!("{}<", fd));
                    }
                }
                Some(tokens::Token::RedirectAppend) => {
                    // >> in arithmetic is right shift
                    expr.push_str(">>");
                    self.advance();
                }
                None => {
                    return Err(Error::parse(
                        "unexpected end of input in arithmetic command".to_string(),
                    ));
                }
                _ => {
                    self.advance();
                }
            }
        }

        Ok(CompoundCommand::Arithmetic(expr.trim().to_string()))
    }

    /// Parse function definition with 'function' keyword: function name { body }
    fn parse_function_keyword(&mut self) -> Result<Command> {
        let start_span = self.current_span;
        self.advance(); // consume 'function'
        // Bash requires the next word on the same line (`function` then a newline
        // is "unexpected token `newline'").

        // Get function name
        let name = match &self.current_token {
            Some(tokens::Token::Word(w)) => w.clone(),
            _ => return Err(self.error("expected function name")),
        };
        let body = self.parse_function_keyword_rest();
        let body = body?;
        let end_offset = self.current_command_end_offset();

        Ok(Command::Function(FunctionDef {
            name,
            body: Box::new(body),
            source: self.source_slice(start_span.start.offset, end_offset),
            span: start_span.merge(self.current_span),
        }))
    }

    /// Parse POSIX-style function definition: name() { body }
    fn parse_function_posix(&mut self) -> Result<Command> {
        let start_span = self.current_span;
        // Get function name
        let name = match &self.current_token {
            Some(tokens::Token::Word(w)) => w.clone(),
            _ => return Err(self.error("expected function name")),
        };
        self.advance();

        // Consume ()
        if !matches!(self.current_token, Some(tokens::Token::LeftParen)) {
            return Err(self.error("expected '(' in function definition"));
        }
        self.advance(); // consume '('

        if !matches!(self.current_token, Some(tokens::Token::RightParen)) {
            return Err(self.error("expected ')' in function definition"));
        }
        let body = self.parse_function_posix_rest();
        let body = body?;
        let end_offset = self.current_command_end_offset();

        Ok(Command::Function(FunctionDef {
            name,
            body: Box::new(body),
            source: self.source_slice(start_span.start.offset, end_offset),
            span: start_span.merge(self.current_span),
        }))
    }

    /// `function name [()] body`, after the name.
    fn parse_function_keyword_rest(&mut self) -> Result<Command> {
        self.advance();
        self.skip_newlines()?;

        // Optional () after name
        if matches!(self.current_token, Some(tokens::Token::LeftParen)) {
            self.advance(); // consume '('
            if !matches!(self.current_token, Some(tokens::Token::RightParen)) {
                return Err(Error::parse(
                    "expected ')' in function definition".to_string(),
                ));
            }
            self.advance(); // consume ')'
            self.skip_newlines()?;
        }
        self.parse_function_body()
    }

    /// `name () body`, from the `)`.
    fn parse_function_posix_rest(&mut self) -> Result<Command> {
        self.advance(); // consume ')'
        self.skip_newlines()?;
        self.parse_function_body()
    }

    /// A function body: any compound command with its redirections
    /// (`f() ( sub )`, `f() if ...; fi`, `f() { ...; } >log`), like bash.
    fn parse_function_body(&mut self) -> Result<Command> {
        let body_line = self.current_span.end.line;
        let compound_start = match &self.current_token {
            Some(
                tokens::Token::LeftBrace
                | tokens::Token::LeftParen
                | tokens::Token::DoubleLeftParen
                | tokens::Token::DoubleLeftBracket,
            ) => true,
            Some(tokens::Token::Word(w)) => matches!(
                w.as_str(),
                "if" | "for" | "while" | "until" | "case" | "select"
            ),
            _ => false,
        };
        if !compound_start {
            return Err(self.error("expected '{' for function body"));
        }
        match self.parse_command()? {
            Some(cmd) if matches!(*cmd, Command::Compound(..)) => {
                self.anchor_function_redirects(*cmd, body_line)
            }
            _ => Err(self.error("expected '{' for function body")),
        }
    }

    /// Parse commands until a terminating keyword
    fn parse_compound_list(&mut self, terminator: &str) -> Result<Vec<Command>> {
        self.parse_compound_list_until(&[terminator])
    }

    /// Parse commands until one of the terminating keywords
    fn parse_compound_list_until(&mut self, terminators: &[&str]) -> Result<Vec<Command>> {
        let mut commands = Vec::new();

        loop {
            self.skip_newlines()?;

            // Check for terminators
            if let Some(tokens::Token::Word(w)) = &self.current_token
                && self.current_escapes.is_empty()
                && terminators.contains(&w.as_str())
            {
                break;
            }

            if self.current_token.is_none() {
                break;
            }

            if let Some(cmd) = self.parse_command_list()? {
                commands.push(*cmd);
            } else {
                break;
            }
        }

        Ok(commands)
    }

    /// Reserved words that cannot start a simple command.
    /// These words are only special in command position, not as arguments.
    const NON_COMMAND_WORDS: &'static [&'static str] =
        &["then", "else", "elif", "fi", "do", "done", "esac", "in"];

    /// Check if a word cannot start a command
    fn is_non_command_word(word: &str) -> bool {
        Self::NON_COMMAND_WORDS.contains(&word)
    }

    /// Check if current token is a specific keyword
    fn is_keyword(&self, keyword: &str) -> bool {
        self.current_escapes.is_empty()
            && matches!(&self.current_token, Some(tokens::Token::Word(w)) if w == keyword)
    }

    /// Expect a specific keyword
    fn expect_keyword(&mut self, keyword: &str) -> Result<()> {
        if self.is_keyword(keyword) {
            self.advance();
            Ok(())
        } else {
            Err(self.error(format!("expected '{}'", keyword)))
        }
    }

    /// Strip surrounding quotes from a string value
    /// Split array element text respecting single and double quotes.
    /// Returns Vec of (element_text, was_quoted).
    /// Quoted elements have their outer quotes stripped.
    fn split_array_elements(s: &str) -> Vec<(String, bool)> {
        let mut result = Vec::new();
        let mut current = String::new();
        let mut chars = s.chars().peekable();
        let mut in_double_quote = false;
        let mut in_single_quote = false;
        let mut is_quoted = false;

        while let Some(c) = chars.next() {
            match c {
                '"' if !in_single_quote => {
                    in_double_quote = !in_double_quote;
                    is_quoted = true;
                    // Don't include the quote character in output
                }
                '\'' if !in_double_quote => {
                    in_single_quote = !in_single_quote;
                    is_quoted = true;
                    // Don't include the quote character in output
                }
                '\\' if in_double_quote => {
                    // In double quotes, backslash escapes certain chars
                    if let Some(&next) = chars.peek() {
                        if matches!(next, '$' | '`' | '"' | '\\' | '\n') {
                            current.push(chars.next().unwrap());
                        } else {
                            current.push(c);
                        }
                    } else {
                        current.push(c);
                    }
                }
                c if c.is_ascii_whitespace() && !in_double_quote && !in_single_quote => {
                    if !current.is_empty() {
                        result.push((current.clone(), is_quoted));
                        current.clear();
                        is_quoted = false;
                    }
                }
                _ => {
                    current.push(c);
                }
            }
        }
        if !current.is_empty() {
            result.push((current, is_quoted));
        }
        result
    }

    fn strip_quotes(s: &str) -> &str {
        if s.len() >= 2
            && ((s.starts_with('"') && s.ends_with('"'))
                || (s.starts_with('\'') && s.ends_with('\'')))
        {
            return &s[1..s.len() - 1];
        }
        s
    }

    /// Find the assignment operator, ignoring `=` characters inside array subscripts.
    fn assignment_operator_pos(word: &str) -> Option<usize> {
        let mut bracket_depth = 0usize;
        let mut in_single_quote = false;
        let mut in_double_quote = false;
        let mut escaped = false;

        for (pos, c) in word.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }

            if bracket_depth > 0 && c == '\\' {
                escaped = true;
                continue;
            }

            match c {
                '\'' if bracket_depth > 0 && !in_double_quote => {
                    in_single_quote = !in_single_quote;
                }
                '"' if bracket_depth > 0 && !in_single_quote => {
                    in_double_quote = !in_double_quote;
                }
                '[' if !in_single_quote && !in_double_quote => {
                    bracket_depth += 1;
                }
                ']' if bracket_depth > 0 && !in_single_quote && !in_double_quote => {
                    bracket_depth -= 1;
                }
                '=' if bracket_depth == 0 => return Some(pos),
                _ => {}
            }
        }

        None
    }

    /// Check if a word is an assignment (NAME=value, NAME+=value, or NAME[index]=value)
    /// Returns (name, optional_index, value, is_append)
    fn is_assignment(word: &str) -> Option<(&str, Option<&str>, &str, bool)> {
        let eq_pos = Self::assignment_operator_pos(word)?;
        let mut lhs = &word[..eq_pos];
        let is_append = lhs.ends_with('+');
        if is_append {
            lhs = &lhs[..lhs.len() - 1];
        }
        let value = &word[eq_pos + 1..];

        // Check for array subscript: name[index]
        if let Some(bracket_pos) = lhs.find('[') {
            let name = &lhs[..bracket_pos];
            // Validate name
            if name.is_empty() {
                return None;
            }
            let mut chars = name.chars();
            let first = chars.next().unwrap();
            if !first.is_ascii_alphabetic() && first != '_' {
                return None;
            }
            for c in chars {
                if !c.is_ascii_alphanumeric() && c != '_' {
                    return None;
                }
            }
            // Extract index (everything between [ and ])
            if lhs.ends_with(']') {
                let index = &lhs[bracket_pos + 1..lhs.len() - 1];
                return Some((name, Some(index), value, is_append));
            }
        } else {
            // Name must be valid identifier: starts with letter or _, followed by alnum or _
            if lhs.is_empty() {
                return None;
            }
            let mut chars = lhs.chars();
            let first = chars.next().unwrap();
            if !first.is_ascii_alphabetic() && first != '_' {
                return None;
            }
            for c in chars {
                if !c.is_ascii_alphanumeric() && c != '_' {
                    return None;
                }
            }
            return Some((lhs, None, value, is_append));
        }
        None
    }

    /// Parse a simple command with redirections
    /// Collect array elements between `(` and `)` tokens into a `Vec<Word>`.
    fn collect_array_elements(&mut self) -> Vec<Word> {
        let mut elements = Vec::new();
        loop {
            match &self.current_token {
                Some(tokens::Token::RightParen) => {
                    self.advance();
                    break;
                }
                Some(tokens::Token::DoubleRightParen) => {
                    // The array owns only the first `)`; the surrounding
                    // subshell or command owns the second one.
                    self.current_token = Some(tokens::Token::RightParen);
                    self.current_span.start.offset += 1;
                    self.current_span.start.column += 1;
                    break;
                }
                Some(tokens::Token::Word(elem))
                | Some(tokens::Token::LiteralWord(elem))
                | Some(tokens::Token::QuotedWord(elem))
                | Some(tokens::Token::QuotedGlobWord(elem)) => {
                    let elem_clone = elem.clone();
                    let word = if matches!(&self.current_token, Some(tokens::Token::LiteralWord(_)))
                    {
                        Word {
                            parts: vec![WordPart::Literal(elem_clone)],
                            quoted: true,
                            has_unquoted_glob: false,
                            part_quoted: Vec::new(),
                            raw: self.current_raw.clone(),
                        }
                    } else if matches!(
                        &self.current_token,
                        Some(tokens::Token::QuotedWord(_)) | Some(tokens::Token::QuotedGlobWord(_))
                    ) {
                        let glob_quoted =
                            matches!(&self.current_token, Some(tokens::Token::QuotedGlobWord(_)));
                        let mut w = self.parse_current_word(elem_clone);
                        w.quoted = true;
                        // Mixed words like `"x"{1,2}` or `"a"*` keep their unquoted
                        // brace/glob text active, as for command arguments.
                        w.has_unquoted_glob = glob_quoted;
                        w
                    } else {
                        self.parse_current_word(elem_clone)
                    };
                    elements.push(self.with_raw(word));
                    self.advance();
                }
                None => break,
                // bash: `a=(1 & 2)` is a syntax error at the operator.
                Some(
                    tokens::Token::Semicolon
                    | tokens::Token::DoubleSemicolon
                    | tokens::Token::SemiAmp
                    | tokens::Token::DoubleSemiAmp
                    | tokens::Token::Pipe
                    | tokens::Token::PipeBoth
                    | tokens::Token::And
                    | tokens::Token::Or
                    | tokens::Token::Background
                    | tokens::Token::LeftParen
                    | tokens::Token::DoubleLeftParen
                    | tokens::Token::RedirectOut
                    | tokens::Token::RedirectAppend
                    | tokens::Token::RedirectIn,
                ) => {
                    let err = self.error("unexpected token");
                    let first = self.deferred_error.take();
                    self.deferred_error.set(first.or(Some(err)));
                    self.advance();
                }
                _ => {
                    self.advance();
                }
            }
        }
        elements
    }

    /// Parse the value side of an assignment (`VAR=value`).
    /// Returns `Some((Assignment, needs_advance))` if the current word is an assignment.
    /// The bool indicates whether the caller must call `self.advance()` afterward.
    /// Literal text is already quote-removed data. Protection stays in
    /// `part_quoted` and literal-escape metadata, including for mixed globs.
    // THREAT[TM-DOS-044]: array elements and scalar values parse words that
    // may hold nested substitutions, so this frame is on the recursive path.
    // Source slicing and Assignment assembly live in out-of-line helpers.
    fn try_parse_assignment(&mut self, w: &str) -> Option<(Assignment, bool)> {
        let mut source = self.assignment_source(w)?;
        let (value, advanced) = if source.is_array_literal() {
            (self.assignment_array_value(&source), true)
        } else if source.value.is_empty() {
            self.empty_assignment_value(&mut source)
        } else {
            (self.assignment_scalar_value(&mut source), true)
        };
        Some(finish_assignment(source, value, advanced))
    }

    #[inline(never)]
    fn assignment_source(&self, w: &str) -> Option<Box<AssignmentSource>> {
        let (name, index, value, is_append) = Self::is_assignment(w)?;
        let value_start = w.len() - value.len();
        let operator_start = value_start - if is_append { 2 } else { 1 };
        if self.current_escapes.iter().any(|escape| {
            escape.start <= name.len()
                || (escape.start >= operator_start && escape.start < value_start)
        }) {
            return None;
        }
        let value_escapes = LiteralEscape::slice(&self.current_escapes, value_start, w.len());
        // Source text of the value (after `=`), for function printing.
        let value_raw = self.current_raw.as_deref().map(|raw| {
            let start = match index {
                Some(_) => raw.find("]=").or_else(|| raw.find("]+=")).map(|i| i + 1),
                None => raw.find(['=', '+']),
            }
            .unwrap_or(0);
            let rest = &raw[start..];
            rest.strip_prefix("+=")
                .or_else(|| rest.strip_prefix('='))
                .unwrap_or(rest)
                .to_string()
        });
        let name = name.to_string();
        // A quoted subscript (`a["1"]=x`, `a['2']=x`) keeps its source text:
        // arithmetic drops double quotes but rejects single ones, as bash.
        let index = match index {
            Some(ix) if ix.contains(['\u{1e}', '\u{1f}']) => Some(
                self.source_slice(self.current_span.start.offset, self.current_span.end.offset)
                    .and_then(|raw| Self::raw_subscript(&raw, &name))
                    .unwrap_or_else(|| ix.to_string()),
            ),
            ix => ix.map(|s| {
                let start = name.len() + 1;
                let escapes = LiteralEscape::slice(&self.current_escapes, start, start + s.len());
                LiteralEscape::restore(s, &escapes)
            }),
        };
        let value_str = value.to_string();
        Some(Box::new(AssignmentSource {
            name,
            index,
            value: value_str,
            escapes: value_escapes,
            raw: value_raw,
            append: is_append,
        }))
    }

    #[inline(never)]
    fn assignment_array_value(&self, source: &AssignmentSource) -> AssignmentValue {
        let inner = &source.value[1..source.value.len() - 1];
        let mut elements: Vec<Word> = Self::split_array_elements(inner)
            .into_iter()
            .map(|(s, quoted)| {
                let mut word = self.parse_word(s);
                word.quoted |= quoted;
                word
            })
            .collect();
        if let Some(raw) = source.raw.as_deref() {
            let raw_inner = raw
                .strip_prefix('(')
                .and_then(|r| r.strip_suffix(')'))
                .unwrap_or(raw);
            let raws = split_raw_words(raw_inner);
            if raws.len() == elements.len() {
                for (elem, r) in elements.iter_mut().zip(raws) {
                    elem.raw = Some(r);
                }
            }
        }
        AssignmentValue::Array(elements)
    }

    /// `name=` followed by an adjacent `(` starts an array; otherwise empty.
    #[inline(never)]
    fn empty_assignment_value(&mut self, source: &mut AssignmentSource) -> (AssignmentValue, bool) {
        let word_end = self.current_span.end.offset;
        self.advance();
        if matches!(self.current_token, Some(tokens::Token::LeftParen))
            && self.current_span.start.offset == word_end
        {
            self.advance(); // consume '('
            return (AssignmentValue::Array(self.collect_array_elements()), false);
        }
        if matches!(self.current_token, Some(tokens::Token::LeftParen)) {
            let err = self.error("unexpected token");
            let first = self.deferred_error.take();
            self.deferred_error.set(first.or(Some(err)));
        }
        let mut empty = Word::literal("");
        empty.raw = source.raw.take();
        (AssignmentValue::Scalar(empty), false)
    }

    #[inline(never)]
    fn assignment_scalar_value(&self, source: &mut AssignmentSource) -> AssignmentValue {
        let mut word =
            self.parse_word_with_escapes(std::mem::take(&mut source.value), &source.escapes);
        word.raw = source.raw.take();
        AssignmentValue::Scalar(word)
    }

    fn try_parse_compound_array_arg(
        &mut self,
        saved_w: String,
        saved_raw: Option<String>,
    ) -> Option<Word> {
        if !matches!(self.current_token, Some(tokens::Token::LeftParen)) {
            return None;
        }
        let lhs = saved_w.strip_suffix('=')?;
        let (name, append) = match lhs.strip_suffix('+') {
            Some(name) => (name, true),
            None => (lhs, false),
        };
        let base = name.split('[').next().unwrap_or(name);
        let valid = base
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return None;
        }
        let name = name.to_string();
        self.advance(); // consume '('
        let elements = self.collect_array_elements();
        // Source text as written, for `type`/`declare -f`.
        let raw = saved_raw.map(|r| {
            let elems: Vec<&str> = elements
                .iter()
                .map(|e| e.raw.as_deref().unwrap_or(""))
                .collect();
            format!("{r}({})", elems.join(" "))
        });
        Some(Word {
            parts: vec![WordPart::CompoundAssignment {
                name,
                append,
                elements,
            }],
            quoted: true,
            has_unquoted_glob: false,
            part_quoted: Vec::new(),
            raw,
        })
    }

    /// Parse a heredoc redirect (`<<` or `<<-`) and any trailing redirects on the same line.
    // Out of line: its body-reading temporaries must not grow the frame
    // of the recursive command parser.
    #[inline(never)]
    fn parse_heredoc_redirect(
        &mut self,
        redirects: &mut Vec<Redirect>,
        fd_var: Option<String>,
    ) -> Result<()> {
        let (fd, strip_tabs) = match self.current_token {
            Some(tokens::Token::HereDocFd(fd, strip)) => (Some(fd), strip),
            Some(tokens::Token::HereDocStrip) => (None, true),
            _ => (None, false),
        };
        // Capture the delimiter's source text: bash quote-removes it and
        // treats the body as literal when any part of it was quoted
        // (`<<'E'`, `<<\E`, `<<E"OF"`).
        let was_capturing = self.lexer.capture_raw();
        self.lexer.set_capture_raw(true);
        self.advance();
        self.lexer.set_capture_raw(was_capturing);
        // Get the delimiter word and track if it was quoted
        let (delimiter, quoted) = match &self.current_token {
            Some(tokens::Token::Word(w)) => (w.clone(), false),
            Some(tokens::Token::LiteralWord(w)) => (w.clone(), true),
            Some(tokens::Token::QuotedWord(w)) | Some(tokens::Token::QuotedGlobWord(w)) => {
                (w.clone(), true)
            }
            _ => return Err(Error::parse("expected delimiter after <<".to_string())),
        };
        let (delimiter, quoted, printed) = match self.current_raw.as_deref() {
            Some(raw) => {
                let (eof, quoted) = heredoc_eof_from_raw(raw);
                let printed = if quoted {
                    single_quote(&eof)
                } else {
                    raw.to_string()
                };
                (eof, quoted, printed)
            }
            None => {
                let printed = if quoted {
                    single_quote(&delimiter)
                } else {
                    delimiter.clone()
                };
                (delimiter, quoted, printed)
            }
        };

        let (content, rest_of_line_chars) = self
            .lexer
            .read_heredoc_with_strip_metered(&delimiter, strip_tabs);
        self.tick_units(rest_of_line_chars)?;

        // Strip leading tabs for <<-
        let content = if strip_tabs {
            let had_trailing_newline = content.ends_with('\n');
            let mut stripped: String = content
                .lines()
                .map(|l: &str| l.trim_start_matches('\t'))
                .collect::<Vec<_>>()
                .join("\n");
            if had_trailing_newline {
                stripped.push('\n');
            }
            stripped
        } else {
            content
        };

        let mut target = if quoted {
            Word::quoted_literal(content.clone())
        } else {
            self.parse_word(heredoc_body_escapes(&content))
        };
        target.raw = Some(content);

        let kind = if strip_tabs {
            RedirectKind::HereDocStrip
        } else {
            RedirectKind::HereDoc
        };

        redirects.push(Redirect {
            expansion_line: None,
            fd,
            fd_var,
            kind,
            target,
            heredoc_delim: Some(printed),
        });

        // Advance so re-injected rest-of-line tokens are picked up
        self.advance();
        Ok(())
    }

    /// `{fd}&>> file` in a simple command. Out of line, like
    /// [`Self::push_append_both`], to keep the recursive parser's frame small.
    #[inline(never)]
    fn parse_append_both(
        &mut self,
        words: &mut Vec<Word>,
        redirects: &mut Vec<Redirect>,
    ) -> Result<()> {
        let fd_var = Self::pop_fd_var(words);
        self.advance();
        let target = self.expect_word()?;
        Self::push_append_both(redirects, fd_var, target);
        Ok(())
    }

    /// `&>> file` is `>> file 2>&1` (bash documents it as that). Out of
    /// line so the two `Redirect` temporaries stay off the stack frame of
    /// the recursive command parsers.
    #[inline(never)]
    fn push_append_both(redirects: &mut Vec<Redirect>, fd_var: Option<String>, target: Word) {
        redirects.push(Redirect {
            expansion_line: None,
            fd: None,
            fd_var,
            kind: RedirectKind::Append,
            target,
            heredoc_delim: None,
        });
        redirects.push(Redirect {
            expansion_line: None,
            fd: Some(2),
            fd_var: None,
            kind: RedirectKind::DupOutput,
            target: Word::literal("1"),
            heredoc_delim: None,
        });
    }

    /// Extract fd-variable name from `{varname}` pattern in the last word.
    /// If the last word is a single literal `{identifier}`, pop it and return the name.
    /// Used for `exec {var}>file` / `exec {var}>&-` syntax.
    fn pop_fd_var(words: &mut Vec<Word>) -> Option<String> {
        // `{arr[i]}` lexes as several literal parts, because `[` opens a glob
        // bracket, so the name is read from the parts joined rather than from
        // a single one.
        let joined = words.last().and_then(|last| {
            last.parts
                .iter()
                .map(|part| match part {
                    WordPart::Literal(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Option<String>>()
        });
        if let Some(ref s) = joined
            && Self::is_fd_var_word(s)
        {
            let var_name = s[1..s.len() - 1].to_string();
            words.pop();
            return Some(var_name);
        }
        None
    }

    /// `{fd}` or `{arr[i]}` (a coproc hands its descriptors out as
    /// `${NAME[0]}` / `${NAME[1]}`, and `exec {NAME[1]}>&-` closes one).
    fn is_fd_var_word(s: &str) -> bool {
        s.starts_with('{')
            && s.ends_with('}')
            && s.len() > 2
            && s[1..s.len() - 1]
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '_' | '[' | ']'))
            && s[1..s.len() - 1].starts_with(|c: char| c.is_alphabetic() || c == '_')
    }

    // THREAT[TM-DOS-044]: on the recursive path. The in-progress command is
    // boxed and token handling is out of line, so this frame stays small.
    fn parse_simple_command(&mut self) -> Result<Option<Box<Command>>> {
        let mut parts = self.begin_simple_command()?;
        loop {
            let counts = (parts.words.len(), parts.assignments.len());
            match self.simple_command_step(&mut parts)? {
                SimpleStep::Word => {
                    if !self.parse_simple_word(&mut parts.words, &mut parts.assignments) {
                        break;
                    }
                }
                SimpleStep::Joined => continue,
                SimpleStep::Other => {}
                SimpleStep::Done => break,
            }
            self.after_simple_token(&mut parts, counts);
        }
        self.finish_simple(parts)
    }

    #[inline(never)]
    fn begin_simple_command(&mut self) -> Result<Box<SimpleParts>> {
        self.tick()?;
        self.skip_newlines()?;
        self.check_error_token()?;
        Ok(Box::new(SimpleParts {
            start_span: self.current_span,
            expansion_line: None,
            assignments: Vec::new(),
            words: Vec::new(),
            redirects: Vec::new(),
            join_end: usize::MAX,
        }))
    }

    /// Handle one token of a simple command, except plain words, which
    /// `parse_simple_command` parses itself (`SimpleStep::Word`).
    #[inline(never)]
    fn simple_command_step(&mut self, parts: &mut SimpleParts) -> Result<SimpleStep> {
        if parts.words.is_empty() {
            // `FOO=1 ll`, `>f ll`: the first word after assignments and
            // redirects is a command name.
            self.expand_command_alias();
        }
        if parts.join_end == self.current_span.start.offset
            && self.join_adjacent_word(&mut parts.words, &mut parts.assignments)?
        {
            parts.join_end = self.prev_token_end;
            return Ok(SimpleStep::Joined);
        }
        match &self.current_token {
            Some(
                tokens::Token::Word(_)
                | tokens::Token::LiteralWord(_)
                | tokens::Token::QuotedWord(_)
                | tokens::Token::QuotedGlobWord(_),
            ) => return Ok(SimpleStep::Word),
            Some(tokens::Token::HereDoc)
            | Some(tokens::Token::HereDocStrip)
            | Some(tokens::Token::HereDocFd(..)) => {
                // Words and redirects may follow on the same line
                // (`cat <<A <<B`, `paste - <<A 3<<B`, `cat <<A file`).
                let fd_var = if matches!(self.current_token, Some(tokens::Token::HereDocFd(..)))
                {
                    None
                } else {
                    Self::pop_fd_var(&mut parts.words)
                };
                self.parse_heredoc_redirect(&mut parts.redirects, fd_var)?;
            }
            Some(tokens::Token::ProcessSubIn) | Some(tokens::Token::ProcessSubOut) => {
                let word = self.expect_word()?;
                parts.words.push(word);
            }
            Some(
                tokens::Token::RedirectOut
                | tokens::Token::Clobber
                | tokens::Token::RedirectAppend
                | tokens::Token::RedirectIn
                | tokens::Token::HereString
                | tokens::Token::RedirectBoth
                | tokens::Token::DupOutput
                | tokens::Token::RedirectFd(_)
                | tokens::Token::RedirectFdAppend(_)
                | tokens::Token::DupFd(..)
                | tokens::Token::DupFdCloseOut(_)
                | tokens::Token::DupFdWord(_)
                | tokens::Token::DupInput
                | tokens::Token::DupFdIn(..)
                | tokens::Token::DupFdClose(_)
                | tokens::Token::RedirectFdIn(_)
                | tokens::Token::RedirectReadWrite
                | tokens::Token::RedirectFdReadWrite(_)
                | tokens::Token::HereStringFd(_),
            ) => {
                self.parse_simple_redirect(&mut parts.words, &mut parts.redirects)?;
            }
            Some(tokens::Token::RedirectBothAppend) => {
                self.parse_append_both(&mut parts.words, &mut parts.redirects)?;
            }
            // {, } and ]] as arguments (not in command position) are literal words
            Some(
                tokens::Token::LeftBrace
                | tokens::Token::RightBrace
                | tokens::Token::DoubleRightBracket,
            ) if !parts.words.is_empty() => {
                let sym = match self.current_token {
                    Some(tokens::Token::LeftBrace) => "{",
                    Some(tokens::Token::RightBrace) => "}",
                    _ => "]]",
                };
                parts.words.push(Word::literal(sym));
                self.advance();
            }
            // After an assignment `[[` is no longer a reserved word:
            // `FOO=bar [[ x ]]` runs a command named `[[` (bash: 127).
            Some(tokens::Token::DoubleLeftBracket)
                if !parts.words.is_empty() || !parts.assignments.is_empty() =>
            {
                parts.words.push(Word::literal("[["));
                self.advance();
            }
            // `echo a(b)`, `foo $x() {`: a `(` after a command word is a
            // syntax error in bash, not the start of a subshell.
            Some(tokens::Token::LeftParen) if !parts.words.is_empty() => {
                return Err(self.error("unexpected token"));
            }
            Some(tokens::Token::Newline)
            | Some(tokens::Token::Semicolon)
            | Some(tokens::Token::Pipe)
            | Some(tokens::Token::And)
            | Some(tokens::Token::Or)
            | None => return Ok(SimpleStep::Done),
            _ => return Ok(SimpleStep::Done),
        }
        Ok(SimpleStep::Other)
    }

    #[inline(never)]
    fn after_simple_token(&mut self, parts: &mut SimpleParts, counts: (usize, usize)) {
        if parts.expansion_line.is_none() {
            parts.expansion_line = Some(self.last_token_line);
        }
        parts.join_end = if parts.words.len() > counts.0 || parts.assignments.len() > counts.1 {
            self.prev_token_end
        } else {
            usize::MAX
        };
    }

    // The box keeps this value out of the recursive caller's frame.
    #[allow(clippy::boxed_local)]
    #[inline(never)]
    fn finish_simple(&mut self, parts: Box<SimpleParts>) -> Result<Option<Box<Command>>> {
        let SimpleParts {
            start_span,
            expansion_line,
            assignments,
            words,
            mut redirects,
            ..
        } = *parts;
        self.anchor_redirects(&mut redirects, expansion_line)?;
        let simple = finish_simple_command(
            words,
            assignments,
            redirects,
            start_span.merge(self.current_span),
            expansion_line,
        )?;
        Ok(box_simple_command(simple))
    }

    /// `x<(true)`, `<(true)x`, `x=<(true)`: a process substitution and the
    /// word text it touches form one word, as in bash. The current token
    /// starts where the last word (or, before the command name, the last
    /// assignment's scalar value) ended. Returns false, consuming nothing,
    /// when the token does not join it.
    #[inline(never)]
    fn join_adjacent_word(
        &mut self,
        words: &mut [Word],
        assignments: &mut [Assignment],
    ) -> Result<bool> {
        let procsub = matches!(
            self.current_token,
            Some(tokens::Token::ProcessSubIn | tokens::Token::ProcessSubOut)
        );
        let word_token = matches!(
            self.current_token,
            Some(
                tokens::Token::Word(_)
                    | tokens::Token::LiteralWord(_)
                    | tokens::Token::QuotedWord(_)
                    | tokens::Token::QuotedGlobWord(_)
            )
        );
        fn target<'w>(
            words: &'w mut [Word],
            assignments: &'w mut [Assignment],
        ) -> Option<&'w mut Word> {
            if words.is_empty() {
                match assignments.last_mut() {
                    Some(Assignment {
                        value: AssignmentValue::Scalar(w),
                        ..
                    }) => Some(w),
                    _ => None,
                }
            } else {
                words.last_mut()
            }
        }
        let Some(prev) = target(words, assignments) else {
            return Ok(false);
        };
        // Two word tokens only touch across a process substitution's `)`.
        let after_procsub = matches!(
            prev.parts.last(),
            Some(WordPart::ProcessSubstitution { .. })
        );
        if !(procsub || (word_token && after_procsub)) {
            return Ok(false);
        }
        let next = self.expect_word()?;
        if let Some(prev) = target(words, assignments) {
            prev.append_word(next);
        }
        Ok(true)
    }

    /// One word of a simple command (outlined to keep the recursive
    /// `parse_simple_command` frame small; `$( )` nesting recurses through it).
    /// Returns false when the word ends the command.
    #[inline(never)]
    fn parse_simple_word(
        &mut self,
        words: &mut Vec<Word>,
        assignments: &mut Vec<Assignment>,
    ) -> bool {
        let Some(token) = self.simple_word_token(words) else {
            return false;
        };
        // Check for assignment (only before the command name, not for literal words)
        if words.is_empty()
            && !token.is_literal
            && let Some(assignment) = self.try_parse_assignment(&token.text)
        {
            self.push_assignment(assignments, assignment);
            return true;
        }
        // Handle compound array assignment in arg position:
        // declare -a arr=(x y z) → arr=(x y z) as single arg
        // Only a declaration builtin, `let` or `eval` named directly takes
        // one: bash rejects `builtin declare a=(x)`, `echo a=(x)` and
        // `command typeset a=(x)` at `(`.
        if token.text.ends_with('=') && is_declaration_command(words) {
            let SimpleWordToken {
                text,
                is_literal,
                is_quoted,
                is_glob_quoted,
            } = *token;
            return self.parse_declaration_word(words, text, is_literal, is_quoted, is_glob_quoted);
        }
        let word = self.simple_word(token);
        self.push_simple_word(words, word);
        true
    }

    /// The current word token, unless it cannot start a command here (like
    /// `then` or `fi` in command position).
    #[inline(never)]
    fn simple_word_token(&self, words: &[Word]) -> Option<Box<SimpleWordToken>> {
        let (text, is_literal, is_quoted, is_glob_quoted) = match &self.current_token {
            Some(tokens::Token::Word(w)) => (w.clone(), false, false, false),
            Some(tokens::Token::LiteralWord(w)) => (w.clone(), true, false, false),
            Some(tokens::Token::QuotedWord(w)) => (w.clone(), false, true, false),
            Some(tokens::Token::QuotedGlobWord(w)) => (w.clone(), false, true, true),
            _ => return None,
        };
        if words.is_empty()
            && !is_literal
            && !is_quoted
            && self.current_escapes.is_empty()
            && Self::is_non_command_word(&text)
        {
            return None;
        }
        Some(Box::new(SimpleWordToken {
            text,
            is_literal,
            is_quoted,
            is_glob_quoted,
        }))
    }

    #[inline(never)]
    fn push_assignment(&mut self, assignments: &mut Vec<Assignment>, parsed: (Assignment, bool)) {
        let (assignment, needs_advance) = parsed;
        if needs_advance {
            self.advance();
        }
        assignments.push(assignment);
    }

    // The box keeps this value out of the recursive caller's frame.
    #[allow(clippy::boxed_local)]
    fn simple_word(&self, token: Box<SimpleWordToken>) -> Word {
        if token.is_literal {
            return self.literal_simple_word(token.text);
        }
        let mut word = self.parse_current_word(token.text);
        word.quoted |= token.is_quoted;
        word.has_unquoted_glob |= token.is_glob_quoted;
        word
    }

    #[inline(never)]
    fn literal_simple_word(&self, text: String) -> Word {
        Word {
            parts: vec![WordPart::Literal(text)],
            quoted: true,
            has_unquoted_glob: false,
            part_quoted: Vec::new(),
            raw: self.current_raw.clone(),
        }
    }

    #[inline(never)]
    fn push_simple_word(&mut self, words: &mut Vec<Word>, word: Word) {
        words.push(self.with_raw(word));
        self.advance();
    }

    #[inline(never)]
    fn parse_declaration_word(
        &mut self,
        words: &mut Vec<Word>,
        w: String,
        is_literal: bool,
        is_quoted: bool,
        is_glob_quoted: bool,
    ) -> bool {
        let saved_raw = self.current_raw.clone();
        let saved_escapes = self.current_escapes.clone();
        self.advance();
        if let Some(word) = self.try_parse_compound_array_arg(w.clone(), saved_raw.clone()) {
            words.push(word);
            return true;
        }
        // Not a compound assignment — treat as regular word
        let word = if is_literal {
            Word {
                parts: vec![WordPart::Literal(w)],
                quoted: true,
                has_unquoted_glob: false,
                part_quoted: Vec::new(),
                raw: saved_raw.clone(),
            }
        } else {
            let mut word = self.parse_word_with_escapes(w, &saved_escapes);
            if is_quoted {
                word.quoted = true;
            }
            if is_glob_quoted {
                word.has_unquoted_glob = true;
            }
            word
        };
        let mut word = word;
        word.raw = saved_raw;
        words.push(word);
        true
    }

    /// One redirection of a simple command (outlined, see `parse_simple_word`).
    #[inline(never)]
    fn parse_simple_redirect(
        &mut self,
        words: &mut Vec<Word>,
        redirects: &mut Vec<Redirect>,
    ) -> Result<()> {
        match &self.current_token {
            Some(tokens::Token::RedirectOut) | Some(tokens::Token::Clobber) => {
                let kind = if matches!(&self.current_token, Some(tokens::Token::Clobber)) {
                    RedirectKind::Clobber
                } else {
                    RedirectKind::Output
                };
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectAppend) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind: RedirectKind::Append,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectIn) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind: RedirectKind::Input,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::HereString) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind: RedirectKind::HereString,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectBoth) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind: RedirectKind::OutputBoth,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupOutput) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: if fd_var.is_some() { None } else { Some(1) },
                    fd_var,
                    kind: RedirectKind::DupOutput,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectFd(fd)) => {
                let fd = *fd;
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::Output,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectFdAppend(fd)) => {
                let fd = *fd;
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::Append,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupFd(src_fd, dst_fd)) => {
                let src_fd = *src_fd;
                let dst_fd = *dst_fd;
                self.advance();
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(src_fd),
                    fd_var: None,
                    kind: RedirectKind::DupOutput,
                    target: Word::literal(dst_fd.to_string()),
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupFdCloseOut(fd)) => {
                let fd = *fd;
                self.advance();
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::DupOutput,
                    target: Word::literal("-"),
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupFdWord(fd)) => {
                let fd = *fd;
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::DupOutput,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupInput) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: if fd_var.is_some() { None } else { Some(0) },
                    fd_var,
                    kind: RedirectKind::DupInput,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupFdIn(src_fd, dst_fd)) => {
                let src_fd = *src_fd;
                let dst_fd = *dst_fd;
                self.advance();
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(src_fd),
                    fd_var: None,
                    kind: RedirectKind::DupInput,
                    target: Word::literal(dst_fd.to_string()),
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::DupFdClose(fd)) => {
                let fd = *fd;
                self.advance();
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::DupInput,
                    target: Word::literal("-"),
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectFdIn(fd)) => {
                let fd = *fd;
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind: RedirectKind::Input,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectReadWrite) => {
                let fd_var = Self::pop_fd_var(words);
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: None,
                    fd_var,
                    kind: RedirectKind::ReadWrite,
                    target,
                    heredoc_delim: None,
                });
            }
            Some(tokens::Token::RedirectFdReadWrite(fd) | tokens::Token::HereStringFd(fd)) => {
                let fd = *fd;
                let kind = if matches!(self.current_token, Some(tokens::Token::HereStringFd(_))) {
                    RedirectKind::HereString
                } else {
                    RedirectKind::ReadWrite
                };
                self.advance();
                let target = self.expect_word()?;
                redirects.push(Redirect {
                    expansion_line: None,
                    fd: Some(fd),
                    fd_var: None,
                    kind,
                    target,
                    heredoc_delim: None,
                });
            }
            _ => {}
        }
        Ok(())
    }

    /// Expect a word token and return it as a Word
    fn expect_word(&mut self) -> Result<Word> {
        match &self.current_token {
            Some(tokens::Token::Word(w)) => {
                let word = self.with_raw(self.parse_current_word(w.clone()));
                self.advance();
                Ok(word)
            }
            Some(tokens::Token::LiteralWord(w)) => {
                // Single-quoted: no variable expansion
                let word = Word {
                    parts: vec![WordPart::Literal(w.clone())],
                    quoted: true,
                    has_unquoted_glob: false,
                    part_quoted: Vec::new(),
                    raw: self.current_raw.clone(),
                };
                self.advance();
                Ok(word)
            }
            Some(tokens::Token::QuotedWord(w)) | Some(tokens::Token::QuotedGlobWord(w)) => {
                // Double-quoted: parse for variable expansion. Marked quoted
                // as command words are, so a redirect target such as
                // `> one-\*` or `> "$f"` is neither split nor globbed.
                let glob = matches!(&self.current_token, Some(tokens::Token::QuotedGlobWord(_)));
                let mut word = self.parse_current_word(w.clone());
                word.quoted = true;
                word.has_unquoted_glob |= glob;
                let word = self.with_raw(word);
                self.advance();
                Ok(word)
            }
            Some(tokens::Token::ProcessSubIn) | Some(tokens::Token::ProcessSubOut) => {
                // Process substitution <(cmd) or >(cmd).
                //
                // Issue #1333: extract the body from the original source via span
                // offsets rather than reconstructing a string from the token stream.
                // Token-string reconstruction wraps `QuotedGlobWord` in `"..."`,
                // erasing the unquoted-glob boundary and breaking glob expansion
                // for patterns like `./"$var"*.ext` inside `<(...)`.
                let is_input = matches!(self.current_token, Some(tokens::Token::ProcessSubIn));
                let start_line = self.current_span.start.line;
                // Span end of the `<(` / `>(` token is exactly the start of the body.
                let body_start_offset = self.current_span.end.offset;
                let mut depth = 1;
                let mut body_end_offset = 0;
                // Find the end the way `$(...)` does (quote/case/heredoc
                // aware, see subst_scan), so `<(case a in a) ...;; esac)`
                // does not stop at the pattern's `)`.
                let direct = self.peeked_token.is_none();
                let scanned = direct && self.lexer.skip_subst_body();
                if direct && !scanned {
                    // Same end-of-input rules as an unterminated `$(`.
                    self.classify_unterminated_token(true)?;
                    return Err(self.error("unexpected EOF while looking for matching `)'"));
                }
                // A fused `<((` span is raw text until it expands (bash).
                let fused = scanned && self.lexer.last_substitution_fused();
                if scanned {
                    // The closing `)` is one byte, just consumed.
                    body_end_offset = self.lexer.position().offset.saturating_sub(1);
                    depth = 0;
                }
                self.advance();
                if scanned {
                    // The last consumed text is the `)`, not the `<(` token.
                    self.prev_token_end = body_end_offset + 1;
                }

                while depth > 0 {
                    match &self.current_token {
                        Some(tokens::Token::LeftParen) => {
                            depth += 1;
                            self.advance();
                        }
                        Some(tokens::Token::RightParen) => {
                            depth -= 1;
                            if depth == 0 {
                                // Body ends at the start of the matching `)`.
                                body_end_offset = self.current_span.start.offset;
                                self.advance();
                                break;
                            }
                            self.advance();
                        }
                        Some(tokens::Token::ProcessSubIn) | Some(tokens::Token::ProcessSubOut) => {
                            // Nested <( / >( opens another paren level.
                            depth += 1;
                            self.advance();
                        }
                        Some(tokens::Token::Error(e)) => {
                            if let Some(limit) = self.lexer.limit_exceeded() {
                                return Err(self.limit_error(limit));
                            }
                            let msg = e.clone();
                            self.advance();
                            return Err(Error::parse(format!(
                                "lexer error in process substitution: {}",
                                msg
                            )));
                        }
                        None => {
                            return Err(Error::parse(
                                "unexpected end of input in process substitution".to_string(),
                            ));
                        }
                        _ => {
                            self.advance();
                        }
                    }
                }

                let body_len = body_end_offset.saturating_sub(body_start_offset);
                self.tick_units(body_len)?;

                // THREAT[TM-DOS-021]: Charge nested process-substitution parsers
                // against the same depth/fuel/timeout budget. Borrow the original
                // source slice instead of cloning it so nested `<(...)` cannot retain
                // repeated near-full-size String bodies; charge body bytes because the
                // child lexer must rescan whitespace/comments that produce no tokens.
                if self.current_depth >= self.max_depth {
                    return Err(self.limit_error(LimitExceeded::AstDepth {
                        depth: self.current_depth + 1,
                        limit: self.max_depth,
                    }));
                }
                let inner_result = {
                    let cmd_src = self
                        .input
                        .get(body_start_offset..body_end_offset)
                        .unwrap_or("");
                    let mut inner_parser = Parser::with_limits_and_timeout(
                        cmd_src,
                        self.max_depth,
                        self.fuel.get(),
                        self.timeout,
                    );
                    if let Some(budget) = &self.execution_budget {
                        inner_parser.attach_execution_budget(budget.clone());
                    }
                    inner_parser.strict_command_separators =
                        self.strict_command_separators || self.strict_substitution_bodies;
                    inner_parser.strict_substitution_bodies = self.strict_substitution_bodies;
                    inner_parser.current_depth = self.current_depth + 1;
                    inner_parser.started_at = self.started_at;
                    let mut commands = Vec::new();
                    let result = inner_parser
                        .parse_script_into(&mut commands)
                        .map(|()| commands.into_iter().map(|(cmd, _)| cmd).collect::<Vec<_>>());
                    let raw = Some(format!("{}({cmd_src})", if is_input { '<' } else { '>' }));
                    (result, inner_parser.fuel.get(), raw)
                };
                let (parse_result, remaining_fuel, raw) = inner_result;
                self.fuel.set(remaining_fuel);
                let commands = match parse_result {
                    Ok(commands) => commands,
                    Err(err @ Error::ResourceLimit(_)) => return Err(err),
                    Err(_) if fused => Vec::new(),
                    // Bash parses the body with the script and exits 127.
                    Err(_) if self.strict_substitution_bodies => {
                        return Err(Error::ShellWord { line: start_line });
                    }
                    Err(err) if self.strict_command_separators => return Err(err),
                    Err(_) => Vec::new(),
                };

                Ok(Word {
                    parts: vec![WordPart::ProcessSubstitution { commands, is_input }],
                    quoted: false,
                    has_unquoted_glob: false,
                    part_quoted: Vec::new(),
                    raw,
                })
            }
            _ => Err(self.error("expected word")),
        }
    }

    // Helper methods for word handling - kept for potential future use
    #[allow(dead_code)]
    /// Convert current word token to Word (handles Word, LiteralWord, QuotedWord)
    fn current_word_to_word(&self) -> Option<Word> {
        match &self.current_token {
            Some(tokens::Token::Word(w))
            | Some(tokens::Token::QuotedWord(w))
            | Some(tokens::Token::QuotedGlobWord(w)) => Some(self.parse_current_word(w.clone())),
            Some(tokens::Token::LiteralWord(w)) => Some(Word {
                parts: vec![WordPart::Literal(w.clone())],
                quoted: true,
                has_unquoted_glob: false,
                part_quoted: Vec::new(),
                raw: None,
            }),
            _ => None,
        }
    }

    #[allow(dead_code)]
    /// Check if current token is a word (Word, LiteralWord, or QuotedWord)
    fn is_current_word(&self) -> bool {
        matches!(
            &self.current_token,
            Some(tokens::Token::Word(_))
                | Some(tokens::Token::LiteralWord(_))
                | Some(tokens::Token::QuotedWord(_))
                | Some(tokens::Token::QuotedGlobWord(_))
        )
    }

    #[allow(dead_code)]
    /// Get the string content if current token is a word
    fn current_word_str(&self) -> Option<String> {
        match &self.current_token {
            Some(tokens::Token::Word(w))
            | Some(tokens::Token::LiteralWord(w))
            | Some(tokens::Token::QuotedWord(w))
            | Some(tokens::Token::QuotedGlobWord(w)) => Some(w.clone()),
            _ => None,
        }
    }

    /// Parser for a `$(...)` body, on the heap: one lives per nesting level
    /// while the inner script parses, so keeping it out of `parse_word`'s
    /// frame leaves room for deep nesting (TM-DOS-044).
    // THREAT[TM-DOS-021]: Propagate parent parser limits to child parser
    // to prevent depth limit bypass via nested command substitution.
    #[inline(never)]
    fn nested_parser<'b>(&self, src: &'b str) -> Result<Box<Parser<'b>>> {
        if self.current_depth >= self.max_depth {
            return Err(self.limit_error(LimitExceeded::AstDepth {
                depth: self.current_depth + 1,
                limit: self.max_depth,
            }));
        }
        let mut parser = Box::new(Parser::with_limits_and_timeout(
            src,
            self.max_depth,
            self.fuel.get(),
            self.timeout,
        ));
        parser.current_depth = self.current_depth + 1;
        parser.started_at = self.started_at;
        if let Some(budget) = &self.execution_budget {
            parser.attach_execution_budget(budget.clone());
        }
        parser.set_options(self.options.clone());
        parser.strict_command_separators =
            self.strict_command_separators || self.strict_substitution_bodies;
        parser.strict_substitution_bodies = self.strict_substitution_bodies;
        // `$( )` spans count from the outer word's line, so `$LINENO` and
        // error line numbers inside it match bash.
        let shift = self.current_span.start.line.saturating_sub(1);
        if shift > 0 {
            parser.lexer.shift_lines(shift);
            parser.current_span.start.line += shift;
            parser.current_span.end.line += shift;
        }
        Ok(parser)
    }

    // THREAT[TM-DOS-044]: This nonrecursive branch has many WordPart
    // temporaries. Keep its frame out of every nested substitution parse.
    #[inline(never)]
    fn parse_braced_parameter(
        &self,
        chars: &mut WordChars<'_>,
        parts: &mut Vec<WordPart>,
        part_quoted: &mut Vec<bool>,
        in_quoted_segment: bool,
        pattern_context: bool,
        operand_bodies: &mut Vec<String>,
    ) {
        macro_rules! push_part {
            ($part:expr) => {{
                parts.push($part);
                part_quoted.push(in_quoted_segment);
            }};
        }
        // ${VAR} format with possible parameter expansion
        chars.next(); // consume '{'
        if let Err(error) = self.parameter_shell_bodies(
            chars,
            in_quoted_segment,
            pattern_context,
            operand_bodies,
        ) {
            let first = self.deferred_error.take();
            self.deferred_error.set(first.or(Some(error)));
        }

        if let Some(inner) = bad_brace_parameter(chars) {
            // Bash accepts the word and fails when expanding it.
            for _ in 0..=inner.chars().count() {
                chars.next();
            }
            push_part!(WordPart::BadSubstitution(bad_substitution_text(&inner)));
        } else if chars.peek() == Some(&'#') && !hash_param_with_op(chars) {
            // ${#var} or ${#arr[@]} - length expansion
            chars.next(); // consume '#'
            let mut var_name = String::new();
            while let Some(&c) = chars.peek() {
                if c == '}' || c == '[' {
                    break;
                }
                var_name.push(chars.next().unwrap());
            }
            // Check for array length ${#arr[@]} or ${#arr[*]}
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                let mut index = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        break;
                    }
                    index.push(chars.next().unwrap());
                }
                // Consume closing }
                if chars.peek() == Some(&'}') {
                    chars.next();
                }
                if index == "@" || index == "*" {
                    push_part!(WordPart::ArrayLength(var_name));
                } else {
                    // ${#arr[n]} - length of element (same as ${#arr[n]})
                    push_part!(WordPart::Length(format!("{}[{}]", var_name, index)));
                }
            } else {
                // Consume closing }
                if chars.peek() == Some(&'}') {
                    chars.next();
                }
                if var_name.is_empty() {
                    // `${#}` is `$#`, not a length.
                    push_part!(WordPart::Variable("#".to_string()));
                } else {
                    push_part!(WordPart::Length(var_name));
                }
            }
        } else if chars.peek() == Some(&'!') {
            // Check for ${!arr[@]} or ${!arr[*]} - array indices
            // or ${!var} - indirect expansion
            chars.next(); // consume '!'
            let mut var_name = String::new();
            while let Some(&c) = chars.peek() {
                if c == '}'
                    || c == '['
                    || c == '*'
                    || c == '@'
                    || c == ':'
                    || c == '-'
                    || c == '='
                    || c == '+'
                    || c == '?'
                {
                    break;
                }
                // `${!x#y}`, `${!x/a/b}`: an operator ends the name
                // (`${!#}` is still the indirect `$#`).
                if !var_name.is_empty() && matches!(c, '#' | '%' | '/' | '^' | ',' | '~') {
                    break;
                }
                var_name.push(chars.next().unwrap());
            }
            // Check for array indices ${!arr[@]} or ${!arr[*]}
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                let mut index = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        break;
                    }
                    index.push(chars.next().unwrap());
                }
                if chars.peek() == Some(&'}') {
                    chars.next();
                    if index == "@" || index == "*" {
                        push_part!(WordPart::ArrayIndices {
                            name: var_name,
                            star: index == "*",
                        });
                    } else {
                        // `${!a[1]}`: the element names the variable.
                        push_part!(WordPart::IndirectSuffix {
                            name: format!("{var_name}[{index}]"),
                            suffix: String::new(),
                        });
                    }
                } else {
                    // `${!ref[@]:2}`, `${!a[0]#x}`: the elements'
                    // value names the variable the operator applies to.
                    let suffix = self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                    push_part!(WordPart::IndirectSuffix {
                        name: format!("{var_name}[{index}]"),
                        suffix,
                    });
                }
            } else if chars.peek() == Some(&'}') {
                // ${!var} - indirect expansion (no operator)
                chars.next(); // consume '}'
                push_part!(WordPart::IndirectExpansion {
                    name: var_name,
                    operator: None,
                    operand: String::new(),
                    colon_variant: false,
                });
            } else if chars.peek() == Some(&':') {
                // ${!var:op} - indirect expansion with colon operator
                let mut lookahead = chars.clone();
                lookahead.next(); // skip ':'
                if matches!(
                    lookahead.peek(),
                    Some(&'-') | Some(&'=') | Some(&'+') | Some(&'?')
                ) {
                    chars.next(); // consume ':'
                    let op_char = chars.next().unwrap();
                    let operand =
                        self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                    let operator = match op_char {
                        '-' => ParameterOp::UseDefault,
                        '=' => ParameterOp::AssignDefault,
                        '+' => ParameterOp::UseReplacement,
                        '?' => ParameterOp::Error,
                        _ => unreachable!(),
                    };
                    push_part!(WordPart::IndirectExpansion {
                        name: var_name,
                        operator: Some(operator),
                        operand,
                        colon_variant: true,
                    });
                } else {
                    // `${!x:1:2}`: substring of the named variable.
                    let suffix = self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                    push_part!(WordPart::IndirectSuffix {
                        name: var_name,
                        suffix,
                    });
                }
            } else if matches!(
                chars.peek(),
                Some(&'-') | Some(&'=') | Some(&'+') | Some(&'?')
            ) {
                // ${!var-op} - indirect expansion with non-colon operator
                let op_char = chars.next().unwrap();
                let operand = self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                let operator = match op_char {
                    '-' => ParameterOp::UseDefault,
                    '=' => ParameterOp::AssignDefault,
                    '+' => ParameterOp::UseReplacement,
                    '?' => ParameterOp::Error,
                    _ => unreachable!(),
                };
                push_part!(WordPart::IndirectExpansion {
                    name: var_name,
                    operator: Some(operator),
                    operand,
                    colon_variant: false,
                });
            } else {
                // ${!prefix*} or ${!prefix@} - prefix matching
                let suffix = self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                // `${!ref@a}`: transform the variable `ref` names.
                if push_indirect_transformation(
                    parts,
                    part_quoted,
                    in_quoted_segment,
                    &var_name,
                    &suffix,
                ) {
                } else if suffix.ends_with('*') || suffix.ends_with('@') {
                    let full_prefix = format!("{}{}", var_name, &suffix[..suffix.len() - 1]);
                    push_part!(WordPart::PrefixMatch {
                        prefix: full_prefix,
                        star: suffix.ends_with('*'),
                    });
                } else {
                    push_part!(WordPart::IndirectSuffix {
                        name: var_name,
                        suffix,
                    });
                }
            }
        } else {
            // Read variable name
            let mut var_name = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphanumeric() || c == '_' {
                    var_name.push(chars.next().unwrap());
                } else {
                    break;
                }
            }

            // Handle special parameters: ${@...}, ${*...}, ${-...},
            // ${?...}, ${$...}
            if var_name.is_empty()
                && let Some(&c) = chars.peek()
                && matches!(c, '@' | '*' | '-' | '?' | '$' | '#')
            {
                var_name.push(chars.next().unwrap());
            }

            // Check for array access ${arr[index]} or ${arr[@]:offset:length}
            // `${arr[i]OP...}` with a pattern/case/transform OP reuses the
            // scalar operator parsing below on the name `arr[i]`.
            let mut subscript_op = false;
            let had_subscript = chars.peek() == Some(&'[');
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                let mut index = String::new();
                // Track nesting so nested ${...} containing
                // brackets (e.g. ${#arr[@]}) don't prematurely
                // close the subscript.
                let mut bracket_depth: i32 = 0;
                let mut brace_depth: i32 = 0;
                while let Some(&c) = chars.peek() {
                    if c == ']' && bracket_depth == 0 && brace_depth == 0 {
                        chars.next();
                        break;
                    }
                    match c {
                        '[' => bracket_depth += 1,
                        ']' => bracket_depth -= 1,
                        '$' => {
                            index.push(chars.next().unwrap());
                            if chars.peek() == Some(&'{') {
                                brace_depth += 1;
                                index.push(chars.next().unwrap());
                                continue;
                            }
                            continue;
                        }
                        '{' => brace_depth += 1,
                        '}' if brace_depth > 0 => brace_depth -= 1,
                        '}' => {}
                        _ => {}
                    }
                    index.push(chars.next().unwrap());
                }
                // Strip surrounding quotes from index (e.g. "foo" -> foo)
                if index.len() >= 2
                    && ((index.starts_with('"') && index.ends_with('"'))
                        || (index.starts_with('\'') && index.ends_with('\'')))
                {
                    index = index[1..index.len() - 1].to_string();
                }
                // After ], check for operators on array subscripts
                if let Some(&next_c) = chars.peek() {
                    if next_c == ':' {
                        // Peek ahead to distinguish param ops (:- := :+ :?) from slice (:N)
                        let mut lookahead = chars.clone();
                        lookahead.next(); // skip ':'
                        let is_param_op = matches!(
                            lookahead.peek(),
                            Some(&'-') | Some(&'=') | Some(&'+') | Some(&'?')
                        );
                        if is_param_op {
                            chars.next(); // consume ':'
                            let arr_name = format!("{}[{}]", var_name, index);
                            let op_char = chars.next().unwrap();
                            let operand =
                                self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                            let operator = match op_char {
                                '-' => ParameterOp::UseDefault,
                                '=' => ParameterOp::AssignDefault,
                                '+' => ParameterOp::UseReplacement,
                                '?' => ParameterOp::Error,
                                _ => unreachable!(),
                            };
                            push_part!(WordPart::ParameterExpansion {
                                name: arr_name,
                                operator,
                                operand,
                                colon_variant: true,
                            });
                        } else {
                            // Array slice ${arr[@]:offset:length}
                            chars.next(); // consume ':'
                            let offset = read_slice_field(chars, true);
                            let length = if chars.peek() == Some(&':') {
                                chars.next();
                                Some(read_slice_field(chars, false))
                            } else {
                                None
                            };
                            if chars.peek() == Some(&'}') {
                                chars.next();
                            }
                            // `${a[@]:}`: an empty offset is a
                            // bad substitution (bash).
                            if offset.is_empty() && length.is_none() {
                                push_part!(WordPart::BadSubstitution(format!(
                                    "${{{}[{index}]:}}",
                                    std::mem::take(&mut var_name)
                                )));
                            } else {
                                // `${a[@]:o:l}` slices the elements,
                                // `${a[1]:o:l}` the element's text.
                                push_part!(WordPart::Substring {
                                    name: format!("{}[{}]", std::mem::take(&mut var_name), index),
                                    offset,
                                    length,
                                });
                            }
                        }
                    } else if matches!(next_c, '-' | '+' | '=' | '?') {
                        // Non-colon operators on array: ${arr[@]-default}
                        let arr_name = format!("{}[{}]", var_name, index);
                        let op_char = chars.next().unwrap();
                        let operand =
                            self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                        let operator = match op_char {
                            '-' => ParameterOp::UseDefault,
                            '=' => ParameterOp::AssignDefault,
                            '+' => ParameterOp::UseReplacement,
                            '?' => ParameterOp::Error,
                            _ => unreachable!(),
                        };
                        push_part!(WordPart::ParameterExpansion {
                            name: arr_name,
                            operator,
                            operand,
                            colon_variant: false,
                        });
                    } else if matches!(next_c, '#' | '%' | '/' | '^' | ',' | '~' | '@') {
                        var_name = format!("{}[{}]", var_name, index);
                        subscript_op = true;
                    } else {
                        // Plain array access ${arr[index]}
                        if chars.peek() == Some(&'}') {
                            chars.next();
                        }
                        push_part!(WordPart::ArrayAccess {
                            name: std::mem::take(&mut var_name),
                            index,
                        });
                    }
                } else {
                    push_part!(WordPart::ArrayAccess {
                        name: std::mem::take(&mut var_name),
                        index,
                    });
                }
            }
            if (!had_subscript || subscript_op)
                && let Some(&c) = chars.peek()
            {
                // Check for operator
                match c {
                    ':' => {
                        chars.next(); // consume ':'
                        match chars.peek() {
                            Some(&'-') | Some(&'=') | Some(&'+') | Some(&'?') => {
                                let op_char = chars.next().unwrap();
                                let operand = self.read_brace_operand(
                                    chars,
                                    in_quoted_segment,
                                    pattern_context,
                                );
                                let operator = match op_char {
                                    '-' => ParameterOp::UseDefault,
                                    '=' => ParameterOp::AssignDefault,
                                    '+' => ParameterOp::UseReplacement,
                                    '?' => ParameterOp::Error,
                                    _ => unreachable!(),
                                };
                                push_part!(WordPart::ParameterExpansion {
                                    name: var_name,
                                    operator,
                                    operand,
                                    colon_variant: true,
                                });
                            }
                            _ => {
                                // Substring extraction ${var:offset} or ${var:offset:length}
                                let offset = read_slice_field(chars, true);
                                let length = if chars.peek() == Some(&':') {
                                    chars.next(); // consume ':'
                                    Some(read_slice_field(chars, false))
                                } else {
                                    None
                                };
                                if chars.peek() == Some(&'}') {
                                    chars.next();
                                }
                                if offset.is_empty() && length.is_none() {
                                    push_part!(WordPart::BadSubstitution(format!(
                                        "${{{var_name}:}}"
                                    )));
                                } else {
                                    push_part!(WordPart::Substring {
                                        name: var_name,
                                        offset,
                                        length,
                                    });
                                }
                            }
                        }
                    }
                    // Non-colon test operators: ${var-default}, ${var+alt}, ${var=assign}, ${var?err}
                    '-' | '=' | '+' | '?' => {
                        let op_char = chars.next().unwrap();
                        let operand =
                            self.read_brace_operand(chars, in_quoted_segment, pattern_context);
                        let operator = match op_char {
                            '-' => ParameterOp::UseDefault,
                            '=' => ParameterOp::AssignDefault,
                            '+' => ParameterOp::UseReplacement,
                            '?' => ParameterOp::Error,
                            _ => unreachable!(),
                        };
                        push_part!(WordPart::ParameterExpansion {
                            name: var_name,
                            operator,
                            operand,
                            colon_variant: false,
                        });
                    }
                    '#' => {
                        chars.next();
                        if chars.peek() == Some(&'#') {
                            chars.next();
                            let op = self.read_brace_operand(chars, in_quoted_segment, true);
                            push_part!(WordPart::ParameterExpansion {
                                name: var_name,
                                operator: ParameterOp::RemovePrefixLong,
                                operand: op,
                                colon_variant: false,
                            });
                        } else {
                            let op = self.read_brace_operand(chars, in_quoted_segment, true);
                            push_part!(WordPart::ParameterExpansion {
                                name: var_name,
                                operator: ParameterOp::RemovePrefixShort,
                                operand: op,
                                colon_variant: false,
                            });
                        }
                    }
                    '%' => {
                        chars.next();
                        if chars.peek() == Some(&'%') {
                            chars.next();
                            let op = self.read_brace_operand(chars, in_quoted_segment, true);
                            push_part!(WordPart::ParameterExpansion {
                                name: var_name,
                                operator: ParameterOp::RemoveSuffixLong,
                                operand: op,
                                colon_variant: false,
                            });
                        } else {
                            let op = self.read_brace_operand(chars, in_quoted_segment, true);
                            push_part!(WordPart::ParameterExpansion {
                                name: var_name,
                                operator: ParameterOp::RemoveSuffixShort,
                                operand: op,
                                colon_variant: false,
                            });
                        }
                    }
                    '/' => {
                        chars.next();
                        let replace_all = if chars.peek() == Some(&'/') {
                            chars.next();
                            true
                        } else {
                            false
                        };
                        let slash_pattern = replace_all && chars.peek() == Some(&'/');
                        if slash_pattern {
                            chars.next();
                        }
                        let mut pattern = self.read_replace_operand(chars, true, in_quoted_segment);
                        if slash_pattern {
                            pattern.insert(0, '/');
                        }
                        let replacement = if chars.peek() == Some(&'/') {
                            chars.next();
                            self.read_replace_operand(chars, false, in_quoted_segment)
                        } else {
                            String::new()
                        };
                        if chars.peek() == Some(&'}') {
                            chars.next();
                        }
                        let op = if replace_all {
                            ParameterOp::ReplaceAll {
                                pattern,
                                replacement,
                            }
                        } else {
                            ParameterOp::ReplaceFirst {
                                pattern,
                                replacement,
                            }
                        };
                        push_part!(WordPart::ParameterExpansion {
                            name: var_name,
                            operator: op,
                            operand: String::new(),
                            colon_variant: false,
                        });
                    }
                    '^' => {
                        chars.next();
                        let op = if chars.peek() == Some(&'^') {
                            chars.next();
                            ParameterOp::UpperAll
                        } else {
                            ParameterOp::UpperFirst
                        };
                        // `${v^^pat}`: only characters matching `pat`.
                        let operand = self.read_brace_operand(chars, in_quoted_segment, true);
                        push_part!(WordPart::ParameterExpansion {
                            name: var_name,
                            operator: op,
                            operand,
                            colon_variant: false,
                        });
                    }
                    '~' => {
                        // `${v~}` / `${v~~}`: toggle case (undocumented
                        // in the bash manual, supported by bash 4+).
                        chars.next();
                        let op = if chars.peek() == Some(&'~') {
                            chars.next();
                            ParameterOp::ToggleAll
                        } else {
                            ParameterOp::ToggleFirst
                        };
                        let operand = self.read_brace_operand(chars, in_quoted_segment, true);
                        push_part!(WordPart::ParameterExpansion {
                            name: var_name,
                            operator: op,
                            operand,
                            colon_variant: false,
                        });
                    }
                    ',' => {
                        chars.next();
                        let op = if chars.peek() == Some(&',') {
                            chars.next();
                            ParameterOp::LowerAll
                        } else {
                            ParameterOp::LowerFirst
                        };
                        // `${v^^pat}`: only characters matching `pat`.
                        let operand = self.read_brace_operand(chars, in_quoted_segment, true);
                        push_part!(WordPart::ParameterExpansion {
                            name: var_name,
                            operator: op,
                            operand,
                            colon_variant: false,
                        });
                    }
                    '@' => {
                        chars.next();
                        if let Some(&op) = chars.peek() {
                            chars.next();
                            if chars.peek() == Some(&'}') {
                                chars.next();
                            }
                            push_part!(WordPart::Transformation {
                                name: var_name,
                                operator: op,
                            });
                        } else {
                            if chars.peek() == Some(&'}') {
                                chars.next();
                            }
                            push_part!(WordPart::Variable(var_name));
                        }
                    }
                    '}' => {
                        chars.next();
                        if !var_name.is_empty() {
                            push_part!(WordPart::Variable(var_name));
                        }
                    }
                    _ => {
                        while let Some(&ch) = chars.peek() {
                            if ch == '}' {
                                chars.next();
                                break;
                            }
                            chars.next();
                        }
                        if !var_name.is_empty() {
                            push_part!(WordPart::Variable(var_name));
                        }
                    }
                }
            } else if !had_subscript && !var_name.is_empty() {
                push_part!(WordPart::Variable(var_name));
            }
        }
    }

    fn parse_word(&self, s: String) -> Word {
        self.parse_word_with_escapes(s, &[])
    }

    fn parse_current_word(&self, s: String) -> Word {
        self.parse_word_with_escapes(s, &self.current_escapes)
    }

    fn parse_word_with_escapes(&self, s: String, escapes: &[LiteralEscape]) -> Word {
        self.parse_word_inner(s, escapes, false)
    }

    // THREAT[TM-DOS-044]: nested `$(...)` bodies parse after the scan loop's
    // large frame has returned, so each substitution level keeps only this
    // small frame and `parse_word_substitutions` on the recursive path.
    fn parse_word_inner(&self, s: String, escapes: &[LiteralEscape], preserve_empty: bool) -> Word {
        let mut scanned = self.scan_word_parts(&s, escapes);
        drop(s);
        if !scanned.pending.is_empty() {
            self.parse_word_substitutions(&mut scanned);
        }
        finish_scanned_word(scanned, preserve_empty)
    }

    /// One pass over the word's characters. Command substitution bodies are
    /// recorded in `pending` with placeholder parts, not parsed here.
    #[inline(never)]
    fn scan_word_parts(&self, s: &str, escapes: &[LiteralEscape]) -> Box<ScannedWord> {
        let mut pending: Vec<PendingSubstitution> = Vec::new();
        let mut parts = Vec::new();
        let mut part_quoted = Vec::new();
        let mut chars = WordChars::new(s, escapes);
        let mut current = String::new();
        let mut in_quoted_segment = false;
        // Parts count when the current quoted segment opened, to spot `""`.
        let mut segment_start = 0usize;
        let mut has_empty_quoted = false;
        let mut saw_quote_marker = false;
        macro_rules! push_part {
            ($part:expr) => {{
                parts.push($part);
                part_quoted.push(in_quoted_segment);
            }};
        }

        while let Some(ch) = chars.next() {
            if chars.literal() {
                if !current.is_empty() {
                    push_part!(WordPart::Literal(std::mem::take(&mut current)));
                }
                parts.push(WordPart::Literal(ch.to_string()));
                part_quoted.push(true);
                saw_quote_marker = true;
            } else if ch == '\x00' {
                // NUL sentinel from lexer: next char is a literal (escaped in source).
                if let Some(literal_ch) = chars.next() {
                    if literal_ch == '~'
                        && !in_quoted_segment
                        && (current.is_empty() || current.ends_with([':', '=']))
                    {
                        // `\~` where a tilde prefix could start: a quoted
                        // part, so it never tilde-expands.
                        if !current.is_empty() {
                            push_part!(WordPart::Literal(std::mem::take(&mut current)));
                        }
                        parts.push(WordPart::Literal("~".to_string()));
                        part_quoted.push(true);
                    } else {
                        current.push(literal_ch);
                    }
                }
            } else if ch == '\u{1e}' || ch == '\u{1f}' {
                // A quote boundary ends the literal run, so `part_quoted`
                // records which literal text was quoted (brace expansion
                // only sees unquoted literals).
                let quoted = ch == '\u{1e}';
                saw_quote_marker = true;
                if quoted != in_quoted_segment && !current.is_empty() {
                    push_part!(WordPart::Literal(std::mem::take(&mut current)));
                } else if !quoted && in_quoted_segment && parts.len() == segment_start {
                    // An empty quoted segment (`$x""`): keep it as an empty
                    // quoted part so field splitting can still make a field.
                    push_part!(WordPart::Literal(String::new()));
                    has_empty_quoted = true;
                }
                if quoted && !in_quoted_segment {
                    segment_start = parts.len();
                }
                in_quoted_segment = quoted;
            } else if ch == '$' {
                // Flush current literal
                if !current.is_empty() {
                    push_part!(WordPart::Literal(std::mem::take(&mut current)));
                }

                // Check for $'...' - ANSI-C quoting
                if chars.peek() == Some(&'\'') {
                    chars.next(); // consume opening '
                    let mut ansi = String::new();
                    while let Some(c) = chars.next() {
                        if c == '\'' {
                            break;
                        }
                        if c == '\\' {
                            if let Some(esc) = chars.next() {
                                match esc {
                                    'n' => ansi.push('\n'),
                                    't' => ansi.push('\t'),
                                    'r' => ansi.push('\r'),
                                    'a' => ansi.push('\x07'),
                                    'b' => ansi.push('\x08'),
                                    'e' | 'E' => ansi.push('\x1B'),
                                    '\\' => ansi.push('\\'),
                                    '\'' => ansi.push('\''),
                                    _ => {
                                        ansi.push('\\');
                                        ansi.push(esc);
                                    }
                                }
                            }
                        } else {
                            ansi.push(c);
                        }
                    }
                    push_part!(WordPart::Literal(ansi));
                } else if chars.peek() == Some(&'(') {
                    // Check for $( - command substitution or arithmetic
                    chars.next(); // consume first '('

                    match self.read_word_substitution(&mut chars) {
                        Ok(WordSubstitution::Arithmetic { expression, nested }) => {
                            self.check_nested_bodies(&mut pending, nested);
                            push_part!(WordPart::ArithmeticExpansion(expression));
                        }
                        Ok(WordSubstitution::Command {
                            body,
                            fused,
                            nested,
                        }) => {
                            self.check_nested_bodies(&mut pending, nested);
                            // A failed inner parse must never make the part
                            // vanish: dropping it splices the literals on
                            // either side into a word that appears nowhere in
                            // the source (`a$(|)b` -> `ab`), which `analysis`
                            // would report to a host permission gate as a real
                            // command name. The placeholder keeps the word
                            // non-literal until `parse_word_substitutions`.
                            pending.push(PendingSubstitution {
                                index: Some(parts.len()),
                                body,
                                fused,
                                first_error: !self.has_deferred_error(),
                            });
                            push_part!(WordPart::CommandSubstitution(Vec::new()));
                        }
                        Err(err) => {
                            push_part!(WordPart::CommandSubstitution(Vec::new()));
                            let first = self.deferred_error.take();
                            self.deferred_error.set(first.or(Some(err)));
                        }
                    }
                } else if chars.peek() == Some(&'{') {
                    let mut operand_bodies = Vec::new();
                    self.parse_braced_parameter(
                        &mut chars,
                        &mut parts,
                        &mut part_quoted,
                        in_quoted_segment,
                        false,
                        &mut operand_bodies,
                    );
                    self.check_nested_bodies(&mut pending, operand_bodies);
                } else if let Some(&c) = chars.peek() {
                    // Check for special single-character variables ($?, $#, $@, $*, $!, $$, $-, $0-$9)
                    if matches!(c, '?' | '#' | '@' | '*' | '!' | '$' | '-') || c.is_ascii_digit() {
                        push_part!(WordPart::Variable(chars.next().unwrap().to_string()));
                    } else {
                        // $VAR format
                        let mut var_name = String::new();
                        while let Some(&c) = chars.peek() {
                            if c.is_ascii_alphanumeric() || c == '_' {
                                var_name.push(chars.next().unwrap());
                            } else {
                                break;
                            }
                        }
                        if !var_name.is_empty() {
                            push_part!(WordPart::Variable(var_name));
                        } else {
                            // Just a literal $
                            current.push('$');
                        }
                    }
                } else {
                    // Just a literal $ at end
                    current.push('$');
                }
            } else {
                current.push(ch);
            }
        }

        // Flush remaining literal
        if !current.is_empty() {
            push_part!(WordPart::Literal(current));
        }

        Box::new(ScannedWord {
            parts,
            part_quoted,
            has_empty_quoted,
            saw_quote_marker,
            in_quoted_segment,
            pending,
        })
    }

    /// Queue syntax checks for command bodies bash parses with the script
    /// but that this word keeps as text (operands and raw `$((` spans).
    #[inline(never)]
    fn check_nested_bodies(&self, pending: &mut Vec<PendingSubstitution>, bodies: Vec<String>) {
        for body in bodies {
            pending.push(PendingSubstitution {
                index: None,
                body,
                fused: false,
                first_error: !self.has_deferred_error(),
            });
        }
    }

    fn has_deferred_error(&self) -> bool {
        let first = self.deferred_error.take();
        let present = first.is_some();
        self.deferred_error.set(first);
        present
    }

    /// Parse the recorded `$(...)` bodies in source order. Keep this frame
    /// small: it is the word-level link of every nested substitution parse.
    #[inline(never)]
    fn parse_word_substitutions(&self, scanned: &mut ScannedWord) {
        let mut replaced_later_error = false;
        for pending in std::mem::take(&mut scanned.pending) {
            let result = match pending.index {
                Some(_) => self.parse_substitution_body(&pending.body).map(Some),
                None => self.validate_parameter_command(&pending.body).map(|()| None),
            };
            self.place_substitution(scanned, pending, result, &mut replaced_later_error);
        }
    }

    #[inline(never)]
    fn parse_substitution_body(&self, body: &str) -> Result<Script> {
        self.nested_parser(body)?.parse_inner()
    }

    #[inline(never)]
    fn place_substitution(
        &self,
        scanned: &mut ScannedWord,
        pending: PendingSubstitution,
        result: Result<Option<Script>>,
        replaced_later_error: &mut bool,
    ) {
        let line = self.current_span.start.line;
        let part = match result {
            Ok(None) => return,
            Ok(Some(script)) => WordPart::CommandSubstitution(script.commands),
            Err(err) => match substitution_error(pending.body, pending.fused, err, line) {
                Ok(part) => part,
                Err(err) => {
                    // Keep the first error in source order. Errors the scan
                    // loop recorded after this body came later in the source.
                    let first = self.deferred_error.take();
                    let keep = first.filter(|_| *replaced_later_error || !pending.first_error);
                    *replaced_later_error |= keep.is_none();
                    self.deferred_error.set(keep.or(Some(err)));
                    return;
                }
            },
        };
        if let Some(index) = pending.index {
            scanned.parts[index] = part;
        }
    }

    /// Both direct replacement parsing and lazy scalar reparsing consume the
    /// same quote/operator state machine as the lexer and engine token scanner.
    fn read_replace_operand(
        &self,
        chars: &mut WordChars<'_>,
        pattern: bool,
        outer_quoted: bool,
    ) -> String {
        self.read_parameter_operand(chars, outer_quoted, true, pattern, false)
    }

    fn read_brace_operand(
        &self,
        chars: &mut WordChars<'_>,
        outer_quoted: bool,
        pattern: bool,
    ) -> String {
        self.read_parameter_operand(chars, outer_quoted, pattern, false, true)
    }

    fn read_parameter_operand(
        &self,
        chars: &mut WordChars<'_>,
        outer_quoted: bool,
        pattern: bool,
        slash_delimiter: bool,
        consume_close: bool,
    ) -> String {
        use parameter_scan::{ParameterScan, Step};
        let mut scanner = ParameterScan::<HARD_MAX_AST_DEPTH>::operand(
            outer_quoted,
            pattern,
            slash_delimiter,
            self.max_depth,
        );
        let mut out = String::new();
        // Bash parses an unquoted `<(`/`>(` in a `${...}` operand at parse
        // time and keeps its printed form (`parse_comsub`, `print_comsub`).
        let mut angle = false;
        while let Some(&ch) = chars.peek() {
            if angle && ch == '(' && scanner.unquoted() {
                angle = false;
                out.extend(chars.next());
                self.copy_process_substitution(chars, &mut out);
                continue;
            }
            angle = matches!(ch, '<' | '>') && !angle && scanner.unquoted();
            let mut lookahead = chars.clone();
            lookahead.next();
            match scanner.feed(ch, lookahead.peek().copied()) {
                Step::Delimiter => break,
                Step::Closed => {
                    if consume_close {
                        chars.next();
                    }
                    break;
                }
                Step::Limit => {
                    let first = self.deferred_error.take();
                    self.deferred_error
                        .set(first.or(Some(self.limit_error(LimitExceeded::ParameterDepth))));
                    break;
                }
                step => {
                    out.extend(chars.next());
                    match step {
                        Step::Escape | Step::Open => out.extend(chars.next()),
                        Step::Command => {
                            out.extend(chars.next());
                            self.copy_replace_substitution(chars, &mut out);
                        }
                        _ => {}
                    }
                }
            }
        }
        out
    }

    /// Read a `$(...)` span after its `$(` and classify it. Boundary state and
    /// extraction temporaries stay off the recursive grammar frames.
    #[inline(never)]
    fn read_word_substitution(&self, chars: &mut WordChars<'_>) -> Result<WordSubstitution> {
        let mut scanner = subst_scan::SubstScanner::new();
        let (end, closed) = self.scan_word_substitution(&mut scanner, chars)?;
        let mut body = String::new();
        let mut consumed = 0;
        while consumed < end {
            let Some(c) = chars.next() else {
                break;
            };
            consumed += c.len_utf8();
            if !closed || consumed < end {
                body.push(c);
            }
        }
        // An unterminated span keeps its eager command parse and errors.
        let fused = closed.then(|| scanner.arithmetic_start()).flatten();
        let Some(start) = fused else {
            return Ok(WordSubstitution::Command {
                body,
                fused: false,
                nested: Vec::new(),
            });
        };
        // Bash parses the `$(...)` bodies inside raw `$((` text right away.
        let nested = scanner
            .opaque_commands()
            .iter()
            .map(|&(from, to)| body[from..to].to_string())
            .collect();
        if let Some(expression) = subst_scan::arithmetic_expression(&body, start) {
            return Ok(WordSubstitution::Arithmetic {
                expression: expression.to_string(),
                nested,
            });
        }
        Ok(WordSubstitution::Command {
            body,
            fused: true,
            nested,
        })
    }

    fn scan_word_substitution(
        &self,
        scanner: &mut subst_scan::SubstScanner,
        chars: &WordChars<'_>,
    ) -> Result<(usize, bool)> {
        for c in chars.clone() {
            self.tick()?;
            if scanner.feed(c) == subst_scan::Step::Close {
                return Ok((scanner.offset(), true));
            }
        }
        Ok((scanner.offset(), false))
    }

    /// Copy a `<(...)` or `>(...)` body (after its `(`) into operand text the
    /// way bash stores it: the parsed command printed back, with a space
    /// before a leading `(`. A fused `<((` span, an unterminated body or one
    /// that does not parse is copied as written (its error is reported by
    /// the operand's body validation).
    #[inline(never)]
    fn copy_process_substitution(&self, chars: &mut WordChars<'_>, out: &mut String) {
        let mut scanner = subst_scan::SubstScanner::new();
        let (end, closed) = match self.scan_word_substitution(&mut scanner, chars) {
            Ok(found) => found,
            Err(err) => {
                let first = self.deferred_error.take();
                self.deferred_error.set(first.or(Some(err)));
                return;
            }
        };
        let mut body = String::new();
        let mut consumed = 0;
        while consumed < end {
            let Some(c) = chars.next() else {
                break;
            };
            consumed += c.len_utf8();
            body.push(c);
        }
        if !closed || scanner.arithmetic_start().is_some() {
            out.push_str(&body);
            return;
        }
        body.pop();
        match self.parse_substitution_body(&body) {
            Ok(script) => {
                let printed = print_cmd::inline_commands(&script.commands);
                if printed.starts_with('(') {
                    out.push(' ');
                }
                out.push_str(&printed);
            }
            Err(_) => out.push_str(&body),
        }
        out.push(')');
    }

    fn copy_replace_substitution(&self, chars: &mut WordChars<'_>, out: &mut String) {
        let mut scanner = subst_scan::SubstScanner::new();
        match self.scan_word_substitution(&mut scanner, chars) {
            Ok((end, _)) => {
                let mut consumed = 0;
                while consumed < end {
                    let Some(c) = chars.next() else {
                        break;
                    };
                    consumed += c.len_utf8();
                    out.push(c);
                }
            }
            Err(err) => {
                let first = self.deferred_error.take();
                self.deferred_error.set(first.or(Some(err)));
            }
        }
    }
}

/// The pieces of `name[index]=value` before its value is parsed.
struct AssignmentSource {
    name: String,
    index: Option<String>,
    value: String,
    escapes: Vec<LiteralEscape>,
    raw: Option<String>,
    append: bool,
}

impl AssignmentSource {
    /// `name=(...)` written as one word, its parentheses unescaped.
    fn is_array_literal(&self) -> bool {
        self.value.starts_with('(')
            && self.value.ends_with(')')
            && !self
                .escapes
                .iter()
                .any(|escape| escape.start == 0 || escape.end == self.value.len())
    }
}

// The box keeps this value out of the recursive caller's frame.
#[allow(clippy::boxed_local)]
#[inline(never)]
fn finish_assignment(
    source: Box<AssignmentSource>,
    value: AssignmentValue,
    advanced: bool,
) -> (Assignment, bool) {
    let AssignmentSource {
        name,
        index,
        append,
        ..
    } = *source;
    (
        Assignment {
            name,
            index,
            value,
            append,
        },
        advanced,
    )
}

/// A word's parts before its nested command substitutions are parsed.
struct ScannedWord {
    parts: Vec<WordPart>,
    part_quoted: Vec<bool>,
    has_empty_quoted: bool,
    saw_quote_marker: bool,
    in_quoted_segment: bool,
    pending: Vec<PendingSubstitution>,
}

/// A `$(...)` body waiting for its nested parse, and its placeholder part.
struct PendingSubstitution {
    /// The placeholder part, or `None` for a `${...}` operand body: bash
    /// parses it now, but it expands from the operand text, so only its
    /// syntax is checked.
    index: Option<usize>,
    body: String,
    /// Opened as `$((` but is not arithmetic: bash parses it on expansion.
    fused: bool,
    /// No earlier error in source order was recorded when it was scanned.
    first_error: bool,
}

enum WordSubstitution {
    Arithmetic {
        expression: String,
        /// Command bodies inside the raw text, checked like operand bodies.
        nested: Vec<String>,
    },
    Command {
        body: String,
        fused: bool,
        nested: Vec<String>,
    },
}

// The box keeps this value out of the recursive caller's frame.
#[allow(clippy::boxed_local)]
#[inline(never)]
fn finish_scanned_word(scanned: Box<ScannedWord>, preserve_empty: bool) -> Word {
    let ScannedWord {
        parts,
        part_quoted,
        has_empty_quoted,
        saw_quote_marker,
        in_quoted_segment,
        pending: _,
    } = *scanned;
    finish_word(
        parts,
        part_quoted,
        has_empty_quoted,
        preserve_empty,
        saw_quote_marker,
        in_quoted_segment,
    )
}

/// Bash parses a non-arithmetic `$((` span only when it expands, so its
/// syntax error belongs to that expansion. Any other command substitution
/// body is parsed with the script: its syntax error ends the shell with
/// status 127 (`parse_comsub`), after the lines before it ran. Resource
/// limits keep their own error.
#[inline(never)]
fn substitution_error(body: String, fused: bool, err: Error, line: usize) -> Result<WordPart> {
    match err {
        Error::ResourceLimit(_) => Err(err),
        Error::Parse { message, .. } if fused => Ok(WordPart::UnparsedCommandSubstitution {
            source: body,
            error: message,
        }),
        Error::ShellWord { line } if fused => Ok(WordPart::UnparsedCommandSubstitution {
            source: body,
            error: format!("syntax error while looking for matching `)' at line {line}"),
        }),
        Error::Parse { .. } | Error::ShellWord { .. } => Err(Error::ShellWord { line }),
    }
}

/// `a |& b` is `a 2>&1 | b`: append the dup to `a`. Out of line to keep
/// the recursive `parse_pipeline` frame small (TM-DOS-044).
#[inline(never)]
fn add_stderr_to_pipe(cmd: &mut Command) {
    let dup = Redirect {
        expansion_line: None,
        fd: Some(2),
        fd_var: None,
        kind: RedirectKind::DupOutput,
        target: Word::literal("1"),
        heredoc_delim: None,
    };
    match cmd {
        Command::Simple(sc) => sc.redirects.push(dup),
        Command::Compound(_, redirects) => redirects.push(dup),
        _ => {}
    }
}

// AST assembly runs after recursive parsing returns, keeping its temporaries
// off the recursive grammar frames (TM-DOS-044).
#[inline(never)]
fn finish_command_list(
    first: Option<Box<Command>>,
    rest: Vec<(ListOperator, Command)>,
    span: Span,
) -> Result<Option<Box<Command>>> {
    let Some(first) = first else {
        return Ok(None);
    };
    if rest.is_empty() {
        Ok(Some(first))
    } else {
        Ok(Some(Box::new(Command::List(CommandList {
            first,
            rest,
            span,
        }))))
    }
}

#[inline(never)]
fn finish_pipeline(
    commands: Vec<Command>,
    negated: bool,
    span: Span,
) -> Result<Option<Box<Command>>> {
    Ok(Some(Box::new(Command::Pipeline(Pipeline {
        negated,
        commands,
        span,
    }))))
}

#[inline(never)]
fn finish_word(
    mut parts: Vec<WordPart>,
    mut part_quoted: Vec<bool>,
    has_empty_quoted: bool,
    preserve_empty: bool,
    saw_quote_marker: bool,
    in_quoted_segment: bool,
) -> Word {
    // Empty quoted parts only matter next to an unquoted expansion
    // (`""$x""` keeps empty fields) or a quoted `@` expansion (`"$@"""`
    // is one empty field when there are no positional parameters);
    // elsewhere drop them so the word keeps its plain shape.
    if has_empty_quoted && !preserve_empty {
        let unquoted_expansion = parts
            .iter()
            .zip(&part_quoted)
            .any(|(p, q)| !*q && !matches!(p, WordPart::Literal(_)));
        let quoted_at = parts.iter().zip(&part_quoted).any(|(p, q)| {
            *q && match p {
                WordPart::Variable(name) => name == "@",
                WordPart::ArrayAccess { index, .. } => index == "@",
                WordPart::ParameterExpansion { name, .. }
                | WordPart::Transformation { name, .. }
                | WordPart::Substring { name, .. } => name == "@" || name.ends_with("[@]"),
                _ => false,
            }
        });
        // `{X,,Y,}''`: brace items next to the empty quotes are words
        // even when empty.
        let brace_candidate = parts
            .iter()
            .zip(&part_quoted)
            .any(|(p, q)| !*q && matches!(p, WordPart::Literal(t) if t.contains('{')));
        if !unquoted_expansion && !quoted_at && !brace_candidate {
            let mut kept_parts = Vec::with_capacity(parts.len());
            let mut kept_quoted = Vec::with_capacity(parts.len());
            for (p, q) in parts.into_iter().zip(part_quoted) {
                if !matches!(&p, WordPart::Literal(s) if s.is_empty()) {
                    kept_parts.push(p);
                    kept_quoted.push(q);
                }
            }
            parts = kept_parts;
            part_quoted = kept_quoted;
        }
    }

    // If no parts, create an empty literal
    if parts.is_empty() {
        parts.push(WordPart::Literal(String::new()));
        part_quoted.push(in_quoted_segment);
    }

    // Every part quoted (`'a'"$x"`, `"$x"""`): the word is quoted, so its
    // expansions are not field-split.
    let quoted = saw_quote_marker && part_quoted.iter().all(|q| *q);
    Word {
        parts,
        quoted,
        has_unquoted_glob: false,
        part_quoted,
        raw: None,
    }
}

// AST assembly runs after recursive parsing returns, keeping its temporaries
// off the recursive grammar frames (TM-DOS-044).
#[inline(never)]
fn finish_simple_command(
    mut words: Vec<Word>,
    assignments: Vec<Assignment>,
    redirects: Vec<Redirect>,
    span: Span,
    expansion_line: Option<usize>,
) -> Result<Option<SimpleCommand>> {
    // Handle assignment-only and redirect-only commands (`VAR=value`,
    // `< file`, `> file`): bash runs them as null commands that still
    // perform their assignments/redirections (#2448: `$(<file)`).
    if words.is_empty() && (!assignments.is_empty() || !redirects.is_empty()) {
        return Ok(Some(SimpleCommand {
            expansion_line,
            name: Word::literal(""),
            args: Vec::new(),
            redirects,
            assignments,
            span,
        }));
    }

    if words.is_empty() {
        return Ok(None);
    }

    let name = words.remove(0);
    let args = words;

    Ok(Some(SimpleCommand {
        expansion_line,
        name,
        args,
        redirects,
        assignments,
        span,
    }))
}

/// A word token of a simple command, before it is parsed.
struct SimpleWordToken {
    text: String,
    is_literal: bool,
    is_quoted: bool,
    is_glob_quoted: bool,
}

/// A declaration builtin, `let` or `eval` named directly as the command.
fn is_declaration_command(words: &[Word]) -> bool {
    words.first().is_some_and(|w0| {
        !w0.quoted
            && matches!(w0.parts.as_slice(), [WordPart::Literal(n)]
                if matches!(n.as_str(), "declare" | "typeset" | "local" | "export" | "readonly" | "let" | "eval"))
    })
}

/// A simple command while its words, assignments and redirects are read.
struct SimpleParts {
    start_span: Span,
    expansion_line: Option<usize>,
    assignments: Vec<Assignment>,
    words: Vec<Word>,
    redirects: Vec<Redirect>,
    /// End of the previous word, while the next token could join it.
    join_end: usize,
}

enum SimpleStep {
    /// A word token: parse it as an assignment or word.
    Word,
    /// The token joined the previous word.
    Joined,
    /// A redirect or other token was consumed.
    Other,
    /// The simple command ends before this token.
    Done,
}

/// What the current token starts, decided before any recursive parse.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandStart {
    Simple,
    If,
    For,
    While,
    Until,
    Case,
    Select,
    Time,
    Coproc,
    FunctionKeyword,
    FunctionPosix,
    Conditional,
    Arithmetic,
    Subshell,
    BraceGroup,
}

#[inline(never)]
fn box_simple_command(simple: Option<SimpleCommand>) -> Option<Box<Command>> {
    simple.map(|cmd| Box::new(Command::Simple(cmd)))
}

#[inline(never)]
fn pipeline_commands(first: Option<Box<Command>>) -> Vec<Command> {
    first.into_iter().map(|cmd| *cmd).collect()
}

#[inline(never)]
fn push_pipeline_command(commands: &mut Vec<Command>, cmd: Box<Command>) {
    commands.push(*cmd);
}

#[inline(never)]
fn push_list_command(rest: &mut Vec<(ListOperator, Command)>, op: ListOperator, cmd: Box<Command>) {
    rest.push((op, *cmd));
}

/// `cmd &` followed by nothing still records the empty background job.
#[inline(never)]
fn end_list_without_command(rest: &mut Vec<(ListOperator, Command)>, op: ListOperator, span: Span) {
    if matches!(op, ListOperator::Background) {
        rest.push(empty_background(span));
    }
}

/// `cmd &` before a closing keyword: an empty command carrying the `&`.
/// Keep its `Command` temporary off the recursive list frame (TM-DOS-044).
#[inline(never)]
fn empty_background(span: Span) -> (ListOperator, Command) {
    let expansion_line = Some(span.end.line);
    (
        ListOperator::Background,
        Command::Simple(SimpleCommand {
            expansion_line,
            name: Word::literal(""),
            args: vec![],
            redirects: vec![],
            assignments: vec![],
            span,
        }),
    )
}

/// Whether a raw `=~` operand holds an expansion. A `$` that cannot start
/// one (`^a$`, `(x$|y$)`) is the regex end anchor; single quotes hide both.
/// Text inside `${...}` when bash would reject it with "bad substitution"
/// at expansion time (`${x!}`, `${}`, `${#x:2}`, `${ x}`), else `None`.
///
/// `chars` is positioned just after the `{`. Only the parameter part is
/// checked: a valid name (identifier, digits or one special character, with
/// an optional subscript) must be followed by `}` or an operator. `${!...}`
/// forms and anything involving quote/escape markers are left to the
/// regular parser, so this only ever rejects words bash rejects too.
fn bad_brace_parameter(chars: &WordChars<'_>) -> Option<String> {
    const MARKERS: [char; 3] = ['\x00', '\u{1e}', '\u{1f}'];
    let mut it = chars.clone();
    let length_prefix = match it.peek() {
        Some('!') => return None,
        Some('#') => {
            if hash_param_with_op(chars) {
                return None;
            }
            it.next();
            match it.peek() {
                // `${#}`, `${##}`, `${#-}`, ...: length of a special parameter
                // or `$#` itself; leave these to the regular parser.
                Some(c) if c.is_ascii_alphanumeric() || *c == '_' => true,
                Some('}') | None => return None,
                Some(_) => {
                    let mut tail = it.clone();
                    tail.next();
                    if tail.peek() == Some(&'}') {
                        return None;
                    }
                    true
                }
            }
        }
        _ => false,
    };
    let bad = match it.peek().copied() {
        None => return None,
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            while it
                .peek()
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                it.next();
            }
            if it.peek() == Some(&'[') {
                // Subscript: balanced brackets; unterminated ones are bad.
                let mut depth = 0usize;
                let mut closed = false;
                for c in it.by_ref() {
                    match c {
                        _ if MARKERS.contains(&c) => return None,
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                closed = true;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if !closed {
                    return None;
                }
            }
            next_is_bad(it.peek().copied(), length_prefix)
        }
        Some(c) if c.is_ascii_digit() => {
            while it.peek().is_some_and(char::is_ascii_digit) {
                it.next();
            }
            next_is_bad(it.peek().copied(), length_prefix)
        }
        Some('@' | '*' | '#' | '?' | '-' | '$' | '!') if !length_prefix => {
            it.next();
            next_is_bad(it.peek().copied(), false)
        }
        Some(c) if MARKERS.contains(&c) => return None,
        Some(_) => true,
    };
    if !bad {
        return None;
    }
    // Find the closing brace to report and skip the whole expansion.
    let mut inner = String::new();
    let mut depth = 0usize;
    for c in chars.clone() {
        // `${#1#'x'}` is bad whatever the quoting after the name.
        if !length_prefix && (MARKERS.contains(&c) || c == '\'' || c == '"' || c == '\\') {
            return None;
        }
        match c {
            '{' => depth += 1,
            '}' if depth == 0 => return Some(inner),
            '}' => depth -= 1,
            _ => {}
        }
        inner.push(c);
    }
    None
}

/// `${...}` text shown for a bad substitution, quote markers dropped.
#[inline(never)]
fn bad_substitution_text(inner: &str) -> String {
    let shown: String = inner
        .chars()
        .filter(|c| !matches!(c, '\x00' | '\u{1e}' | '\u{1f}'))
        .collect();
    format!("${{{shown}}}")
}

/// `${!ref@a}`: push the transformation of the variable `ref` names
/// (`suffix` is `@a`). Out of line so `parse_word`'s frame, which recurses
/// per `$(...)` level, holds no extra `WordPart`.
#[inline(never)]
fn push_indirect_transformation(
    parts: &mut Vec<WordPart>,
    part_quoted: &mut Vec<bool>,
    quoted: bool,
    var_name: &str,
    suffix: &str,
) -> bool {
    let Some(op) = suffix.strip_prefix('@') else {
        return false;
    };
    let mut chars = op.chars();
    let Some(c) = chars.next() else {
        return false;
    };
    if chars.next().is_some() || !"QEPAKakuUL".contains(c) || var_name.is_empty() {
        return false;
    }
    parts.push(WordPart::Transformation {
        name: format!("!{var_name}"),
        operator: c,
    });
    part_quoted.push(quoted);
    true
}

/// One field of `${v:offset:length}`: up to a top-level `:` (when
/// `stop_colon`) or `}`. Nested `$((..))`, `${..}` and a ternary's own `:`
/// (`${s: 0 < 1 ? 2 : 0 : 1}`) stay inside the field.
fn read_slice_field(chars: &mut WordChars<'_>, stop_colon: bool) -> String {
    let mut field = String::new();
    let mut depth = 0usize;
    let mut ternary = 0usize;
    let mut quote = None;
    let mut escaped = false;
    while let Some(&c) = chars.peek() {
        if escaped {
            field.push(c);
            chars.next();
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            field.push(c);
            chars.next();
            escaped = true;
            continue;
        }
        if quote == Some(c) {
            quote = None;
            field.push(c);
            chars.next();
            continue;
        }
        if quote.is_some() {
            field.push(c);
            chars.next();
            continue;
        }
        if matches!(c, '\'' | '"') {
            quote = Some(c);
            field.push(c);
            chars.next();
            continue;
        }
        match c {
            '(' | '{' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            '}' if depth == 0 => break,
            '}' => depth -= 1,
            '?' if depth == 0 => ternary += 1,
            ':' if depth == 0 && ternary > 0 => ternary -= 1,
            ':' if depth == 0 && stop_colon => break,
            _ => {}
        }
        field.push(c);
        chars.next();
    }
    field
}

/// `${##pat}` / `${###}`: `$#` followed by a pattern-removal
/// operator, not the length of a parameter (`${##}` alone is `${#'#'}`).
fn hash_param_with_op(chars: &WordChars<'_>) -> bool {
    let mut it = chars.clone();
    it.next(); // '#'
    match it.next() {
        Some(':') => true, // `${#:offset:length}` slices the scalar `$#`.
        Some('#') => !matches!(it.next(), Some('}') | None),
        _ => false,
    }
}

/// After the parameter of `${...}`: whether `next` cannot start an operator.
fn next_is_bad(next: Option<char>, length_prefix: bool) -> bool {
    match next {
        None => false,
        Some('\x00' | '\u{1e}' | '\u{1f}') => false,
        Some('}') => false,
        Some(_) if length_prefix => true,
        Some(':' | '-' | '=' | '+' | '?' | '#' | '%' | '/' | '^' | ',' | '~' | '@') => false,
        Some(_) => true,
    }
}

fn cond_regex_expands(raw: &str) -> bool {
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '\'' => {
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                }
            }
            '`' => return true,
            '$' if chars.peek().is_some_and(|n| {
                n.is_alphanumeric()
                    || matches!(n, '_' | '{' | '(' | '@' | '*' | '#' | '?' | '!' | '-')
            }) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Turn a `=~` operand without expansions into the regex bash compiles:
/// quoted text and backslash-escaped characters match literally, the rest
/// is regex syntax (`^a'.'\.b$` matches `a.` then `.b`).
fn cond_regex_literal(raw: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = raw.chars().collect();
    // Inside a bracket expression bash only removes the quotes: `["a-z"]`
    // is the range `[a-z]`. `bracket_start` is where its members begin.
    let mut in_bracket = false;
    let mut bracket_start = 0usize;
    let literal = |out: &mut String, c: char, in_bracket: bool| {
        if in_bracket {
            if matches!(c, '\\' | '[' | ']') {
                out.push('\\');
            }
            out.push(c);
        } else if c.is_alphanumeric() || c == '_' || c == ' ' {
            out.push(c);
        } else {
            out.push('\\');
            out.push(c);
        }
    };
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '\\' => match chars.get(i) {
                Some(&n) => {
                    i += 1;
                    literal(&mut out, n, in_bracket);
                }
                None => out.push_str("\\\\"),
            },
            '$' if chars.get(i) == Some(&'\'') => {
                let rest: String = chars[i + 1..].iter().collect();
                match Lexer::decode_ansi_c_body(&rest) {
                    Some((text, used)) => {
                        for q in text.chars() {
                            literal(&mut out, q, in_bracket);
                        }
                        i += 1 + rest[..used].chars().count();
                    }
                    None => out.push(c),
                }
            }
            // `$"..."` is a double-quoted string.
            '$' if chars.get(i) == Some(&'"') => {}
            '\'' => {
                while i < chars.len() {
                    let q = chars[i];
                    i += 1;
                    if q == '\'' {
                        break;
                    }
                    literal(&mut out, q, in_bracket);
                }
            }
            '"' => {
                while i < chars.len() {
                    let q = chars[i];
                    i += 1;
                    match q {
                        '"' => break,
                        '\\' => match chars.get(i) {
                            Some(&n @ ('"' | '\\' | '$' | '`')) => {
                                i += 1;
                                literal(&mut out, n, in_bracket);
                            }
                            Some(&n) => {
                                i += 1;
                                literal(&mut out, '\\', in_bracket);
                                literal(&mut out, n, in_bracket);
                            }
                            None => literal(&mut out, '\\', in_bracket),
                        },
                        _ => literal(&mut out, q, in_bracket),
                    }
                }
            }
            '[' if !in_bracket => {
                out.push(c);
                in_bracket = true;
                if chars.get(i) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
                bracket_start = out.len();
            }
            '[' if matches!(chars.get(i), Some(':' | '.' | '=')) => {
                // `[:space:]` inside a bracket: copy through its `:]`.
                let kind = chars[i];
                out.push(c);
                while i < chars.len() {
                    let q = chars[i];
                    i += 1;
                    out.push(q);
                    if q == ']' && out.len() >= 2 && out[..out.len() - 1].ends_with(kind) {
                        break;
                    }
                }
            }
            ']' if in_bracket && out.len() > bracket_start => {
                out.push(c);
                in_bracket = false;
            }
            // A leading `]` or a bare `[` is a member (`[][{}]`); the regex
            // engine wants both escaped.
            '[' | ']' if in_bracket => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Split the text of `for ((init; cond; step))` at top-level `;`.
fn split_arith_for_parts(body: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    for c in body.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    parts.push(cur);
    parts
}

/// Expression text an arithmetic command evaluates: its source with
/// surrounding blanks trimmed and double quotes removed (bash treats
/// `(( ... ))` like `let "..."`).
pub(crate) fn arith_exec_text(raw: &str) -> String {
    raw.trim().chars().filter(|&c| c != '"').collect()
}

/// Backslash handling in an unquoted heredoc body, as in double quotes but
/// without `"`: `\$`, `` \` `` and `\\` become literal characters (NUL
/// sentinel for `parse_word`), `\<newline>` joins lines, and any other
/// backslash is kept. Text inside `$(...)`, `${...}` and `$((...))` is copied
/// for its own parser (only `\<newline>` is removed); backticks become
/// `$(...)`.
fn heredoc_body_escapes(content: &str) -> String {
    if !content.contains(['\\', '`']) && !content.contains("$'") {
        return content.to_string();
    }
    let mut out = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.peek() {
                Some('$' | '`' | '\\') => {
                    out.push('\x00');
                    out.push(chars.next().unwrap_or_default());
                }
                Some('\n') => {
                    chars.next();
                }
                _ => out.push('\\'),
            },
            // `$'...'` is not ANSI-C quoting in a here-document.
            '$' if chars.peek() == Some(&'\'') => {
                out.push('\x00');
                out.push('$');
            }
            '$' if matches!(chars.peek(), Some('(' | '{')) => {
                out.push('$');
                let open = chars.next().unwrap_or_default();
                out.push(open);
                let close = if open == '(' { ')' } else { '}' };
                let mut depth = 1usize;
                while let Some(ch) = chars.next() {
                    if ch == '\\' && chars.peek() == Some(&'\n') {
                        chars.next();
                        continue;
                    }
                    out.push(ch);
                    if ch == '\\' {
                        if let Some(n) = chars.next() {
                            out.push(n);
                        }
                    } else if ch == open {
                        depth += 1;
                    } else if ch == close {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
            }
            // `cmd` is command substitution, as `$(cmd)`; inside it `\``,
            // `\$` and `\\` lose their backslash.
            '`' => {
                out.push_str("$(");
                while let Some(ch) = chars.next() {
                    match ch {
                        '`' => break,
                        '\\' if matches!(chars.peek(), Some('`' | '$' | '\\')) => {
                            out.push(chars.next().unwrap_or_default());
                        }
                        '\\' if chars.peek() == Some(&'\n') => {
                            chars.next();
                        }
                        _ => out.push(ch),
                    }
                }
                out.push(')');
            }
            _ => out.push(c),
        }
    }
    out
}

/// One `[[ ]]` token for [`check_conditional`]: a word (with its text when
/// it is a bare unquoted word that may act as an operator) or an operator
/// token the lexer split off (`&&`, `||`, `(`, `)`, `<`, `>`, other).
enum CondTok {
    Word(Option<String>),
    Op(&'static str),
}

enum ConditionalError {
    Syntax(String),
    Depth,
}

/// bash's `[[ ]]` grammar (parse.y `cond_expr`), checked at parse time so
/// `[[ a $op b ]]`, `[[ -z ]]` or `[[ '(' x ]]` are syntax errors (status
/// 2) as in bash, not runtime tests. Evaluation still runs on the words.
fn check_conditional(toks: &[CondTok]) -> std::result::Result<(), ConditionalError> {
    let mut pos = 0;
    cond_or(toks, &mut pos, 0)?;
    if pos < toks.len() {
        return Err(ConditionalError::Syntax(format!(
            "syntax error in conditional expression: unexpected token `{}'",
            cond_shown(toks.get(pos))
        )));
    }
    Ok(())
}

const COND_UNARY: &[&str] = &[
    "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-n", "-o", "-p", "-r", "-s", "-t", "-u",
    "-v", "-w", "-x", "-z", "-G", "-L", "-N", "-O", "-R", "-S",
];
const COND_BINARY: &[&str] = &[
    "=", "==", "!=", "=~", "-nt", "-ot", "-ef", "-eq", "-ne", "-lt", "-le", "-gt", "-ge",
];
/// THREAT[TM-DOS-044]: bound recursion on `(((...` / `! ! ! ...`.
const COND_MAX_DEPTH: usize = 256;

fn cond_shown(tok: Option<&CondTok>) -> String {
    match tok {
        None => "]]".to_string(),
        Some(CondTok::Op(op)) => op.to_string(),
        Some(CondTok::Word(Some(text))) => text.clone(),
        Some(CondTok::Word(None)) => "word".to_string(),
    }
}

fn cond_word_text(tok: Option<&CondTok>) -> Option<&str> {
    match tok {
        Some(CondTok::Word(Some(text))) => Some(text),
        _ => None,
    }
}

fn cond_or(
    t: &[CondTok],
    pos: &mut usize,
    depth: usize,
) -> std::result::Result<(), ConditionalError> {
    if depth > COND_MAX_DEPTH {
        return Err(ConditionalError::Depth);
    }
    cond_and(t, pos, depth)?;
    while matches!(t.get(*pos), Some(CondTok::Op("||"))) {
        *pos += 1;
        cond_and(t, pos, depth)?;
    }
    Ok(())
}

fn cond_and(
    t: &[CondTok],
    pos: &mut usize,
    depth: usize,
) -> std::result::Result<(), ConditionalError> {
    cond_term(t, pos, depth)?;
    while matches!(t.get(*pos), Some(CondTok::Op("&&"))) {
        *pos += 1;
        cond_term(t, pos, depth)?;
    }
    Ok(())
}

fn cond_term(
    t: &[CondTok],
    pos: &mut usize,
    depth: usize,
) -> std::result::Result<(), ConditionalError> {
    if depth > COND_MAX_DEPTH {
        return Err(ConditionalError::Depth);
    }
    match t.get(*pos) {
        None => Err(ConditionalError::Syntax(
            "syntax error in conditional expression".to_string(),
        )),
        Some(CondTok::Op("(")) => {
            *pos += 1;
            if matches!(t.get(*pos), Some(CondTok::Op(")"))) {
                return Err(ConditionalError::Syntax(
                    "unexpected token `)' in conditional command".to_string(),
                ));
            }
            cond_or(t, pos, depth + 1)?;
            if !matches!(t.get(*pos), Some(CondTok::Op(")"))) {
                return Err(ConditionalError::Syntax(format!(
                    "unexpected token `{}', expected `)'",
                    cond_shown(t.get(*pos))
                )));
            }
            *pos += 1;
            Ok(())
        }
        Some(CondTok::Word(_)) if cond_word_text(t.get(*pos)) == Some("!") => {
            *pos += 1;
            cond_term(t, pos, depth + 1)
        }
        Some(CondTok::Word(_)) => {
            let first = cond_word_text(t.get(*pos));
            *pos += 1;
            if first.is_some_and(|w| COND_UNARY.contains(&w)) {
                if !matches!(t.get(*pos), Some(CondTok::Word(_))) {
                    return Err(ConditionalError::Syntax(format!(
                        "unexpected argument `{}' to conditional unary operator",
                        cond_shown(t.get(*pos))
                    )));
                }
                *pos += 1;
                return Ok(());
            }
            let binary = match t.get(*pos) {
                Some(CondTok::Op("<" | ">")) => true,
                Some(CondTok::Word(Some(op))) => COND_BINARY.contains(&op.as_str()),
                None | Some(CondTok::Op("&&" | "||" | ")")) => return Ok(()),
                _ => false,
            };
            if !binary {
                return Err(ConditionalError::Syntax(
                    "conditional binary operator expected".to_string(),
                ));
            }
            *pos += 1;
            if !matches!(t.get(*pos), Some(CondTok::Word(_))) {
                return Err(ConditionalError::Syntax(format!(
                    "unexpected argument `{}' to conditional binary operator",
                    cond_shown(t.get(*pos))
                )));
            }
            *pos += 1;
            Ok(())
        }
        Some(CondTok::Op(op)) => Err(ConditionalError::Syntax(format!(
            "unexpected token `{op}' in conditional command"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_parse_simple_command() {
        let parser = Parser::new("echo hello");
        let script = parser.parse().unwrap();

        assert_eq!(script.commands.len(), 1);

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.name.to_string(), "echo");
            assert_eq!(cmd.args.len(), 1);
            assert_eq!(cmd.args[0].to_string(), "hello");
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_timeout_exceeded() {
        let parser =
            Parser::with_limits_and_timeout("echo hello", 100, 100_000, Some(Duration::ZERO));
        let err = parser.parse().expect_err("expected parser timeout");
        assert!(matches!(
            err,
            Error::ResourceLimit(LimitExceeded::ParserTimeout(timeout)) if timeout == Duration::ZERO
        ));
    }

    #[test]
    fn test_parse_multiple_args() {
        let parser = Parser::new("echo hello world");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.name.to_string(), "echo");
            assert_eq!(cmd.args.len(), 2);
            assert_eq!(cmd.args[0].to_string(), "hello");
            assert_eq!(cmd.args[1].to_string(), "world");
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_variable() {
        let parser = Parser::new("echo $HOME");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.args.len(), 1);
            assert_eq!(cmd.args[0].parts.len(), 1);
            assert!(matches!(&cmd.args[0].parts[0], WordPart::Variable(v) if v == "HOME"));
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_pipeline() {
        let parser = Parser::new("echo hello | cat");
        let script = parser.parse().unwrap();

        assert_eq!(script.commands.len(), 1);
        assert!(matches!(&script.commands[0], Command::Pipeline(_)));

        if let Command::Pipeline(pipeline) = &script.commands[0] {
            assert_eq!(pipeline.commands.len(), 2);
        }
    }

    #[test]
    fn test_parse_redirect_out() {
        let parser = Parser::new("echo hello > /tmp/out");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.redirects.len(), 1);
            assert_eq!(cmd.redirects[0].kind, RedirectKind::Output);
            assert_eq!(cmd.redirects[0].target.to_string(), "/tmp/out");
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_redirect_append() {
        let parser = Parser::new("echo hello >> /tmp/out");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.redirects.len(), 1);
            assert_eq!(cmd.redirects[0].kind, RedirectKind::Append);
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_redirect_in() {
        let parser = Parser::new("cat < /tmp/in");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.redirects.len(), 1);
            assert_eq!(cmd.redirects[0].kind, RedirectKind::Input);
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_parse_command_list_and() {
        let parser = Parser::new("true && echo success");
        let script = parser.parse().unwrap();

        assert!(matches!(&script.commands[0], Command::List(_)));
    }

    #[test]
    fn test_parse_command_list_or() {
        let parser = Parser::new("false || echo fallback");
        let script = parser.parse().unwrap();

        assert!(matches!(&script.commands[0], Command::List(_)));
    }

    #[test]
    fn test_heredoc_pipe() {
        let parser = Parser::new("cat <<EOF | sort\nc\na\nb\nEOF\n");
        let script = parser.parse().unwrap();
        assert!(
            matches!(&script.commands[0], Command::Pipeline(_)),
            "heredoc with pipe should parse as Pipeline"
        );
    }

    #[test]
    fn test_heredoc_multiple_on_line() {
        let input = "while cat <<E1 && cat <<E2; do cat <<E3; break; done\n1\nE1\n2\nE2\n3\nE3\n";
        let parser = Parser::new(input);
        let script = parser.parse().unwrap();
        assert_eq!(script.commands.len(), 1);
        if let Command::Compound(comp, _) = &script.commands[0] {
            if let CompoundCommand::While(w) = comp {
                assert!(
                    !w.condition.is_empty(),
                    "while condition should be non-empty"
                );
                assert!(!w.body.is_empty(), "while body should be non-empty");
            } else {
                panic!("expected While compound command");
            }
        } else {
            panic!("expected Compound command");
        }
    }

    #[test]
    fn test_empty_function_body_rejected() {
        let parser = Parser::new("f() { }");
        assert!(
            parser.parse().is_err(),
            "empty function body should be rejected"
        );
    }

    #[test]
    fn test_empty_while_body_rejected() {
        let parser = Parser::new("while true; do\ndone");
        assert!(
            parser.parse().is_err(),
            "empty while body should be rejected"
        );
    }

    #[test]
    fn test_empty_for_body_rejected() {
        let parser = Parser::new("for i in 1 2 3; do\ndone");
        assert!(parser.parse().is_err(), "empty for body should be rejected");
    }

    #[test]
    fn test_empty_if_then_rejected() {
        let parser = Parser::new("if true; then\nfi");
        assert!(
            parser.parse().is_err(),
            "empty then clause should be rejected"
        );
    }

    #[test]
    fn test_empty_else_rejected() {
        let parser = Parser::new("if false; then echo yes; else\nfi");
        assert!(
            parser.parse().is_err(),
            "empty else clause should be rejected"
        );
    }

    #[test]
    fn test_unterminated_single_quote_rejected() {
        let parser = Parser::new("echo 'unterminated");
        assert!(
            parser.parse().is_err(),
            "unterminated single quote should be rejected"
        );
    }

    #[test]
    fn test_unterminated_double_quote_rejected() {
        let parser = Parser::new("echo \"unterminated");
        assert!(
            parser.parse().is_err(),
            "unterminated double quote should be rejected"
        );
    }

    #[test]
    fn test_leading_pipe_rejected() {
        let parser = Parser::new("| cat");
        assert!(parser.parse().is_err(), "leading | should be rejected");
    }

    #[test]
    fn test_leading_and_rejected() {
        let parser = Parser::new("&& echo hi");
        assert!(parser.parse().is_err(), "leading && should be rejected");
    }

    #[test]
    fn test_leading_or_rejected() {
        let parser = Parser::new("|| echo hi");
        assert!(parser.parse().is_err(), "leading || should be rejected");
    }

    #[test]
    fn test_nonempty_function_body_accepted() {
        let parser = Parser::new("f() { echo hi; }");
        assert!(
            parser.parse().is_ok(),
            "non-empty function body should be accepted"
        );
    }

    #[test]
    fn test_nonempty_while_body_accepted() {
        let parser = Parser::new("while true; do echo hi; done");
        assert!(
            parser.parse().is_ok(),
            "non-empty while body should be accepted"
        );
    }

    /// Issue #600: Subscript reader must handle nested ${...} containing brackets.
    #[test]
    fn test_nested_expansion_in_array_subscript() {
        // ${arr[$RANDOM % ${#arr[@]}]} must parse without error.
        // The subscript contains ${#arr[@]} which has its own [ and ].
        let parser = Parser::new("echo ${arr[$RANDOM % ${#arr[@]}]}");
        let script = parser.parse().unwrap();
        assert_eq!(script.commands.len(), 1);
        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.name.to_string(), "echo");
            assert_eq!(cmd.args.len(), 1);
            // The arg should contain an ArrayAccess with the full nested index
            let arg = &cmd.args[0];
            let has_array_access = arg.parts.iter().any(|p| {
                matches!(
                    p,
                    WordPart::ArrayAccess { name, index }
                    if name == "arr" && index.contains("${#arr[@]}")
                )
            });
            assert!(
                has_array_access,
                "expected ArrayAccess with nested index, got: {:?}",
                arg.parts
            );
        } else {
            panic!("expected simple command");
        }
    }

    /// Assignment with nested subscript must parse (previously caused fuel exhaustion).
    #[test]
    fn test_assignment_nested_subscript_parses() {
        let parser = Parser::new("x=${arr[$RANDOM % ${#arr[@]}]}");
        assert!(
            parser.parse().is_ok(),
            "assignment with nested subscript should parse"
        );
    }

    #[test]
    fn test_ansi_c_quoted_dollar_is_literal_and_quoted() {
        let parser = Parser::new("echo $'$(printf pwned)'");
        let script = parser.parse().unwrap();
        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.args.len(), 1);
            let arg = &cmd.args[0];
            assert!(arg.quoted, "ANSI-C quoted argument must be quoted");
            assert!(
                arg.parts
                    .iter()
                    .all(|part| matches!(part, WordPart::Literal(_))),
                "ANSI-C quoted argument must remain literal, got {:?}",
                arg.parts
            );
            assert_eq!(arg.to_string(), "$(printf pwned)");
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_ansi_c_quoted_nul_before_dollar_stays_literal() {
        for input in [
            "echo $'\\0$(printf pwned)'",
            "echo $'\\x00$(printf pwned)'",
            "echo $'\\u0000${SECRET}'",
            "echo $'\\U00000000${SECRET}'",
        ] {
            let parser = Parser::new(input);
            let script = parser.parse().unwrap();
            if let Command::Simple(cmd) = &script.commands[0] {
                assert_eq!(cmd.args.len(), 1);
                let arg = &cmd.args[0];
                assert!(arg.quoted, "ANSI-C quoted argument must be quoted: {input}");
                assert!(
                    arg.parts
                        .iter()
                        .all(|part| matches!(part, WordPart::Literal(_))),
                    "ANSI-C quoted NUL must not expose expansions for {input}: {:?}",
                    arg.parts
                );
                // bash strings end at a NUL: nothing after it survives.
                assert!(
                    arg.to_string().is_empty(),
                    "decoded ANSI-C NUL should end the string for {input}"
                );
            } else {
                panic!("expected simple command");
            }
        }
    }

    #[test]
    fn test_single_quoted_segment_concatenation_stays_literal() {
        let parser = Parser::new("echo foo'$(id)'");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.args.len(), 1);
            assert_eq!(cmd.args[0].to_string(), "foo$(id)");
            assert!(
                cmd.args[0]
                    .parts
                    .iter()
                    .all(|p| matches!(p, WordPart::Literal(_))),
                "single-quoted segment should not produce expansions: {:?}",
                cmd.args[0].parts
            );
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_locale_quote_marks_word_as_quoted_without_expansion() {
        let parser = Parser::new("echo $\"*.txt\"");
        let script = parser.parse().unwrap();
        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.args.len(), 1);
            assert!(
                cmd.args[0].quoted,
                "locale-quoted argument must be marked quoted"
            );
            assert_eq!(cmd.args[0].to_string(), "*.txt");
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_case_literal_pattern_escaped_dollar_continuation_stays_literal() {
        let parser =
            Parser::new(r#"case "xy" in 'x'"\$(echo y)") echo MATCH ;; *) echo NOMATCH ;; esac"#);
        let script = parser.parse().unwrap();

        let case = match &script.commands[0] {
            Command::Compound(CompoundCommand::Case(case), _) => case,
            other => panic!("expected case command, got: {other:?}"),
        };
        let pattern = &case.cases[0].patterns[0];
        assert_eq!(pattern.to_string(), r#"x$(echo y)"#);
        assert!(
            pattern
                .parts
                .iter()
                .all(|part| matches!(part, WordPart::Literal(_))),
            "escaped dollar in literal case pattern must not parse as expansion: {:?}",
            pattern.parts
        );
    }

    #[test]
    fn test_single_quoted_assignment_value_stays_literal() {
        let parser = Parser::new("VAR='$(id)'");
        let script = parser.parse().unwrap();

        if let Command::Simple(cmd) = &script.commands[0] {
            assert_eq!(cmd.assignments.len(), 1);
            assert_eq!(cmd.assignments[0].name, "VAR");
            match &cmd.assignments[0].value {
                AssignmentValue::Scalar(word) => {
                    assert_eq!(word.to_string(), "$(id)");
                    assert!(
                        word.parts.iter().all(|p| matches!(p, WordPart::Literal(_))),
                        "single-quoted assignment should remain literal: {:?}",
                        word.parts
                    );
                }
                AssignmentValue::Array(_) => panic!("expected scalar assignment"),
            }
        } else {
            panic!("expected simple command");
        }
    }

    #[test]
    fn test_assignment_with_plus_equal_in_value_parses_as_assignment() {
        let parser = Parser::new("VAR=a+=b");
        let script = parser.parse().expect("script should parse");
        let cmd = match &script.commands[0] {
            Command::Simple(cmd) => cmd,
            other => panic!("expected simple command, got: {other:?}"),
        };
        assert_eq!(cmd.assignments.len(), 1);
        assert_eq!(cmd.assignments[0].name, "VAR");
        assert!(!cmd.assignments[0].append);
        match &cmd.assignments[0].value {
            AssignmentValue::Scalar(word) => assert_eq!(word.to_string(), "a+=b"),
            AssignmentValue::Array(_) => panic!("expected scalar assignment"),
        }
    }

    #[test]
    fn test_array_append_assignment_with_equal_in_subscript_parses_as_assignment() {
        let parser = Parser::new("arr[i=0]+=x");
        let script = parser.parse().expect("script should parse");
        let cmd = match &script.commands[0] {
            Command::Simple(cmd) => cmd,
            other => panic!("expected simple command, got: {other:?}"),
        };
        assert_eq!(cmd.assignments.len(), 1);
        assert_eq!(cmd.assignments[0].name, "arr");
        assert_eq!(cmd.assignments[0].index.as_deref(), Some("i=0"));
        assert!(cmd.assignments[0].append);
        match &cmd.assignments[0].value {
            AssignmentValue::Scalar(word) => assert_eq!(word.to_string(), "x"),
            AssignmentValue::Array(_) => panic!("expected scalar assignment"),
        }
    }

    #[test]
    fn test_assoc_append_assignment_with_equal_in_subscript_parses_as_assignment() {
        let parser = Parser::new("assoc[key=value]+=x");
        let script = parser.parse().expect("script should parse");
        let cmd = match &script.commands[0] {
            Command::Simple(cmd) => cmd,
            other => panic!("expected simple command, got: {other:?}"),
        };
        assert_eq!(cmd.assignments.len(), 1);
        assert_eq!(cmd.assignments[0].name, "assoc");
        assert_eq!(cmd.assignments[0].index.as_deref(), Some("key=value"));
        assert!(cmd.assignments[0].append);
        match &cmd.assignments[0].value {
            AssignmentValue::Scalar(word) => assert_eq!(word.to_string(), "x"),
            AssignmentValue::Array(_) => panic!("expected scalar assignment"),
        }
    }

    fn nested_command_substitution(levels: usize) -> String {
        let mut script = String::from("echo ok");
        for _ in 0..levels {
            script = format!("echo $({script})");
        }
        script
    }

    #[test]
    fn nested_command_substitution_consumes_ast_depth() {
        let script = nested_command_substitution(4);
        let err = Parser::with_limits(&script, 3, 10_000)
            .parse()
            .expect_err("substitution parsers must share AST depth");
        assert!(err.to_string().contains("AST nesting too deep"));
    }

    #[test]
    fn nested_command_substitution_parser_is_stack_safe() {
        let script = nested_command_substitution(50);
        Parser::new(&script)
            .parse()
            .expect("depth 50 remains within the hard AST limit");
    }

    #[test]
    fn nested_command_substitution_hard_cap_is_stack_safe() {
        let script = nested_command_substitution(120);
        // Every level rescans its body; size work so the AST cap trips first.
        let fuel = script
            .len()
            .saturating_mul(HARD_MAX_AST_DEPTH)
            .saturating_mul(4);
        let err = Parser::with_limits(&script, usize::MAX, fuel)
            .parse()
            .expect_err("the hard AST cap also covers substitution parsers");
        assert!(err.to_string().contains("AST nesting too deep"));
    }

    #[test]
    fn nested_command_substitution_depth_boundary() {
        let valid = nested_command_substitution(3);
        Parser::with_limits(&valid, 3, 10_000).parse().unwrap();
        let mixed = "if true; then echo $(echo $(echo ok)); fi";
        Parser::with_limits(mixed, 3, 10_000).parse().unwrap();
        let err = Parser::with_limits(mixed, 2, 10_000).parse().unwrap_err();
        assert!(err.to_string().contains("AST nesting too deep"));
    }

    #[test]
    fn nested_command_substitution_hard_cap_in_other_grammar_positions() {
        for template in [
            "echo $(true; BODY)",
            "echo $(true | BODY)",
            "x=$(BODY)",
            "echo $(>out BODY)",
            "a=($(BODY))",
            "declare a=($(BODY))",
            "echo $(echo ${v:-x}; BODY)",
        ] {
            let mut script = String::from("echo ok");
            for _ in 0..120 {
                script = template.replace("BODY", &script);
            }
            // Each nested command performs a bounded boundary scan before its
            // grammar parse. Size work for those passes so this test reaches
            // the hard AST-depth admission rather than the fuel admission.
            let fuel = script
                .len()
                .saturating_mul(HARD_MAX_AST_DEPTH)
                .saturating_mul(4);
            let err = Parser::with_limits(&script, usize::MAX, fuel)
                .parse()
                .unwrap_err();
            // The `${...}` operand scan enforces the same hard cap one step
            // before the nested parser does, with its own limit variant.
            assert!(
                matches!(
                    err,
                    Error::ResourceLimit(
                        LimitExceeded::AstDepth { .. }
                            | LimitExceeded::ParameterBoundaryDepth
                            | LimitExceeded::ParameterCommandDepth
                    )
                ),
                "{template}: {err}"
            );
        }
    }

    #[test]
    fn nested_command_substitution_preserves_timeout_origin() {
        let mut parent =
            Parser::with_limits_and_timeout("echo ok", 10, 1000, Some(Duration::from_millis(1)));
        parent.started_at = Instant::now() - Duration::from_secs(1);
        let mut child = parent.nested_parser("echo ok").unwrap();
        assert!(matches!(
            child.parse_inner(),
            Err(Error::ResourceLimit(LimitExceeded::ParserTimeout(_)))
        ));
    }

    fn nested_process_substitution(levels: usize) -> String {
        let mut script = String::from("cat ");
        for _ in 0..levels {
            script.push_str("<(cat ");
        }
        script.push_str("echo x");
        for _ in 0..levels {
            script.push_str("; )");
        }
        script
    }

    #[test]
    fn test_nested_process_substitution_within_budget_parses() {
        let script = nested_process_substitution(3);
        let parser = Parser::with_limits(&script, 8, 1_000);
        parser
            .parse()
            .expect("nested process substitution within budget should parse");
    }

    #[test]
    fn test_nested_process_substitution_consumes_depth_budget() {
        let script = nested_process_substitution(5);
        let parser = Parser::with_limits(&script, 4, 10_000);
        let err = parser
            .parse()
            .expect_err("nested process substitution must not bypass AST depth");
        assert!(
            err.to_string().contains("AST nesting too deep"),
            "expected AST depth error, got: {err}"
        );
    }

    #[test]
    fn test_nested_process_substitution_consumes_fuel_budget() {
        let script = nested_process_substitution(8);
        let parser = Parser::with_limits(&script, 100, 8);
        let err = parser
            .parse()
            .expect_err("nested process substitution must not get fresh parser fuel");
        assert!(
            err.to_string().contains("parser fuel exhausted"),
            "expected parser fuel error, got: {err}"
        );
    }

    #[test]
    fn test_process_substitution_whitespace_body_consumes_fuel_budget() {
        let script = format!("cat <({}echo x)", " ".repeat(256));
        let parser = Parser::with_limits(&script, 100, 200);
        let err = parser
            .parse()
            .expect_err("process substitution body scanning must consume parser fuel");
        assert!(
            err.to_string().contains("parser fuel exhausted"),
            "expected parser fuel error, got: {err}"
        );
    }

    #[test]
    fn test_nested_coproc_respects_ast_depth_limit() {
        let parser = Parser::with_limits("coproc coproc echo x", 1, usize::MAX);
        let err = parser.parse().unwrap_err();
        assert!(
            err.to_string().contains("AST nesting too deep"),
            "expected controlled AST depth error, got: {err}"
        );
    }

    #[test]
    fn test_nested_coproc_consumes_parser_fuel() {
        let parser = Parser::with_limits("coproc coproc echo x", 100, 3);
        let err = parser.parse().unwrap_err();
        assert!(
            err.to_string().contains("parser fuel exhausted"),
            "expected controlled parser fuel error, got: {err}"
        );
    }

    #[test]
    fn test_chained_heredoc_reinjection_consumes_parser_fuel() {
        let script = ": <<E && : <<E && : <<E\nE\nE\nE\n";
        let err = Parser::with_fuel(script, 12).parse().unwrap_err();
        assert!(
            err.to_string().contains("parser fuel exhausted"),
            "expected heredoc rest-of-line reinjection to consume parser fuel, got: {err}"
        );
    }

    #[test]
    fn test_array_subscript_single_double_quote_character_does_not_panic() {
        let parser = Parser::new(r#"echo "${arr[\"]}""#);
        let result = parser.parse();

        assert!(
            result.is_ok(),
            "single-character quoted subscript should not panic: {result:?}"
        );
    }

    #[test]
    fn test_double_quoted_param_expansion_obeys_parser_depth_limit() {
        let parser = Parser::with_limits(r#"echo "${a:-${b:-${c}}}""#, 2, usize::MAX);
        let err = parser
            .parse()
            .expect_err("nested parameter expansion should be rejected");

        assert!(
            err.to_string()
                .contains("parameter expansion nesting too deep"),
            "expected parameter expansion depth error, got: {err}"
        );
    }

    #[test]
    fn test_top_level_reserved_word_errors_immediately() {
        let parser = Parser::with_fuel("fi", usize::MAX);
        let err = parser.parse().unwrap_err();
        assert!(
            err.to_string().contains("unexpected token"),
            "expected immediate syntax error, got: {err}"
        );
    }
}
