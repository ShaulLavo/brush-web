//! Quote-aware fields adapted from Bashkit expansion.rs at the revision pinned
//! in sources.lock.json. Protection and empty fields are structural, never data
//! sentinels. Operators, globbing and substitutions remain outside this slice.
use crate::{
    executor::{Budget, Cancel},
    state::SharedState,
};
use shell_parser::parser::{Word, WordPart};
use std::{borrow::Cow, collections::BTreeSet};

/// Command-wide work accounting, including words that disappear and empty list
/// elements. The caller supplies source + expansion + argument capacity as the
/// step ceiling; every character, element and part also yields cooperatively.
pub(crate) struct Work {
    remaining: usize,
    budget: Budget,
}
impl Work {
    pub(crate) fn new(steps: usize) -> Self {
        Self {
            remaining: steps,
            budget: Budget::default(),
        }
    }
    async fn checkpoint(&mut self, cancel: &Cancel) -> Result<(), i32> {
        if cancel.is_cancelled() {
            return Err(130);
        }
        if self.remaining == 0 {
            return Err(2);
        }
        self.remaining -= 1;
        self.budget.checkpoint(cancel).await.map_err(|_| 130)
    }
}

struct Ifs {
    chars: BTreeSet<char>,
    separator: Option<char>,
}
impl Ifs {
    async fn new(
        state: &SharedState,
        cancel: &Cancel,
        max: usize,
        work: &mut Work,
    ) -> Result<Self, i32> {
        let value = {
            let s = state.borrow();
            let value = s
                .variables
                .get("IFS")
                .map(String::as_str)
                .unwrap_or(" \t\n");
            if value.len() > max.max(3) {
                return Err(2);
            }
            value.to_owned()
        };
        let mut chars = BTreeSet::new();
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            chars.insert(ch);
        }
        Ok(Self {
            chars,
            separator: value.chars().next(),
        })
    }
    fn delimiter(&self, ch: char) -> Delimiter {
        if !self.chars.contains(&ch) {
            return Delimiter::Text;
        }
        if matches!(ch, ' ' | '\t' | '\n') {
            return Delimiter::Whitespace;
        }
        Delimiter::Other
    }
}
enum Delimiter {
    Text,
    Whitespace,
    Other,
}

/// Accumulates a single word's groups. IFS whitespace is deferred so an
/// adjacent non-whitespace delimiter consumes it as one delimiter, including
/// across segment boundaries. Empty protected segments act as text boundaries.
struct Fields {
    out: Vec<String>,
    current: String,
    present: bool,
    whitespace: bool,
    leading: bool,
    list_word: bool,
    bytes: usize,
    max_bytes: usize,
    max_fields: usize,
}
impl Fields {
    fn new(max_bytes: usize, max_fields: usize) -> Self {
        Self {
            out: Vec::new(),
            current: String::new(),
            present: false,
            whitespace: false,
            leading: true,
            list_word: false,
            bytes: 0,
            max_bytes,
            max_fields,
        }
    }
    fn push(&mut self) -> Result<(), i32> {
        if self.out.len() >= self.max_fields {
            return Err(2);
        }
        self.out.push(std::mem::take(&mut self.current));
        self.present = false;
        Ok(())
    }
    fn text_boundary(&mut self) -> Result<(), i32> {
        if self.whitespace && self.present {
            self.push()?;
        }
        self.whitespace = false;
        self.leading = false;
        if self.out.len() >= self.max_fields {
            return Err(2);
        }
        self.present = true;
        Ok(())
    }
    fn character(&mut self, ch: char, delimiter: Delimiter) -> Result<(), i32> {
        match delimiter {
            Delimiter::Whitespace => self.whitespace = true,
            Delimiter::Other => self.non_whitespace()?,
            Delimiter::Text => self.text(ch)?,
        }
        Ok(())
    }
    fn non_whitespace(&mut self) -> Result<(), i32> {
        // Bash's quoted-@ word path trims leading IFS whitespace together
        // with its adjacent first delimiter. Protected empty prefixes are
        // text boundaries and have already ended the leading region.
        let trim = self.list_word && self.leading && self.whitespace;
        self.leading = false;
        self.whitespace = false;
        if !trim {
            self.push()?;
        }
        Ok(())
    }
    fn text(&mut self, ch: char) -> Result<(), i32> {
        self.text_boundary()?;
        if ch.len_utf8() > self.max_bytes.saturating_sub(self.bytes) {
            return Err(2);
        }
        self.bytes += ch.len_utf8();
        self.current.push(ch);
        Ok(())
    }
    fn end_group(&mut self) -> Result<(), i32> {
        if self.present {
            self.push()?;
        }
        self.whitespace = false;
        Ok(())
    }
}

struct Expansion<'a> {
    fields: Fields,
    ifs: Ifs,
    work: &'a mut Work,
    cancel: &'a Cancel,
    /// Also bound intermediate expansion bytes, even if IFS removes them all.
    raw_remaining: usize,
    /// Empty array/positional elements consume work even when they emit no text.
    elements_remaining: usize,
}
impl Expansion<'_> {
    async fn segment(
        &mut self,
        value: &str,
        protected: bool,
        keeps_empty: bool,
    ) -> Result<(), i32> {
        if value.len() > self.raw_remaining {
            return Err(2);
        }
        self.raw_remaining -= value.len();
        self.work.checkpoint(self.cancel).await?;
        if keeps_empty && value.is_empty() {
            self.fields.text_boundary()?;
        }
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            let delimiter = if protected {
                Delimiter::Text
            } else {
                self.ifs.delimiter(ch)
            };
            self.fields.character(ch, delimiter)?;
        }
        Ok(())
    }
    async fn separator(&mut self, ch: Option<char>, protected: bool) -> Result<(), i32> {
        if let Some(ch) = ch {
            self.segment(ch.encode_utf8(&mut [0; 4]), protected, false)
                .await?;
        }
        Ok(())
    }
    async fn elements(
        &mut self,
        part: &WordPart,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), i32> {
        let (count, at) = {
            let s = state.borrow();
            match part {
                WordPart::Variable(name) => (s.positional.len(), name == "@"),
                WordPart::ArrayAccess { index, .. } => (s.pipestatus.len(), index == "@"),
                _ => return Err(2),
            }
        };
        if count > self.elements_remaining {
            return Err(2);
        }
        self.elements_remaining -= count;
        let groups = !scalar && ((quoted && at) || (!quoted && self.ifs.separator.is_none()));
        let separator = if scalar && at {
            Some(' ')
        } else {
            self.ifs.separator
        };
        // Quoted '*' and every scalar context keep one field even for no values.
        if scalar || (quoted && !at) {
            self.fields.text_boundary()?;
        }
        for index in 0..count {
            self.element_boundary(index, groups, separator, quoted || scalar)
                .await?;
            let value = list_value(part, state, index, self.raw_remaining)?;
            self.segment(&value, quoted || scalar, quoted || scalar)
                .await?;
        }
        Ok(())
    }
    async fn element_boundary(
        &mut self,
        index: usize,
        groups: bool,
        separator: Option<char>,
        protected: bool,
    ) -> Result<(), i32> {
        self.work.checkpoint(self.cancel).await?;
        if index == 0 {
            return Ok(());
        }
        if groups {
            return self.fields.end_group();
        }
        self.separator(separator, protected).await
    }
}

fn bounded(value: Cow<'_, str>, max: usize) -> Result<String, i32> {
    if value.len() > max {
        return Err(2);
    }
    Ok(value.into_owned())
}
fn scalar_value(part: &WordPart, state: &SharedState, max: usize) -> Result<String, i32> {
    let s = state.borrow();
    let value = match part {
        WordPart::Literal(text) => Cow::Borrowed(text.as_str()),
        WordPart::Variable(name) => s.parameter(name),
        WordPart::ArrayAccess { name, index } if name == "PIPESTATUS" => Cow::Owned(
            index
                .parse::<usize>()
                .ok()
                .and_then(|i| s.pipestatus.get(i))
                .map(i32::to_string)
                .unwrap_or_default(),
        ),
        _ => return Err(2),
    };
    bounded(value, max)
}
fn list_value(
    part: &WordPart,
    state: &SharedState,
    index: usize,
    max: usize,
) -> Result<String, i32> {
    let s = state.borrow();
    match part {
        WordPart::Variable(_) => bounded(
            Cow::Borrowed(s.positional.get(index).map(String::as_str).unwrap_or("")),
            max,
        ),
        WordPart::ArrayAccess { .. } => bounded(
            Cow::Owned(
                s.pipestatus
                    .get(index)
                    .map(i32::to_string)
                    .unwrap_or_default(),
            ),
            max,
        ),
        _ => Err(2),
    }
}
fn is_list(part: &WordPart) -> bool {
    match part {
        WordPart::Variable(name) => matches!(name.as_str(), "@" | "*"),
        WordPart::ArrayAccess { name, index } => {
            name == "PIPESTATUS" && matches!(index.as_str(), "@" | "*")
        }
        _ => false,
    }
}

fn part_quoted(word: &Word, index: usize, has_part_quotes: bool) -> bool {
    if has_part_quotes {
        return word.part_quoted.get(index).copied().unwrap_or(false);
    }
    word.quoted
}

fn is_at(part: &WordPart) -> bool {
    match part {
        WordPart::Variable(name) => name == "@",
        WordPart::ArrayAccess { name, index } => name == "PIPESTATUS" && index == "@",
        _ => false,
    }
}

async fn expand(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_bytes: usize,
    max_fields: usize,
    max_raw: usize,
    scalar: bool,
    work: &mut Work,
) -> Result<Vec<String>, i32> {
    let mut expansion = Expansion {
        fields: Fields::new(max_bytes, max_fields),
        ifs: Ifs::new(state, cancel, max_raw, work).await?,
        work,
        cancel,
        raw_remaining: max_raw,
        elements_remaining: max_raw.saturating_add(max_fields),
    };
    if scalar {
        expansion.fields.text_boundary()?;
    }
    // QuotedWord tokens set Word.quoted after parsing their unmarked text, so
    // an all-false part vector is not an override of whole-word quoting.
    // Bashkit uses per-part flags only when at least one flag is true.
    let mut has_part_quotes = false;
    for &quoted in &word.part_quoted {
        expansion.work.checkpoint(cancel).await?;
        if quoted {
            has_part_quotes = true;
            break;
        }
    }
    for (index, part) in word.parts.iter().enumerate() {
        expansion.work.checkpoint(cancel).await?;
        if part_quoted(word, index, has_part_quotes) && is_at(part) && !scalar {
            expansion.fields.list_word = true;
            break;
        }
    }
    for (index, part) in word.parts.iter().enumerate() {
        expansion.work.checkpoint(cancel).await?;
        let quoted = part_quoted(word, index, has_part_quotes);
        if is_list(part) {
            expansion.elements(part, state, quoted, scalar).await?;
            continue;
        }
        let literal = matches!(part, WordPart::Literal(_));
        let value = scalar_value(part, state, expansion.raw_remaining)?;
        expansion
            .segment(&value, scalar || literal || quoted, scalar || quoted)
            .await?;
    }
    expansion.fields.end_group()?;
    Ok(expansion.fields.out)
}

pub(crate) async fn fields(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_bytes: usize,
    max_fields: usize,
    max_raw: usize,
    work: &mut Work,
) -> Result<Vec<String>, i32> {
    expand(
        word, state, cancel, max_bytes, max_fields, max_raw, false, work,
    )
    .await
}

/// Assignments and redirects are scalar contexts, distinct from argv fields.
/// '$@' joins with spaces here; '$*' uses the first IFS character.
pub(crate) async fn word(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    max_raw: usize,
    work: &mut Work,
) -> Result<String, i32> {
    let values = expand(word, state, cancel, max, 1, max_raw, true, work).await?;
    Ok(values.into_iter().next().unwrap_or_default())
}
