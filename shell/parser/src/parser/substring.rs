//! Original substring shell-word validation. This is syntax checking only:
//! neither pass executes the process-substitution lookalikes in arithmetic.
use super::parameter_scan::{ParameterScan, Step};
use super::subst_scan::{Step as CommandStep, SubstScanner};
use super::{HARD_MAX_AST_DEPTH, Parser, WordChars};
use crate::error::{Error, Result};

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
                self.read_parameter_command(&mut chars)?;
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
                self.read_parameter_command(chars)?;
                Ok(false)
            }
            Step::Limit => Err(self.error("AST nesting too deep in parameter")),
            _ => Ok(false),
        }
    }

    fn read_parameter_command(&self, chars: &mut WordChars<'_>) -> Result<()> {
        let body = self.parameter_command_body(chars)?;
        if body.starts_with('(') {
            return Ok(());
        }
        self.validate_parameter_command(body)
    }

    fn parameter_command_body<'a>(&self, chars: &mut WordChars<'a>) -> Result<&'a str> {
        let source = chars.remaining();
        let mut scanner = SubstScanner::new();
        let mut end = None;
        for (index, c) in source.char_indices() {
            self.tick()?;
            if index > 4096 {
                return Err(self.error("parser fuel exhausted in parameter command"));
            }
            if scanner.feed(c) == CommandStep::Close {
                end = Some(index);
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
        Ok(&source[..end])
    }

    #[inline(never)]
    fn validate_parameter_command(&self, body: &str) -> Result<()> {
        self.tick_units(body.len())?;
        if self.current_depth >= self.max_depth {
            return Err(self.error("AST nesting too deep in parameter command"));
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
        parser.execution_budget = self.execution_budget.clone();
        let result = parser.parse_inner();
        self.fuel.set(parser.fuel.get());
        match result {
            Ok(_) => Ok(()),
            Err(error) if Self::is_parser_budget_error(&error) => Err(error),
            Err(_) => Err(Error::ShellWord {
                line: self.current_span.start.line,
            }),
        }
    }
}
