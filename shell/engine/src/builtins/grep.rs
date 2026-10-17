//! Adapted subset of Bashkit's GrepOptions/FileScan/scan_input in
//! crates/bashkit/src/builtins/grep.rs, MIT, revision
//! 491c3281f668b76d64b15210b8f5d7bf97244be0. See sources.lock.json.
//! Original descriptor adapter, bounded record reader and small BRE translator;
//! no upstream whole-file reads, output accumulation or backtracking matcher.
use super::{endpoint, write};
use crate::{
    executor::Budget,
    interpreter::{Context, Outcome},
    io::{Endpoint, FdTable, IoError, OpenOptions},
    state::{SharedState, absolute},
};
use regex::bytes::{Regex, RegexBuilder};

const PATTERN_BYTES: usize = 4096;
const REGEX_BYTES: usize = 256 * 1024;
const RECORD_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct Options {
    invert: bool,
    count: bool,
    quiet: bool,
    numbers: bool,
    ignore_case: bool,
    syntax: Syntax,
}
#[derive(Clone, Copy, Default, PartialEq)]
enum Syntax {
    #[default]
    Basic,
    Extended,
    Fixed,
}
impl Options {
    // Retain Bashkit's mixed option/operand and grouped short-option handling,
    // but reject every flag outside this acceptance-only subset.
    fn parse(args: Vec<String>) -> Result<(Self, String, Vec<String>), String> {
        let mut options = Self::default();
        let mut operands = Vec::new();
        let mut flags = true;
        for arg in args {
            if flags && arg == "--" {
                flags = false;
            } else if flags && arg.starts_with('-') && arg != "-" {
                for flag in arg[1..].chars() {
                    match flag {
                        'v' => options.invert = true,
                        'c' => options.count = true,
                        'q' => options.quiet = true,
                        'n' => options.numbers = true,
                        'i' => options.ignore_case = true,
                        'F' | 'E' => {
                            let syntax = if flag == 'F' {
                                Syntax::Fixed
                            } else {
                                Syntax::Extended
                            };
                            if options.syntax != Syntax::Basic && options.syntax != syntax {
                                return Err("conflicting matchers specified".into());
                            }
                            options.syntax = syntax;
                        }
                        _ => return Err(format!("unsupported option: -{flag}")),
                    }
                }
            } else {
                operands.push(arg);
            }
        }
        let mut operands = operands.into_iter();
        let pattern = operands.next().ok_or("missing pattern")?;
        Ok((options, pattern, operands.collect()))
    }
    fn compile(&self, pattern: &str) -> Result<Regex, String> {
        if pattern.len() > PATTERN_BYTES {
            return Err("pattern byte limit exceeded".into());
        }
        // GNU/Bashkit treat newline-separated patterns as alternatives. Group
        // them so anchors remain local, without adding any capturing groups.
        let mut translated = String::new();
        for pattern in pattern.split('\n') {
            if !translated.is_empty() {
                translated.push('|');
            }
            translated.push_str("(?:");
            translated.push_str(&match self.syntax {
                Syntax::Fixed => regex::escape(pattern),
                Syntax::Extended => pattern.to_owned(),
                Syntax::Basic => basic_pattern(pattern)?,
            });
            translated.push(')');
        }
        RegexBuilder::new(&translated)
            .case_insensitive(self.ignore_case)
            .size_limit(REGEX_BYTES)
            .dfa_size_limit(REGEX_BYTES)
            .nest_limit(64)
            .build()
            .map_err(|error| error.to_string())
    }
}

/// Original deliberately small GNU BRE adapter, not Bashkit's full grep_pattern
/// implementation. Unescaped ()+?|{} are literals, their escaped forms are
/// operators outside brackets. A caret anchors only at branch start and a
/// dollar only at branch end (including escaped BRE groups/alternation).
/// Backreferences are rejected by the linear-time regex engine, not routed
/// through a potentially backtracking fallback.
fn basic_pattern(pattern: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = pattern.chars().peekable();
    let mut bracket = false;
    let mut bracket_first = false;
    let mut branch_start = true;
    while let Some(ch) = chars.next() {
        if bracket {
            if ch == ']' && !bracket_first {
                bracket = false;
            }
            // GNU BRE backslashes are literal inside brackets.
            if ch == '\\' {
                result.push('\\');
            }
            result.push(ch);
            if !(bracket_first && ch == '^') {
                bracket_first = false;
            }
            continue;
        }
        match ch {
            '[' => {
                branch_start = false;
                bracket = true;
                bracket_first = true;
                result.push(ch);
                // regex requires an escaped initial literal closing bracket.
                if chars.peek() == Some(&']') {
                    chars.next();
                    result.push_str("\\]");
                    bracket_first = false;
                }
            }
            '\\' => {
                let next = chars.next().ok_or("trailing backslash")?;
                branch_start = matches!(next, '(' | '|');
                if matches!(next, '(' | ')' | '+' | '?' | '|' | '{' | '}') {
                    result.push(next);
                } else {
                    result.push('\\');
                    result.push(next);
                }
            }
            '^' => {
                if !branch_start {
                    result.push('\\');
                }
                result.push(ch);
                branch_start = false;
            }
            '$' => {
                // Only inspect the next two characters: no suffix allocation or
                // rescan, and escaped literal backslashes cannot open a branch.
                let mut tail = chars.clone();
                let branch_end = match tail.next() {
                    None => true,
                    Some('\\') => matches!(tail.next(), Some(')' | '|')),
                    _ => false,
                };
                if !branch_end {
                    result.push('\\');
                }
                result.push(ch);
                branch_start = false;
            }
            '(' | ')' | '+' | '?' | '|' | '{' | '}' => {
                result.push('\\');
                result.push(ch);
                branch_start = false;
            }
            _ => {
                result.push(ch);
                branch_start = false;
            }
        }
    }
    Ok(result)
}

async fn diagnostic(fds: &FdTable, context: &Context, message: &str) -> Result<(), i32> {
    if let Some(stderr) = fds.get(2) {
        stderr
            .write_all(format!("grep: {message}\n").as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}
fn io_status(error: IoError) -> i32 {
    match error {
        IoError::Cancelled => 130,
        IoError::BrokenPipe => 141,
        _ => 2,
    }
}

struct Scan<'a> {
    options: &'a Options,
    matcher: &'a Regex,
    // Prefix only for multiple input operands, as in Bashkit/GNU grep.
    filename: Option<&'a str>,
    fds: &'a FdTable,
    context: &'a Context,
    line_number: u64,
    selected: u64,
}
impl Scan<'_> {
    async fn line(&mut self, record: &[u8]) -> Result<bool, i32> {
        self.line_number += 1;
        if self.matcher.is_match(record) == self.options.invert {
            return Ok(false);
        }
        self.selected += 1;
        if self.options.quiet {
            return Ok(true);
        }
        if !self.options.count {
            self.prefix().await?;
            if self.options.numbers {
                write(
                    self.fds,
                    format!("{}:", self.line_number).as_bytes(),
                    self.context,
                )
                .await?;
            }
            write(self.fds, record, self.context).await?;
            // grep terminates even the final unterminated selected record.
            write(self.fds, b"\n", self.context).await?;
        }
        Ok(false)
    }
    async fn prefix(&self) -> Result<(), i32> {
        if let Some(filename) = self.filename {
            write(self.fds, filename.as_bytes(), self.context).await?;
            write(self.fds, b":", self.context).await?;
        }
        Ok(())
    }
    async fn input(&mut self, input: Endpoint) -> Result<(), i32> {
        let mut chunk = [0; 8192];
        let mut record = Vec::new();
        let mut budget = Budget::default();
        let limit = self.context.limits().line_bytes.min(RECORD_BYTES);
        loop {
            budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            let count = input
                .read_cancelled(&mut chunk, &self.context.cancel)
                .await
                .map_err(io_status)?;
            if count == 0 {
                if !record.is_empty() {
                    self.line(&record).await?;
                }
                break;
            }
            for &byte in &chunk[..count] {
                budget
                    .checkpoint(&self.context.cancel)
                    .await
                    .map_err(|_| 130)?;
                if byte == b'\n' {
                    if self.line(&record).await? {
                        return Ok(());
                    }
                    record.clear();
                } else {
                    if record.len() >= limit {
                        return Err(2);
                    }
                    record.push(byte);
                }
            }
        }
        if self.options.count && !self.options.quiet {
            self.prefix().await?;
            write(
                self.fds,
                format!("{}\n", self.selected).as_bytes(),
                self.context,
            )
            .await?;
        }
        Ok(())
    }
}

pub(super) async fn run(
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    let (options, pattern, mut files) = match Options::parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            diagnostic(fds, context, &error).await?;
            return Err(2);
        }
    };
    let matcher = match options.compile(&pattern) {
        Ok(matcher) => matcher,
        Err(error) => {
            diagnostic(fds, context, &error).await?;
            return Err(2);
        }
    };
    if files.is_empty() {
        files.push("-".into());
    }
    let multiple = files.len() > 1;
    let mut found = false;
    let mut failed = false;
    let mut budget = Budget::default();
    for file in files {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let input = if file == "-" {
            endpoint(fds, 0).map_err(|_| 2)
        } else {
            let path = absolute(&state.borrow().cwd, &file);
            context
                .cancel
                .run(context.fs().open(&path, &OpenOptions::default()))
                .await
                .map_err(|_| 130)?
                .map_err(io_status)
        };
        let mut scan = Scan {
            options: &options,
            matcher: &matcher,
            filename: multiple.then_some(if file == "-" {
                "(standard input)"
            } else {
                &file
            }),
            fds,
            context,
            line_number: 0,
            selected: 0,
        };
        let result = match input {
            Ok(input) => scan.input(input).await,
            Err(code) => Err(code),
        };
        match result {
            Err(code @ (130 | 141)) => return Err(code),
            Err(_) => {
                failed = true;
                diagnostic(
                    fds,
                    context,
                    &format!("{file}: read, output or record limit error"),
                )
                .await?;
            }
            Ok(()) => {}
        }
        found |= scan.selected > 0;
        // GNU quiet success takes priority over earlier input errors.
        if options.quiet && found {
            return Ok(Outcome::status(0));
        }
    }
    Ok(Outcome::status(if failed { 2 } else { i32::from(!found) }))
}
