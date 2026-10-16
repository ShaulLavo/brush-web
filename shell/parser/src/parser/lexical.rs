//! Literal escapes are lexical metadata, separate from token text and data.

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiteralEscape {
    pub start: usize,
    pub end: usize,
    pub literal: char,
}

impl LiteralEscape {
    pub fn slice(escapes: &[Self], start: usize, end: usize) -> Vec<Self> {
        let first = escapes.partition_point(|escape| escape.start < start);
        let last = escapes.partition_point(|escape| escape.end <= end);
        escapes[first..last.max(first)]
            .iter()
            .map(|escape| Self {
                start: escape.start - start,
                end: escape.end - start,
                literal: escape.literal,
            })
            .collect()
    }

    pub fn restore(text: &str, escapes: &[Self]) -> String {
        let mut restored = String::with_capacity(text.len() + escapes.len());
        let mut cursor = 0;
        for escape in escapes {
            restored.push_str(&text[cursor..escape.start]);
            restored.push('\\');
            restored.push(escape.literal);
            cursor = escape.end;
        }
        restored.push_str(&text[cursor..]);
        restored
    }
}

/// Remap literal escapes while a lexer transformation copies ordered byte spans.
/// Inserted quote markers remain outside an escape; inserted glob quoting stays
/// inside the copied character's span. Every range is visited at most twice.
pub(crate) struct EscapeMap {
    source: Vec<LiteralEscape>,
    mapped: Vec<LiteralEscape>,
    starts: usize,
    ends: usize,
}

impl EscapeMap {
    pub fn new(escapes: &[LiteralEscape]) -> Self {
        Self {
            source: escapes.to_vec(),
            mapped: escapes.to_vec(),
            starts: 0,
            ends: 0,
        }
    }

    pub fn copied(&mut self, start: usize, end: usize, output_start: usize, output_end: usize) {
        while let Some(escape) = self.source.get(self.starts) {
            if escape.start >= end {
                break;
            }
            self.mapped[self.starts].start = output_start + escape.start - start;
            self.starts += 1;
        }
        while let Some(escape) = self.source.get(self.ends) {
            if escape.end > end {
                break;
            }
            self.mapped[self.ends].end = output_end - (end - escape.end);
            self.ends += 1;
        }
    }

    pub fn finish(self) -> Vec<LiteralEscape> {
        self.mapped
    }
}

/// Protected characters are visible to the word parser's main iterator, but
/// never to its syntax lookahead. Thus `$x\y` ends the parameter name at `x`.
#[derive(Clone)]
pub(crate) struct WordChars<'a> {
    chars: std::iter::Peekable<std::str::CharIndices<'a>>,
    escapes: &'a [LiteralEscape],
    escape: usize,
    literal: bool,
}

impl<'a> WordChars<'a> {
    pub fn new(text: &'a str, escapes: &'a [LiteralEscape]) -> Self {
        Self {
            chars: text.char_indices().peekable(),
            escapes,
            escape: 0,
            literal: false,
        }
    }

    pub fn peek(&mut self) -> Option<&char> {
        let (offset, ch) = self.chars.peek()?;
        if self
            .escapes
            .get(self.escape)
            .is_some_and(|escape| escape.start == *offset)
        {
            return None;
        }
        Some(ch)
    }

    pub fn literal(&self) -> bool {
        self.literal
    }
}

impl Iterator for WordChars<'_> {
    type Item = char;

    fn next(&mut self) -> Option<char> {
        let (offset, ch) = self.chars.next()?;
        self.literal = false;
        let Some(escape) = self
            .escapes
            .get(self.escape)
            .filter(|escape| escape.start == offset)
        else {
            return Some(ch);
        };
        while self
            .chars
            .peek()
            .is_some_and(|(offset, _)| *offset < escape.end)
        {
            self.chars.next();
        }
        self.escape += 1;
        self.literal = true;
        Some(escape.literal)
    }
}
