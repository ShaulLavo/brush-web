//! Finds the `)` that closes a `$(...)` body.
//!
//! Decision: one incremental scanner shared by the lexer and `parse_word`, fed
//! one char at a time, so both agree on where a command substitution ends.
//! Plain paren counting closed `$(cat <<'E'` at a `)` inside the heredoc body,
//! and `$(echo ")")` at the quoted `)`. Bash finds the end by parsing; this
//! tracks the contexts that can hide a `)`: single/double quotes, backslash
//! escapes, backticks, nested `$(...)`, comments and heredoc bodies.
//! `case` is tracked too: the bare `)` that ends a case pattern
//! (`$(case x in x) ...;; esac)`) does not close the substitution. Words are
//! split at blanks and operators, and `case`/`in`/`esac` count only as
//! unquoted words in the right place (command position for `case`/`esac`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    /// Shell code inside `$(` (or `(` nesting within it).
    Code,
    /// Immediately after `$(`: a second adjacent `(` selects arithmetic.
    Substitution,
    /// Arithmetic parens hide shell keywords, comments and heredoc operators.
    Arithmetic,
    /// A `${...}` span inside arithmetic or command text.
    Parameter,
    Single,
    Ansi,
    Double,
    Backtick,
}

/// Where an open `case` (inside one code frame) is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CasePhase {
    /// After `case`, reading the subject word.
    Subject,
    /// Expecting `in`.
    In,
    /// Reading a pattern list; `started` once any pattern text was seen.
    Pattern { started: bool },
    /// In a branch body, until `;;`, `;&`, `;;&` or `esac`.
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaseCtx {
    phase: CasePhase,
    /// Paren depth of the frame when `case` started.
    depth: usize,
}

/// Word and `case` tracking for one `Code` frame.
#[derive(Debug, Clone, Default)]
struct CodeState {
    /// Unquoted text of the current word, capped (only keywords matter).
    word: String,
    /// The current word has quoted or escaped parts, so it is no keyword.
    word_quoted: bool,
    /// The next word starts a command.
    cmd_pos: bool,
    cases: Vec<CaseCtx>,
    /// Operators and heredocs belong to this scope, not nested substitutions.
    lt_run: usize,
    arith_at: Option<usize>,
    pending_heredocs: std::collections::VecDeque<Heredoc>,
}

/// Longest keyword we need to recognise (`case`, `esac`).
const MAX_KEYWORD: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Heredoc {
    delimiter: String,
    strip_tabs: bool,
}

#[derive(Debug, Clone)]
enum Mode {
    Normal,
    /// After a backslash: the next char is literal.
    Escape {
        previous: Option<char>,
    },
    /// A continuation after `$(` must not hide an arithmetic second `(`.
    SubstitutionEscape,
    /// `#` comment, until newline.
    Comment,
    /// Reading the word after `<<` / `<<-`.
    Delimiter {
        strip_tabs: bool,
        word: String,
        started: bool,
        quote: Option<char>,
        /// A `$(...)` inside the delimiter word, scanned by its own scanner
        /// so quotes, escapes and nested spans cannot end it early.
        nested: Option<Box<SubstScanner>>,
    },
    /// Inside heredoc bodies; `line` accumulates the current line.
    Body {
        line: String,
    },
}

/// Result of feeding one char.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Char belongs to the body.
    Body,
    /// Char is the closing `)`; it is not part of the body.
    Close,
}

/// Incremental scanner for a `$(...)` body. Create it after consuming `$(`.
#[derive(Debug, Clone)]
pub struct SubstScanner {
    /// Context stack; the bottom `Code` frame is the substitution itself.
    stack: Vec<Frame>,
    /// Paren depth per `Code` frame (parallel to Code entries in `stack`).
    parens: Vec<usize>,
    /// Word/`case` state per `Code` frame (parallel to `parens`).
    code: Vec<CodeState>,
    mode: Mode,
    prev: Option<char>,
    offset: usize,
    root_arithmetic: Option<usize>,
    /// Body start offset per code frame (parallel to `code`).
    starts: Vec<usize>,
    /// Closed `$(...)` bodies whose enclosing text is all raw (`$((`,
    /// `${...}` or quotes): no enclosing command parse reaches them, but
    /// bash parses them as commands with the script.
    opaque_commands: Vec<(usize, usize)>,
}

impl Default for SubstScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl SubstScanner {
    pub fn new() -> Self {
        Self::with_frame(Frame::Substitution)
    }

    fn with_frame(frame: Frame) -> Self {
        Self {
            stack: vec![frame],
            parens: vec![0],
            code: vec![CodeState {
                cmd_pos: true,
                ..CodeState::default()
            }],
            mode: Mode::Normal,
            prev: None,
            offset: 0,
            root_arithmetic: None,
            starts: vec![0],
            opaque_commands: Vec::new(),
        }
    }

    /// Process one source scalar. The scanner never buffers or replays source.
    pub fn feed(&mut self, c: char) -> Step {
        self.offset += c.len_utf8();
        self.process(c)
    }

    /// Byte offset just past the last source scalar.
    pub fn offset(&self) -> usize {
        self.offset
    }

    /// Byte position of the second `(` when the root opened as `$((`.
    /// Continuations may precede it. Bash scans such a span as raw arithmetic
    /// text and never parses it as commands at parse time; whether it expands
    /// as arithmetic or as a command is [`arithmetic_expression`]'s decision.
    pub fn arithmetic_start(&self) -> Option<usize> {
        self.root_arithmetic
    }


    fn process(&mut self, c: char) -> Step {
        let escaped = match self.mode {
            Mode::Escape { previous } => Some(previous),
            Mode::SubstitutionEscape => Some(None),
            _ => None,
        };
        let step = self.feed_inner(c);
        // A consumed escape is data, never a fresh dollar/quote opener. A
        // continuation alone preserves the preceding logical character.
        self.prev = match escaped {
            Some(previous) => {
                if c == '\n' {
                    previous
                } else {
                    None
                }
            }
            None => Some(c),
        };
        step
    }

    fn top(&self) -> Frame {
        *self.stack.last().unwrap_or(&Frame::Code)
    }

    fn feed_inner(&mut self, c: char) -> Step {
        match std::mem::replace(&mut self.mode, Mode::Normal) {
            Mode::Escape { .. } => Step::Body,
            Mode::SubstitutionEscape => {
                if c != '\n' {
                    *self.stack.last_mut().expect("substitution frame") = Frame::Code;
                    self.quote_word();
                }
                Step::Body
            }
            Mode::Comment => {
                if c == '\n' {
                    self.on_newline();
                } else {
                    self.mode = Mode::Comment;
                }
                Step::Body
            }
            Mode::Body { mut line } => {
                if c == ')' && self.delimiter_line(&line) {
                    // Bash, in a command substitution: a line that is the
                    // delimiter followed by the closing `)` ends the
                    // here-document ("delimited by end-of-file") and the `)`
                    // is read again as code.
                    self.code
                        .last_mut()
                        .expect("code state")
                        .pending_heredocs
                        .pop_front();
                    return self.feed_normal(c);
                }
                if c != '\n' {
                    line.push(c);
                    self.mode = Mode::Body { line };
                    return Step::Body;
                }
                let doc = &self.code.last_mut().expect("code state").pending_heredocs[0];
                let candidate = if doc.strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if candidate == doc.delimiter {
                    self.code
                        .last_mut()
                        .expect("code state")
                        .pending_heredocs
                        .pop_front();
                }
                if !self
                    .code
                    .last_mut()
                    .expect("code state")
                    .pending_heredocs
                    .is_empty()
                {
                    self.mode = Mode::Body {
                        line: String::new(),
                    };
                }
                Step::Body
            }
            Mode::Delimiter {
                strip_tabs,
                mut word,
                started,
                quote,
                mut nested,
            } => {
                // A `$(...)` in the delimiter is part of its word (bash reads
                // the word with its substitutions; the body line matches the
                // literal text).
                if quote.is_none() && (nested.is_some() || (c == '(' && word.ends_with('$'))) {
                    word.push(c);
                    match nested.as_mut() {
                        None => nested = Some(Box::new(SubstScanner::new())),
                        Some(scanner) => {
                            if scanner.feed(c) == Step::Close {
                                nested = None;
                            }
                        }
                    }
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started: true,
                        quote,
                        nested,
                    };
                    return Step::Body;
                }
                if quote == Some('\\') {
                    // An escaped character is part of the delimiter word, even
                    // a metacharacter (`<<foo\)` waits for the line `foo)`);
                    // an escaped newline is a continuation.
                    if c != '\n' {
                        word.push(c);
                    }
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started: true,
                        quote: None,
                        nested,
                    };
                    return Step::Body;
                }
                if let Some(q) = quote {
                    if c != q {
                        word.push(c);
                    }
                    let quote = if c == q { None } else { Some(q) };
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started: true,
                        quote,
                        nested: None,
                    };
                    return Step::Body;
                }
                if !started && c == '-' && word.is_empty() && !strip_tabs {
                    self.mode = Mode::Delimiter {
                        strip_tabs: true,
                        word,
                        started: false,
                        quote: None,
                        nested: None,
                    };
                    return Step::Body;
                }
                if !started && (c == ' ' || c == '\t') {
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started,
                        quote: None,
                        nested: None,
                    };
                    return Step::Body;
                }
                let ends =
                    c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '<' | '>');
                if ends {
                    if !word.is_empty() {
                        self.code
                            .last_mut()
                            .expect("code state")
                            .pending_heredocs
                            .push_back(Heredoc {
                                delimiter: word,
                                strip_tabs,
                            });
                    }
                    // The terminator is ordinary code: reprocess it.
                    return self.feed_inner(c);
                }
                if c == '\'' || c == '"' {
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started: true,
                        quote: Some(c),
                        nested: None,
                    };
                    return Step::Body;
                }
                if c == '\\' {
                    self.mode = Mode::Delimiter {
                        strip_tabs,
                        word,
                        started: true,
                        quote: Some('\\'),
                        nested,
                    };
                    return Step::Body;
                }
                word.push(c);
                self.mode = Mode::Delimiter {
                    strip_tabs,
                    word,
                    started: true,
                    quote: None,
                    nested: None,
                };
                Step::Body
            }
            Mode::Normal => self.feed_normal(c),
        }
    }

    fn delimiter_line(&self, line: &str) -> bool {
        let Some(doc) = self.code.last().and_then(|st| st.pending_heredocs.front()) else {
            return false;
        };
        let candidate = if doc.strip_tabs {
            line.trim_start_matches('\t')
        } else {
            line
        };
        candidate == doc.delimiter
    }

    fn on_newline(&mut self) {
        if !self
            .code
            .last_mut()
            .expect("code state")
            .pending_heredocs
            .is_empty()
        {
            self.mode = Mode::Body {
                line: String::new(),
            };
        }
    }

    fn feed_normal(&mut self, c: char) -> Step {
        match self.top() {
            Frame::Substitution => {
                if c == '\\' {
                    self.mode = Mode::SubstitutionEscape;
                    return Step::Body;
                }
                *self.stack.last_mut().expect("substitution frame") = if c == '(' {
                    let start = self.offset - c.len_utf8();
                    if self.stack.len() == 1 {
                        self.root_arithmetic = Some(start);
                    }
                    Frame::Arithmetic
                } else {
                    Frame::Code
                };
                // The consumed dollar opener is outside this scope.
                self.prev = None;
                self.feed_normal(c)
            }
            Frame::Arithmetic => self.feed_arithmetic(c),
            Frame::Parameter => self.feed_parameter(c),
            Frame::Ansi => {
                if c == '\\' {
                    self.mode = Mode::Escape {
                        previous: self.prev,
                    };
                } else if c == '\'' {
                    self.stack.pop();
                }
                Step::Body
            }
            Frame::Single => {
                if c == '\'' {
                    self.stack.pop();
                }
                Step::Body
            }
            Frame::Double => {
                match c {
                    '\\' => {
                        self.mode = Mode::Escape {
                            previous: self.prev,
                        }
                    }
                    '"' => {
                        self.stack.pop();
                    }
                    '(' if self.prev == Some('$') => self.push_code(),
                    '{' if self.prev == Some('$') => self.stack.push(Frame::Parameter),
                    '`' => self.stack.push(Frame::Backtick),
                    _ => {}
                }
                Step::Body
            }
            Frame::Backtick => {
                match c {
                    '\\' => {
                        self.mode = Mode::Escape {
                            previous: self.prev,
                        }
                    }
                    '`' => {
                        self.stack.pop();
                    }
                    _ => {}
                }
                Step::Body
            }
            Frame::Code => self.feed_code(c),
        }
    }

    fn push_code(&mut self) {
        self.stack.push(Frame::Substitution);
        self.starts.push(self.offset);
        self.parens.push(0);
        self.code.push(CodeState {
            cmd_pos: true,
            ..CodeState::default()
        });
    }

    fn pop_code(&mut self) -> Step {
        self.parens.pop();
        self.code.pop();
        let start = self.starts.pop().expect("code frame start");
        let frame = self.stack.pop();
        if self.stack.is_empty() {
            return Step::Close;
        }
        if frame == Some(Frame::Code) && self.raw_context() {
            self.opaque_commands.push((start, self.offset - 1));
        }
        Step::Body
    }

    /// No enclosing frame is command text (parsed with its own span) or a
    /// backquote (parsed only when it expands).
    fn raw_context(&self) -> bool {
        !self
            .stack
            .iter()
            .any(|frame| matches!(frame, Frame::Code | Frame::Backtick))
    }

    /// See [`SubstScanner::opaque_commands`] field docs: `(start, end)` byte
    /// ranges of closed command bodies nested only in raw text.
    pub fn opaque_commands(&self) -> &[(usize, usize)] {
        &self.opaque_commands
    }

    /// At end of input: where bash's first command parse of the unterminated
    /// span starts (the outermost open command frame), or `None` when only
    /// raw text is open, whose sole error is the end of input.
    pub fn unterminated_command_start(&self) -> Option<usize> {
        let mut code = 0;
        for frame in &self.stack {
            match frame {
                Frame::Code => return Some(self.starts[code]),
                Frame::Backtick => return None,
                Frame::Substitution | Frame::Arithmetic => code += 1,
                _ => {}
            }
        }
        None
    }

    fn feed_arithmetic(&mut self, c: char) -> Step {
        // Bash gives `$((` arithmetic lexical precedence: balance the whole
        // raw outer span first, without activating command comments/heredocs.
        // Nonadjacent final closes may execute as a command subshell, but do
        // not change that source boundary or allow fallback at source EOF.
        match c {
            '\\' => {
                self.mode = Mode::Escape {
                    previous: self.prev,
                }
            }
            '\'' => self.stack.push(if self.prev == Some('$') {
                Frame::Ansi
            } else {
                Frame::Single
            }),
            '"' => self.stack.push(Frame::Double),
            '`' => self.stack.push(Frame::Backtick),
            // Bash's arithmetic matcher (`P_ARITH`) nests `$(` but not `${`:
            // braces are plain text there and parentheses inside them count.
            '(' if self.prev == Some('$') => self.push_code(),
            '(' => *self.parens.last_mut().expect("arithmetic frame") += 1,
            ')' => {
                let depth = self.parens.last_mut().expect("arithmetic frame");
                if *depth == 0 {
                    return self.pop_code();
                }
                *depth -= 1;
            }
            _ => {}
        }
        Step::Body
    }

    fn feed_parameter(&mut self, c: char) -> Step {
        match c {
            '\\' => {
                self.mode = Mode::Escape {
                    previous: self.prev,
                }
            }
            '\'' => self.stack.push(if self.prev == Some('$') {
                Frame::Ansi
            } else {
                Frame::Single
            }),
            '"' => self.stack.push(Frame::Double),
            '`' => self.stack.push(Frame::Backtick),
            '{' if self.prev == Some('$') => self.stack.push(Frame::Parameter),
            '(' if self.prev == Some('$') => self.push_code(),
            '}' => {
                self.stack.pop();
            }
            _ => {}
        }
        Step::Body
    }

    /// Mark the current word as quoted (a quote or escape starts in code).
    fn quote_word(&mut self) {
        if let Some(st) = self.code.last_mut() {
            st.word_quoted = true;
            st.word.push('"');
        }
    }

    /// End the current word in the top code frame and update `case` state.
    fn end_word(&mut self) {
        let Some(st) = self.code.last_mut() else {
            return;
        };
        if st.word.is_empty() {
            return;
        }
        let word = std::mem::take(&mut st.word);
        let keyword = !std::mem::take(&mut st.word_quoted);
        let cmd_pos = st.cmd_pos;
        let depth = self.parens.last().copied().unwrap_or(0);
        let kw = |k: &str| keyword && word == k;
        let mut next_cmd_pos = false;
        match st.cases.last_mut().map(|c| (c.phase, c.depth)) {
            Some((CasePhase::Subject, _)) => {
                if let Some(c) = st.cases.last_mut() {
                    c.phase = CasePhase::In;
                }
            }
            Some((CasePhase::In, _)) => {
                if let Some(c) = st.cases.last_mut() {
                    c.phase = if kw("in") {
                        CasePhase::Pattern { started: false }
                    } else {
                        // Not `in`: not a case we understand; stop tracking.
                        st.cases.pop();
                        return;
                    };
                }
            }
            Some((CasePhase::Pattern { started }, d)) if d == depth => {
                if !started && kw("esac") {
                    st.cases.pop();
                } else if let Some(c) = st.cases.last_mut() {
                    c.phase = CasePhase::Pattern { started: true };
                }
            }
            Some((CasePhase::Body, d)) if d == depth && cmd_pos && kw("esac") => {
                st.cases.pop();
            }
            _ => {
                if cmd_pos && kw("case") {
                    st.cases.push(CaseCtx {
                        phase: CasePhase::Subject,
                        depth,
                    });
                } else if cmd_pos
                    && keyword
                    && matches!(
                        word.as_str(),
                        "if" | "then"
                            | "else"
                            | "elif"
                            | "do"
                            | "while"
                            | "until"
                            | "{"
                            | "!"
                            | "time"
                    )
                {
                    next_cmd_pos = true;
                }
            }
        }
        st.cmd_pos = next_cmd_pos;
    }

    /// The open case in the top frame, if it is at the current paren depth.
    fn case_here(&self) -> Option<CasePhase> {
        let depth = self.parens.last().copied().unwrap_or(0);
        self.code
            .last()
            .and_then(|st| st.cases.last())
            .filter(|c| c.depth == depth)
            .map(|c| c.phase)
    }

    fn set_case_phase(&mut self, phase: CasePhase) {
        if let Some(c) = self.code.last_mut().and_then(|st| st.cases.last_mut()) {
            c.phase = phase;
        }
    }

    fn set_cmd_pos(&mut self, on: bool) {
        if let Some(st) = self.code.last_mut() {
            st.cmd_pos = on;
        }
    }

    fn feed_code(&mut self, c: char) -> Step {
        let lt_run = if c == '<' {
            self.code.last_mut().expect("code state").lt_run + 1
        } else {
            0
        };
        let heredoc_op = self.code.last_mut().expect("code state").lt_run == 2
            && c != '<'
            && self.code.last_mut().expect("code state").arith_at.is_none();
        self.code.last_mut().expect("code state").lt_run = lt_run;
        if heredoc_op {
            // `<<` followed by something other than a third `<`.
            self.mode = Mode::Delimiter {
                strip_tabs: false,
                word: String::new(),
                started: false,
                quote: None,
                nested: None,
            };
            return self.feed_inner(c);
        }
        if c == '{' && self.prev == Some('$') {
            self.quote_word();
            self.stack.push(Frame::Parameter);
            return Step::Body;
        }
        let word_char = !c.is_whitespace()
            && !matches!(
                c,
                ';' | '|' | '&' | '(' | ')' | '<' | '>' | '\\' | '\'' | '"' | '`'
            );
        if word_char {
            if c == '#'
                && self
                    .prev
                    .is_none_or(|p| p.is_whitespace() || matches!(p, ';' | '|' | '&' | '(' | ')'))
            {
                self.end_word();
                self.mode = Mode::Comment;
                return Step::Body;
            }
            if let Some(st) = self.code.last_mut()
                && st.word.len() < MAX_KEYWORD
            {
                st.word.push(c);
            } else if let Some(st) = self.code.last_mut() {
                st.word_quoted = true; // too long to be a keyword
            }
            return Step::Body;
        }
        match c {
            '\\' => {
                self.quote_word();
                self.mode = Mode::Escape {
                    previous: self.prev,
                };
            }
            '\'' => {
                self.quote_word();
                self.stack.push(if self.prev == Some('$') {
                    Frame::Ansi
                } else {
                    Frame::Single
                });
            }
            '"' => {
                self.quote_word();
                self.stack.push(Frame::Double);
            }
            '`' => {
                self.quote_word();
                self.stack.push(Frame::Backtick);
            }
            '\n' => {
                self.end_word();
                self.set_cmd_pos(true);
                self.on_newline();
            }
            '(' => {
                if self.prev == Some('$') {
                    self.quote_word();
                    self.push_code();
                    return Step::Body;
                }
                self.end_word();
                // The optional `(` before a case pattern is not nesting.
                if let Some(CasePhase::Pattern { started: false }) = self.case_here() {
                    self.set_case_phase(CasePhase::Pattern { started: true });
                    return Step::Body;
                }
                if let Some(depth) = self.parens.last_mut() {
                    *depth += 1;
                    if self.prev == Some('(')
                        && self.code.last_mut().expect("code state").arith_at.is_none()
                    {
                        self.code.last_mut().expect("code state").arith_at =
                            Some(depth.saturating_sub(2));
                    }
                }
                self.set_cmd_pos(true);
            }
            ')' => {
                self.end_word();
                // `)` ending a case pattern list starts the branch body. With
                // no pattern yet (`;;)`) it is no terminator: bash reports it.
                if let Some(CasePhase::Pattern { started: true }) = self.case_here() {
                    self.set_case_phase(CasePhase::Body);
                    self.set_cmd_pos(true);
                    return Step::Body;
                }
                let depth = self.parens.last_mut().expect("code frame");
                if *depth > 0 {
                    *depth -= 1;
                    if self
                        .code
                        .last_mut()
                        .expect("code state")
                        .arith_at
                        .is_some_and(|at| *depth <= at)
                    {
                        self.code.last_mut().expect("code state").arith_at = None;
                    }
                    self.set_cmd_pos(false);
                } else {
                    // Closes this `$(` frame.
                    return self.pop_code();
                }
            }
            ';' | '&' => {
                self.end_word();
                // `;;`, `;&` and `;;&` end a case branch.
                if self.prev == Some(';') && self.case_here() == Some(CasePhase::Body) {
                    self.set_case_phase(CasePhase::Pattern { started: false });
                }
                self.set_cmd_pos(true);
            }
            '|' => {
                self.end_word();
                if !matches!(self.case_here(), Some(CasePhase::Pattern { .. })) {
                    self.set_cmd_pos(true);
                }
            }
            _ => self.end_word(),
        }
        Step::Body
    }
}

/// The arithmetic expression of a resolved `$((...))` body, or `None` when
/// bash runs the span as a command substitution. `body` is the text between
/// `$(` and the final `)`; `start` is [`SubstScanner::arithmetic_start`].
/// Bash requires the text after the inner `(` to end in `)` and, without that
/// `)`, to balance its parentheses outside quotes (`chk_arithsub`), so
/// `$((a) + (b))` is a command.
pub(crate) fn arithmetic_expression(body: &str, start: usize) -> Option<&str> {
    let expression = body
        .get(start + 1..)?
        .trim_end_matches("\\\n")
        .strip_suffix(')')?;
    balanced_arithmetic(expression).then_some(expression)
}

/// Bash `chk_arithsub`: raw parentheses balance outside quotes and escapes.
fn balanced_arithmetic(text: &str) -> bool {
    let mut depth = 0usize;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '(' => depth += 1,
            ')' => match depth.checked_sub(1) {
                Some(next) => depth = next,
                None => return false,
            },
            '\\' => {
                chars.next();
            }
            '\'' => {
                if !chars.by_ref().any(|c| c == '\'') {
                    break;
                }
            }
            '"' => {
                // Bash skips a double-quoted string with its nested `$(`,
                // `${` and backquote spans; reuse the scanner's quote frames.
                let mut quoted = SubstScanner::with_frame(Frame::Double);
                for c in chars.by_ref() {
                    quoted.feed(c);
                    if quoted.stack.is_empty() {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    depth == 0
}

#[cfg(test)]
/// Split `s` (the text after `$(`) at the matching `)`: returns the body and
/// the byte offset just past the `)`, or `None` when unterminated.
fn split_subst_body(s: &str) -> Option<(&str, usize)> {
    let mut scanner = SubstScanner::new();
    for c in s.chars() {
        if scanner.feed(c) == Step::Close {
            let end = scanner.offset();
            return Some((&s[..end - 1], end));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(s: &str) -> Option<&str> {
        split_subst_body(s).map(|(b, _)| b)
    }

    #[test]
    fn plain_and_nested_parens() {
        assert_eq!(body("echo hi) rest"), Some("echo hi"));
        assert_eq!(body("(a) (b)) x"), Some("(a) (b)"));
        assert_eq!(body("echo $(date)) x"), Some("echo $(date)"));
    }

    #[test]
    fn quotes_hide_parens() {
        assert_eq!(body("echo \")\") x"), Some("echo \")\""));
        assert_eq!(body("echo ')') x"), Some("echo ')'"));
        assert_eq!(body("echo \\)) x"), Some("echo \\)"));
        assert_eq!(
            body("echo \"$(echo ')')\") x"),
            Some("echo \"$(echo ')')\"")
        );
        assert_eq!(body("echo `echo )`) x"), Some("echo `echo )`"));
    }

    #[test]
    fn comments_hide_parens() {
        assert_eq!(body("echo a # c)\n) x"), Some("echo a # c)\n"));
        assert_eq!(body("echo a#b) x"), Some("echo a#b"));
    }

    #[test]
    fn heredoc_bodies_hide_parens() {
        assert_eq!(
            body("cat <<'E'\nhello )\nE\n) x"),
            Some("cat <<'E'\nhello )\nE\n")
        );
        assert_eq!(
            body("cat <<-EOF\n\t( x\n\tEOF\n) x"),
            Some("cat <<-EOF\n\t( x\n\tEOF\n")
        );
        assert_eq!(
            body("cat <<A <<\"B\"\n)\nA\n)\nB\n) x"),
            Some("cat <<A <<\"B\"\n)\nA\n)\nB\n")
        );
        // here-string is not a heredoc
        assert_eq!(body("cat <<< x) y"), Some("cat <<< x"));
        // arithmetic shift is not a heredoc
        assert_eq!(body("echo $((1<<2))) y"), Some("echo $((1<<2))"));
    }

    #[test]
    fn case_patterns_do_not_close() {
        assert_eq!(
            body("case $x in a) echo A;; *) echo B;; esac) y"),
            Some("case $x in a) echo A;; *) echo B;; esac")
        );
        assert_eq!(
            body("case x in (a|b) echo;; esac) y"),
            Some("case x in (a|b) echo;; esac")
        );
        assert_eq!(
            body("case x in\n a)\n  echo;;\nesac\n) y"),
            Some("case x in\n a)\n  echo;;\nesac\n")
        );
        // nested case, fallthrough terminators
        assert_eq!(
            body("case a in a) case b in b) :;& *) :;;& esac;; esac) y"),
            Some("case a in a) case b in b) :;& *) :;;& esac;; esac")
        );
        // `case`/`esac` only count in command position
        assert_eq!(body("echo case) y"), Some("echo case"));
        assert_eq!(body("echo esac) y"), Some("echo esac"));
        // a `case` word inside a pattern body subshell
        assert_eq!(
            body("case x in x) (echo case);; esac) y"),
            Some("case x in x) (echo case);; esac")
        );
    }

    #[test]
    fn dollar_arithmetic_is_not_command_grammar() {
        for (source, expected) in [
            ("(1 << 2\n)) rest", "(1 << 2\n)"),
            ("(case == in)) rest", "(case == in)"),
            ("(16#ff)) rest", "(16#ff)"),
            ("(1 + ${u:-')'})) rest", "(1 + ${u:-')'})"),
            ("(1 + $((2 << 3\n)))) rest", "(1 + $((2 << 3\n)))"),
            ("(1 + $(echo 2 # ) }\n))) rest", "(1 + $(echo 2 # ) }\n))"),
        ] {
            assert_eq!(body(source), Some(expected), "{source}");
        }
    }

    #[test]
    fn arithmetic_candidates_keep_the_raw_outer_boundary() {
        for (source, expected, suffix) in [
            ("(printf é) ) suffix", "(printf é) ", " suffix"),
            (
                "(case x in x) :;; esac) ) suffix",
                "(case x in x) :;; esac",
                " ) suffix",
            ),
            (
                "(# (\nprintf é) ) ) suffix",
                "(# (\nprintf é) ) ",
                " suffix",
            ),
            ("(# )\nprintf é) suffix", "(# )\nprintf é", " suffix"),
        ] {
            assert_eq!(body(source), Some(expected), "{source}");
            let (_, end) = split_subst_body(source).unwrap();
            assert_eq!(&source[end..], suffix, "{source}");
        }
        for source in ["(printf é # (\n)) suffix", "(# (\nprintf é) ) suffix"] {
            assert_eq!(body(source), None, "{source}");
        }
    }

    #[test]
    fn escaped_dollars_cannot_introduce_nested_syntax() {
        for source in [
            r#"echo "${u:-\${x}") suffix"#,
            r#"echo "${u:-\$(x}") suffix"#,
            r#"echo "${u:-\$$(printf x)}") suffix"#,
            r#"echo "\$(case") suffix"#,
        ] {
            let (_, end) = split_subst_body(source).unwrap();
            assert_eq!(&source[end..], " suffix", "{source}");
        }
    }

    #[test]
    fn arithmetic_continuations_preserve_logical_parens() {
        for source in ["\\\n(1 << 2\n)) suffix", "(1 << 2)\\\n) suffix"] {
            let (_, end) = split_subst_body(source).unwrap();
            assert_eq!(&source[end..], " suffix", "{source}");
        }
    }

    #[test]
    fn process_substitution_fused_opener_matches_raw_parens() {
        // Bash reads `<((` like `$((`: raw parenthesis matching, so the case
        // pattern's `)` counts and the span ends after `esac)`.
        let source = "(case x in x) :;; esac)) suffix";
        let (body, end) = split_subst_body(source).unwrap();
        assert_eq!(body, "(case x in x) :;; esac");
        assert_eq!(&source[end..], ") suffix");
    }

    #[test]
    fn unterminated() {
        assert_eq!(body("echo (hi"), None);
        assert_eq!(body("cat <<E\n)\n"), None);
    }
}
