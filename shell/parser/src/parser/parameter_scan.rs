//! Incremental boundaries for raw nested scalar parameters. Callers own their
//! work/cancellation checks and substitution scanners; no input is buffered here.

/// Only brackets in the target are subscripts. Operand operators select whether
/// apostrophes are real quotes even inside an outer double-quoted parameter.
#[derive(Clone, Copy, Default)]
pub(crate) struct ParameterHeader {
    name_started: bool,
    operand: bool,
    pub(crate) single_quotes: bool,
    pub(crate) subscript: usize,
}
impl ParameterHeader {
    pub(crate) fn nested(&self) -> Self {
        Self {
            single_quotes: self.single_quotes,
            ..Self::default()
        }
    }

    pub(crate) fn character(&mut self, ch: char) {
        if self.subscript > 0 {
            match ch {
                '[' => self.subscript += 1,
                ']' => self.subscript -= 1,
                _ => {}
            }
            return;
        }
        if self.operand {
            return;
        }
        match ch {
            '[' if self.name_started => self.subscript = 1,
            ch if ch.is_ascii_alphanumeric() || ch == '_' => self.name_started = true,
            '#' | '!' if !self.name_started => {}
            '@' | '*' | '?' | '-' | '$' if !self.name_started => self.name_started = true,
            _ => {
                self.operand = true;
                self.single_quotes |= matches!(ch, '/' | '#' | '%' | '^' | ',');
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Frame {
    header: ParameterHeader,
    quote: Option<char>,
    outer_quoted: bool,
    pattern: bool,
}

/// An action after a raw character. Escape/Open/Command ask the caller to
/// consume one additional character (or the entire opaque command body).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Copy,
    Escape,
    Open,
    Command,
    Closed,
    Limit,
}

/// Fixed-capacity state, including the enclosing parameter in the depth limit.
/// Construct immediately after `${`; bare `{` never opens another frame.
pub struct ParameterScan<const N: usize> {
    frames: [Frame; N],
    depth: usize,
}
impl<const N: usize> ParameterScan<N> {
    pub fn new(outer_quoted: bool, pattern: bool) -> Self {
        assert!(N > 0);
        let mut frames = [Frame::default(); N];
        frames[0].outer_quoted = outer_quoted;
        frames[0].pattern = pattern;
        Self { frames, depth: 1 }
    }

    pub fn feed(&mut self, ch: char, next: Option<char>) -> Step {
        let frame = &mut self.frames[self.depth - 1];
        let single = frame.quote == Some('\'');
        let literal_single =
            single && (!frame.outer_quoted || frame.pattern || frame.header.single_quotes);
        if ch == '\0' || ch == '\\' && !literal_single && !(single && next == Some('\'')) {
            return Step::Escape;
        }
        if frame.quote == Some(ch) {
            frame.quote = None;
            return Step::Copy;
        }
        if literal_single {
            return Step::Copy;
        }
        if frame.quote.is_none() {
            frame.header.character(ch);
            if matches!(ch, '\'' | '"') {
                frame.quote = Some(ch);
                return Step::Copy;
            }
        }
        if ch == '$' {
            if next == Some('(') {
                return Step::Command;
            }
            if next == Some('{') {
                if self.depth == N {
                    return Step::Limit;
                }
                self.frames[self.depth] = Frame {
                    outer_quoted: frame.outer_quoted || frame.quote == Some('"'),
                    pattern: frame.pattern || frame.header.single_quotes,
                    ..Frame::default()
                };
                self.depth += 1;
                return Step::Open;
            }
        }
        if ch == '}' && frame.quote.is_none() {
            self.depth -= 1;
            if self.depth == 0 {
                return Step::Closed;
            }
        }
        Step::Copy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary(source: &str) -> usize {
        let mut scanner = ParameterScan::<32>::new(true, false);
        let mut chars = source.char_indices().peekable();
        while let Some((index, ch)) = chars.next() {
            match scanner.feed(ch, chars.peek().map(|(_, ch)| *ch)) {
                Step::Copy => {}
                Step::Escape | Step::Open => {
                    chars.next().unwrap();
                }
                Step::Closed => return index + ch.len_utf8(),
                other => panic!("unexpected {other:?}: {source}"),
            }
        }
        panic!("missing boundary: {source}");
    }

    #[test]
    fn nested_replacement_boundaries() {
        for source in [
            "u:-${v/b/{}}",
            "u:-${v/b/'$(x'}}",
            "v/b/${w/y/'$(x'}}",
            "v/b/${w/y/{}}",
            "v/b/${u:-'$(x'}}",
            "u:-'${x}'}",
        ] {
            assert_eq!(boundary(&format!("{source}tail")), source.len(), "{source}");
        }
    }

    #[test]
    fn enclosing_parameter_counts_toward_depth_limit() {
        let mut scanner = ParameterScan::<1>::new(true, false);
        assert_eq!(scanner.feed('$', Some('{')), Step::Limit);
        let mut scanner = ParameterScan::<1>::new(true, false);
        assert_eq!(scanner.feed('{', Some('}')), Step::Copy);
        assert_eq!(scanner.feed('}', None), Step::Closed);
    }
}
