//! Original substring shell-word validation. This is syntax checking only:
//! neither pass executes the process-substitution lookalikes in arithmetic.
use super::parameter_scan::{ParameterScan, Step};
use super::subst_scan::{Step as CommandStep, SubstScanner};
use super::{HARD_MAX_AST_DEPTH, Parser, WordChars};
use crate::error::{Error, Result};
use crate::limits::LimitExceeded;

impl Parser<'_> {
    /// Validate while the complete word is read, before lazy operands or
    /// command conditions can skip it. Arithmetic text is kept opaque by the
    /// ordinary word parser, so its slices reach only the expansion pass.
    pub(super) fn validate_parameter_shell_boundaries(
        &self,
        chars: &WordChars<'_>,
        outer_quoted: bool,
        pattern: bool,
    ) -> Result<()> {
        if !self.parameter_word_boundaries {
            return Ok(());
        }
        let mut chars = chars.clone();
        if !chars.remaining().contains(['<', '>']) {
            return Ok(());
        }
        let mut scanner = ParameterScan::<HARD_MAX_AST_DEPTH>::with_limit(
            outer_quoted,
            pattern,
            self.max_depth.saturating_sub(self.current_depth),
        );
        let mut angle = false;
        while let Some(c) = chars.next() {
            self.tick()?;
            if chars.literal() {
                angle = false;
                continue;
            }
            angle = matches!(c, '<' | '>') && !angle;
            if angle && scanner.substring_unquoted() && chars.peek() == Some(&'(') {
                chars.next();
                self.read_parameter_command(&mut chars, true)?;
                angle = false;
                continue;
            }
            if self.parameter_boundary_step(&mut scanner, &mut chars, c)? {
                return Ok(());
            }
        }
        Ok(())
    }

    fn parameter_boundary_step(
        &self,
        scanner: &mut ParameterScan<HARD_MAX_AST_DEPTH>,
        chars: &mut WordChars<'_>,
        c: char,
    ) -> Result<bool> {
        match scanner.feed(c, chars.peek().copied()) {
            Step::Closed => Ok(true),
            Step::Escape | Step::Open => {
                chars.next();
                Ok(false)
            }
            Step::Command => {
                chars.next();
                self.read_parameter_command(chars, false)?;
                Ok(false)
            }
            Step::Limit => Err(self.limit_error(LimitExceeded::ParameterBoundaryDepth)),
            _ => Ok(false),
        }
    }

    fn read_parameter_command(&self, chars: &mut WordChars<'_>, process: bool) -> Result<()> {
        // Bash never parses a `$((` span as commands before it expands.
        let (body, fused) = self.parameter_command_body(chars, process)?;
        if fused {
            return Ok(());
        }
        self.validate_parameter_command(body)
    }

    fn parameter_command_body<'a>(
        &self,
        chars: &mut WordChars<'a>,
        process: bool,
    ) -> Result<(&'a str, bool)> {
        let source = chars.remaining();
        let mut scanner = if process {
            SubstScanner::new_command()
        } else {
            SubstScanner::new()
        };
        let mut end = None;
        for c in source.chars() {
            self.tick()?;
            if scanner.offset() > 4096 {
                return Err(self.limit_error(LimitExceeded::ParameterCommandFuel));
            }
            if scanner.feed(c) == CommandStep::Close {
                end = Some(scanner.offset() - 1);
                break;
            }
        }
        let end = end.ok_or(Error::ShellWord {
            line: self.current_span.start.line,
        })?;
        while chars.remaining().len() >= source.len() - end {
            self.tick()?;
            chars.next();
        }
        Ok((&source[..end], scanner.arithmetic_start().is_some()))
    }

    #[inline(never)]
    fn validate_parameter_command(&self, body: &str) -> Result<()> {
        self.tick_units(body.len())?;
        if self.current_depth >= self.max_depth {
            return Err(self.limit_error(LimitExceeded::ParameterCommandDepth));
        }
        let mut parser = Box::new(Parser::with_limits_timeout_options(
            body,
            self.max_depth,
            self.fuel.get(),
            self.timeout,
            Default::default(),
        ));
        parser.strict_command_separators = true;
        parser.current_depth = self.current_depth + 1;
        parser.started_at = self.started_at;
        if let Some(budget) = &self.execution_budget {
            parser.attach_execution_budget(budget.clone());
        }
        let result = parser.parse_inner();
        self.fuel.set(parser.fuel.get());
        match result {
            Ok(_) => Ok(()),
            Err(error @ Error::ResourceLimit(_)) => Err(error),
            Err(_) => Err(Error::ShellWord {
                line: self.current_span.start.line,
            }),
        }
    }
}
