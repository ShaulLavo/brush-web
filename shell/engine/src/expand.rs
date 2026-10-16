//! Quote-aware fields adapted from Bashkit expansion.rs at the revision pinned
//! in sources.lock.json. Protection and empty fields are structural, never data
//! sentinels. Scalar parameter operands are lazy and bounded.
//! Scalar trims use basic patterns; pathname globbing and substitutions remain unsupported.
use crate::{
    executor::{Budget, Cancel},
    state::SharedState,
};
use futures::{FutureExt, future::LocalBoxFuture};
use shell_parser::parser::{ParameterOp, Word, WordPart};

mod case;
mod operand;
mod pattern;
use std::{borrow::Cow, collections::BTreeSet};

/// Fatal parameter errors remain distinct from ordinary unsupported/limit errors.
/// The interpreter supplies the shell environment's status and diagnostic line.
pub(crate) enum Error {
    Status(i32),
    Parameter {
        name: String,
        message: String,
        line: Option<usize>,
    },
}
impl Error {
    pub(crate) fn at_line(self, line: Option<usize>) -> Self {
        match self {
            Self::Parameter { name, message, .. } => Self::Parameter {
                name,
                message,
                line,
            },
            status => status,
        }
    }
}
impl From<i32> for Error {
    fn from(code: i32) -> Self {
        Self::Status(code)
    }
}

/// Command-wide work accounting, including words that disappear and empty list
/// elements. The caller supplies source + expansion + argument capacity as the
/// step ceiling; every character, element and part also yields cooperatively.
/// Diagnostics share the remaining command field capacity with argv/declarations.
pub(crate) struct Work {
    remaining: usize,
    budget: Budget,
    parse_remaining: usize,
    storage_remaining: usize,
    fields_remaining: usize,
}
impl Work {
    pub(crate) fn new(steps: usize, storage: usize, fields: usize) -> Self {
        Self {
            remaining: steps,
            budget: Budget::default(),
            parse_remaining: steps,
            storage_remaining: storage,
            fields_remaining: fields,
        }
    }
    fn admit_storage(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.storage_remaining {
            return Err(2.into());
        }
        self.storage_remaining -= bytes;
        Ok(())
    }
    pub(crate) fn consume_scalar_field(&mut self) {
        self.fields_remaining = self.fields_remaining.saturating_sub(1);
    }
    async fn admit_parse(&mut self, bytes: usize, cancel: &Cancel) -> Result<(), Error> {
        if bytes > self.parse_remaining {
            return Err(2.into());
        }
        self.parse_remaining -= bytes;
        // Reserve cumulative parser work before its synchronous, nonrecursive
        // scalar-token call. No parser fuel/fallback is relied on for admission.
        for _ in 0..bytes.saturating_mul(8) {
            self.checkpoint(cancel).await?;
        }
        Ok(())
    }
    async fn checkpoint(&mut self, cancel: &Cancel) -> Result<(), Error> {
        if cancel.is_cancelled() {
            return Err(130.into());
        }
        if self.remaining == 0 {
            return Err(2.into());
        }
        self.remaining -= 1;
        self.budget
            .checkpoint(cancel)
            .await
            .map_err(|_| Error::Status(130))
    }
}

fn admit_string_growth(value: &mut String, bytes: usize, work: &mut Work) -> Result<(), Error> {
    let needed = value.len().checked_add(bytes).ok_or(2)?;
    if needed <= value.capacity() {
        return Ok(());
    }
    let capacity = needed.max(value.capacity().saturating_mul(2)).max(8);
    work.admit_storage(capacity - value.capacity())?;
    value
        .try_reserve_exact(capacity - value.len())
        .map_err(|_| Error::Status(2))
}

struct Ifs {
    chars: BTreeSet<char>,
}
impl Ifs {
    fn separator(state: &SharedState) -> Option<char> {
        state
            .borrow()
            .variables
            .get("IFS")
            .map_or(Some(' '), |value| value.chars().next())
    }
    async fn new(
        state: &SharedState,
        cancel: &Cancel,
        max: usize,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let value = {
            let s = state.borrow();
            let value = s
                .variables
                .get("IFS")
                .map(String::as_str)
                .unwrap_or(" \t\n");
            if value.len() > max.max(3) {
                return Err(2.into());
            }
            value.to_owned()
        };
        let mut chars = BTreeSet::new();
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            chars.insert(ch);
        }
        Ok(Self { chars })
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

#[derive(Clone, Copy)]
enum Protection {
    None,
    Spaces,
    All,
}
impl Protection {
    fn expansion(quoted: bool, state: &SharedState) -> Self {
        if quoted {
            return Self::All;
        }
        if Ifs::separator(state).is_none() {
            return Self::Spaces;
        }
        Self::None
    }
    fn protects(self, ch: char) -> bool {
        matches!(self, Self::All) || (matches!(self, Self::Spaces) && ch == ' ')
    }
}

/// Retain protection and list separators until all parameter writes finish.
/// Text and separators are bounded by raw_remaining; empty events consume Work.
/// Adjacent text with identical protection shares one allocation, including
/// the operand scanner's character-sized pieces.
enum Segment {
    Text { value: String, protected: bool },
    Empty,
    ListSeparator(char),
}
#[derive(Default)]
struct Segments {
    parts: Vec<Segment>,
    needs_split: bool,
    list_word: bool,
    split_space: bool,
    account_storage: bool,
}
impl Segments {
    fn admit_slot(&mut self, work: &mut Work) -> Result<(), Error> {
        if !self.account_storage || self.parts.len() < self.parts.capacity() {
            return Ok(());
        }
        let capacity = self.parts.capacity().saturating_mul(2).max(1);
        let bytes = (capacity - self.parts.capacity())
            .checked_mul(std::mem::size_of::<Segment>())
            .ok_or(2)?;
        work.admit_storage(bytes)?;
        self.parts
            .try_reserve_exact(capacity - self.parts.len())
            .map_err(|_| Error::Status(2))
    }
    fn character(&mut self, ch: char, protected: bool, work: &mut Work) -> Result<(), Error> {
        if let Some(Segment::Text {
            value,
            protected: previous,
        }) = self.parts.last_mut()
            && *previous == protected
        {
            if self.account_storage {
                admit_string_growth(value, ch.len_utf8(), work)?;
            }
            value.push(ch);
            return Ok(());
        }
        self.admit_slot(work)?;
        let value = if self.account_storage {
            let mut value = String::new();
            admit_string_growth(&mut value, ch.len_utf8(), work)?;
            value.push(ch);
            value
        } else {
            ch.to_string()
        };
        self.parts.push(Segment::Text { value, protected });
        Ok(())
    }
    fn empty(&mut self, work: &mut Work) -> Result<(), Error> {
        if !matches!(self.parts.last(), Some(Segment::Empty)) {
            self.admit_slot(work)?;
            self.parts.push(Segment::Empty);
        }
        Ok(())
    }
    async fn split(
        self,
        ifs: Ifs,
        max_bytes: usize,
        max_fields: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Vec<String>, Error> {
        Ok(self
            .collect(ifs, Fields::new(max_bytes, max_fields), work, cancel)
            .await?
            .out)
    }
    async fn join(
        self,
        ifs: Ifs,
        max_bytes: usize,
        max_fields: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<String, Error> {
        let mut fields = Fields::new(max_bytes, max_fields);
        fields.joined = true;
        Ok(self.collect(ifs, fields, work, cancel).await?.current)
    }
    async fn collect(
        self,
        mut ifs: Ifs,
        mut fields: Fields,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Fields, Error> {
        // @ uses spaces when the final IFS is empty. Positional unquoted *
        // expanded with empty IFS selects space splitting for the whole word.
        if !self.needs_split {
            ifs.chars.clear();
        } else if self.split_space || (self.list_word && ifs.chars.is_empty()) {
            ifs.chars.clear();
            ifs.chars.insert(' ');
        }
        fields.list_word = self.list_word;
        for part in self.parts {
            fields.segment(part, &ifs, work, cancel).await?;
        }
        fields.end_group(work)?;
        fields.join_checkpoints(work, cancel).await?;
        Ok(fields)
    }
}

/// Accumulates a single word's groups. IFS whitespace is deferred so an
/// adjacent non-whitespace delimiter consumes it as one delimiter, including
/// across segment boundaries. Empty protected segments act as text boundaries.
/// Joined diagnostics retain all text in `current`, leaving `out` unallocated;
/// their buffer growth and retained segments share Work's storage admission.
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
    count: usize,
    joined: bool,
    join_work: usize,
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
            count: 0,
            joined: false,
            join_work: 0,
        }
    }
    fn push(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.count >= self.max_fields {
            return Err(2.into());
        }
        if self.joined {
            self.start_field(work)?;
            self.join_work += 1;
        } else {
            self.out.push(std::mem::take(&mut self.current));
        }
        self.count += 1;
        self.present = false;
        Ok(())
    }
    async fn segment(
        &mut self,
        part: Segment,
        ifs: &Ifs,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let (value, protected) = match part {
            Segment::Empty => {
                work.checkpoint(cancel).await?;
                self.text_boundary(work)?;
                return self.join_checkpoints(work, cancel).await;
            }
            Segment::ListSeparator(ch) => {
                work.checkpoint(cancel).await?;
                self.character(ch, ifs.delimiter(ch), work)?;
                return self.join_checkpoints(work, cancel).await;
            }
            Segment::Text { value, protected } => (value, protected),
        };
        // Text segments are nonempty; their first character pays for entry.
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            let delimiter = if protected {
                Delimiter::Text
            } else {
                ifs.delimiter(ch)
            };
            self.character(ch, delimiter, work)?;
            self.join_checkpoints(work, cancel).await?;
        }
        Ok(())
    }
    async fn join_checkpoints(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        for _ in 0..std::mem::take(&mut self.join_work) {
            work.checkpoint(cancel).await?;
        }
        Ok(())
    }
    fn text_boundary(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.whitespace && self.present {
            self.push(work)?;
        }
        self.whitespace = false;
        self.leading = false;
        self.start_field(work)
    }
    fn start_field(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.count >= self.max_fields {
            return Err(2.into());
        }
        if self.joined && !self.present && self.count != 0 {
            self.append(' ', work)?;
        }
        self.present = true;
        Ok(())
    }
    fn character(&mut self, ch: char, delimiter: Delimiter, work: &mut Work) -> Result<(), Error> {
        match delimiter {
            Delimiter::Whitespace => self.whitespace = true,
            Delimiter::Other => self.non_whitespace(work)?,
            Delimiter::Text => self.text(ch, work)?,
        }
        Ok(())
    }
    fn non_whitespace(&mut self, work: &mut Work) -> Result<(), Error> {
        // Bash's list-word path trims leading IFS whitespace together
        // with its adjacent first delimiter. Protected empty prefixes are
        // text boundaries and have already ended the leading region.
        let trim = self.list_word && self.leading && self.whitespace;
        self.leading = false;
        self.whitespace = false;
        if !trim {
            self.push(work)?;
        }
        Ok(())
    }
    fn text(&mut self, ch: char, work: &mut Work) -> Result<(), Error> {
        self.text_boundary(work)?;
        self.append(ch, work)
    }
    fn append(&mut self, ch: char, work: &mut Work) -> Result<(), Error> {
        if ch.len_utf8() > self.max_bytes.saturating_sub(self.bytes) {
            return Err(2.into());
        }
        if self.joined {
            admit_string_growth(&mut self.current, ch.len_utf8(), work)?;
            self.join_work += 1;
        }
        self.bytes += ch.len_utf8();
        self.current.push(ch);
        Ok(())
    }
    fn end_group(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.present {
            self.push(work)?;
        }
        self.whitespace = false;
        Ok(())
    }
}

/// Selected assignment operands are captured before field splitting.
/// Quote removal belongs to operand evaluation; assignment results inherit only
/// the outer word's protection, as in Bash (unlike default/alternative results).
struct Captured {
    value: String,
    max_bytes: usize,
}
impl Captured {
    fn append(&mut self, value: &str) -> Result<(), Error> {
        if value.len() > self.max_bytes.saturating_sub(self.value.len()) {
            return Err(2.into());
        }
        self.value.push_str(value);
        Ok(())
    }
}

struct Expansion<'a> {
    segments: Segments,
    captured: Option<Captured>,
    pattern: Option<pattern::Pattern>,
    pattern_context: bool,
    // Diagnostics leave pattern syntax but retain enclosing snapshot charges.
    pattern_snapshots: bool,
    ifs: Option<Ifs>,
    ifs_changed: bool,
    work: &'a mut Work,
    cancel: &'a Cancel,
    max_raw: usize,
    /// Also bound intermediate expansion bytes, even if IFS removes them all.
    raw_remaining: usize,
    /// Empty array/positional elements consume work even when they emit no text.
    elements_remaining: usize,
}
impl Expansion<'_> {
    async fn current_ifs(&mut self, state: &SharedState) -> Result<(), Error> {
        if self.ifs.is_none() {
            self.ifs = Some(Ifs::new(state, self.cancel, self.max_raw, self.work).await?);
        }
        Ok(())
    }
    fn admit_raw(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.raw_remaining {
            return Err(2.into());
        }
        self.raw_remaining -= bytes;
        Ok(())
    }
    fn snapshot_max(&self) -> usize {
        if !self.pattern_snapshots {
            return self.raw_remaining;
        }
        self.raw_remaining
            .min(self.work.remaining)
            .min(self.work.storage_remaining)
    }
    async fn admit_pattern_snapshot(&mut self, value: &str) -> Result<(), Error> {
        if !self.pattern_snapshots {
            return Ok(());
        }
        self.work.admit_storage(value.len())?;
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        Ok(())
    }
    fn admit_pattern_length(&mut self, name: &str, state: &SharedState) -> Result<(), Error> {
        if !self.pattern_snapshots {
            return Ok(());
        }
        if !operand::length_name(name) {
            return Err(2.into());
        }
        // A nested length retains its existing counting rules. Its transient
        // input must also fit alongside the enclosing trim's snapshot.
        self.work
            .admit_storage(state.borrow().parameter(name).len())
    }
    async fn literal(
        &mut self,
        value: &str,
        state: &SharedState,
        protected: bool,
    ) -> Result<(), Error> {
        if protected || self.captured.is_some() || value.is_empty() {
            return self.segment(value, Protection::All, protected).await;
        }
        self.admit_raw(value.len())?;
        self.current_ifs(state).await?;
        let ifs = self.ifs.as_ref().ok_or(2)?;
        // Bash protects literal IFS characters when emitting them. A later
        // assignment may make a previously ordinary literal a delimiter.
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            self.segments.character(
                ch,
                !matches!(ifs.delimiter(ch), Delimiter::Text),
                self.work,
            )?;
        }
        Ok(())
    }
    async fn segment(
        &mut self,
        value: &str,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        self.admit_raw(value.len())?;
        self.emit(value, protection, keeps_empty).await
    }
    async fn emit(
        &mut self,
        value: &str,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        if let Some(pattern) = &mut self.pattern {
            self.work.checkpoint(self.cancel).await?;
            if value.is_empty() && keeps_empty {
                pattern.keep_empty();
            }
            for ch in value.chars() {
                self.work.checkpoint(self.cancel).await?;
                pattern.push(ch, protection, self.work)?;
            }
            return Ok(());
        }
        if let Some(captured) = &mut self.captured {
            self.work.checkpoint(self.cancel).await?;
            return captured.append(value);
        }
        if value.is_empty() {
            self.work.checkpoint(self.cancel).await?;
            if keeps_empty {
                self.segments.empty(self.work)?;
            }
            return Ok(());
        }
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            self.segments
                .character(ch, protection.protects(ch), self.work)?;
        }
        Ok(())
    }
    fn part<'a>(
        &'a mut self,
        part: &'a WordPart,
        state: &'a SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> LocalBoxFuture<'a, Result<(), Error>> {
        async move {
            self.segments.needs_split |= !scalar && !quoted;
            if let WordPart::ParameterExpansion {
                name,
                operator,
                operand,
                colon_variant,
            } = part
            {
                return self
                    .parameter(
                        name,
                        operator,
                        operand,
                        *colon_variant,
                        state,
                        quoted,
                        scalar,
                        depth,
                    )
                    .await;
            }
            if let WordPart::Length(name) = part {
                self.admit_pattern_length(name, state)?;
                return self.length(name, state, scalar || quoted, depth).await;
            }
            let value = scalar_value(part, state, self.snapshot_max())?;
            self.admit_pattern_snapshot(&value).await?;
            self.segment(
                &value,
                Protection::expansion(scalar || quoted, state),
                scalar || quoted,
            )
            .await
        }
        .boxed_local()
    }
    async fn length(
        &mut self,
        name: &str,
        state: &SharedState,
        protected: bool,
        depth: usize,
    ) -> Result<(), Error> {
        if !operand::length_name(name) || depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        self.work.checkpoint(self.cancel).await?;
        let (value, utf8) = {
            let s = state.borrow();
            // Admit the transient snapshot before copying, independently of the
            // much smaller decimal result. No state borrow crosses counting.
            let value = bounded(
                s.parameter(name),
                self.raw_remaining.min(self.work.remaining),
            )?;
            let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .filter_map(|name| s.variables.get(*name))
                .find(|value| !value.is_empty());
            (value, locale.is_some_and(|value| utf8_locale(value)))
        };
        let mut count = 0usize;
        for byte in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
            // Rust strings are valid UTF-8. Count each leading byte as one
            // scalar, including combining marks; C/POSIX count every byte.
            count += usize::from(!utf8 || byte & 0xc0 != 0x80);
        }
        self.segment(
            &count.to_string(),
            Protection::expansion(protected, state),
            protected,
        )
        .await
    }
    async fn parameter(
        &mut self,
        name: &str,
        operator: &ParameterOp,
        operand: &str,
        colon: bool,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> Result<(), Error> {
        if !operand::scalar_name(name) || depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        if let Some((prefix, longest)) = trim_mode(operator) {
            return self
                .trim(
                    name,
                    operand,
                    state,
                    scalar || quoted,
                    depth,
                    prefix,
                    longest,
                )
                .await;
        }
        if let Some((upper, all)) = case_mode(operator) {
            if name == "PIPESTATUS" {
                return Err(2.into());
            }
            return self
                .change_case(name, operand, state, scalar || quoted, depth, upper, all)
                .await;
        }
        let replacement = match operator {
            ParameterOp::UseDefault => false,
            ParameterOp::UseReplacement => true,
            ParameterOp::AssignDefault | ParameterOp::Error => false,
            _ => return Err(2.into()),
        };
        let absent = state
            .borrow()
            .scalar_parameter(name)
            .is_none_or(|v| colon && v.is_empty());
        if absent && matches!(operator, ParameterOp::AssignDefault | ParameterOp::Error) {
            return self
                .effect_operand(name, operator, operand, colon, state, quoted, scalar, depth)
                .await;
        }
        if replacement != absent {
            return self
                .operand(operand, state, quoted, scalar, depth + 1, false)
                .await;
        }
        let value = if replacement {
            String::new()
        } else {
            let s = state.borrow();
            bounded(
                Cow::Borrowed(s.scalar_parameter(name).unwrap_or("")),
                self.snapshot_max(),
            )?
        };
        self.admit_pattern_snapshot(&value).await?;
        self.segment(
            &value,
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
    async fn trim(
        &mut self,
        name: &str,
        source: &str,
        state: &SharedState,
        protected: bool,
        depth: usize,
        prefix: bool,
        longest: bool,
    ) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        // Resolve before operand side effects. Admit storage and work before
        // snapshotting, and release the state borrow before any suspension.
        let value = {
            let s = state.borrow();
            let value = s.scalar_parameter(name).unwrap_or("");
            let max = self.raw_remaining.min(self.work.remaining);
            if value.len() > max {
                return Err(2.into());
            }
            self.work.admit_storage(value.len())?;
            value.to_owned()
        };
        // Bash does not evaluate a trim pattern for an unset or empty scalar.
        if value.is_empty() {
            return self
                .segment("", Protection::expansion(protected, state), protected)
                .await;
        }
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        let mut pattern = self.pattern_operand(source, state, depth).await?;
        let result = pattern
            .remove(&value, prefix, longest, self.work, self.cancel)
            .await?;
        self.segment(result, Protection::expansion(protected, state), protected)
            .await
    }
    async fn pattern_operand(
        &mut self,
        source: &str,
        state: &SharedState,
        depth: usize,
    ) -> Result<pattern::Pattern, Error> {
        let capacity = self.raw_remaining;
        let mut child = Expansion {
            segments: Segments::default(),
            captured: None,
            pattern: Some(pattern::Pattern::default()),
            pattern_context: true,
            pattern_snapshots: true,
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        // A transformation pattern has its own quote context. Outer quotes protect
        // only its returned value; quotes inside protect pattern characters.
        child
            .operand(source, state, false, false, depth + 1, true)
            .await?;
        self.raw_remaining -= capacity - child.raw_remaining;
        let ifs_changed = child.ifs_changed;
        let pattern = child.pattern.take().ok_or(2)?;
        drop(child);
        self.ifs_changed |= ifs_changed;
        if ifs_changed {
            self.ifs = None;
        }
        Ok(pattern)
    }
    async fn change_case(
        &mut self,
        name: &str,
        source: &str,
        state: &SharedState,
        protected: bool,
        depth: usize,
        upper: bool,
        all: bool,
    ) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        let (value, present) = {
            let s = state.borrow();
            let parameter = s.scalar_parameter(name);
            let value = parameter.unwrap_or("");
            if value.len() > self.raw_remaining.min(self.work.remaining) {
                return Err(2.into());
            }
            self.work.admit_storage(value.len())?;
            (value.to_owned(), parameter.is_some())
        };
        if !present {
            return self
                .segment("", Protection::expansion(protected, state), protected)
                .await;
        }
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        let mut pattern = self.pattern_operand(source, state, depth).await?;
        let locale = case::Locale::from_state(state)?;
        let result = pattern
            .change_case(
                &value,
                upper,
                all,
                locale,
                self.raw_remaining,
                self.work,
                self.cancel,
            )
            .await?;
        self.segment(&result, Protection::expansion(protected, state), protected)
            .await
    }
    async fn effect_operand(
        &mut self,
        name: &str,
        operator: &ParameterOp,
        source: &str,
        colon: bool,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> Result<(), Error> {
        // Reserve target/diagnostic bytes before copying either name or value.
        let overhead = name
            .len()
            .saturating_add(if matches!(operator, ParameterOp::Error) {
                96
            } else {
                0
            });
        let max_bytes = self.raw_remaining;
        self.work.admit_storage(overhead)?;
        let capacity = max_bytes.min(self.work.storage_remaining);
        let mut child = Expansion {
            segments: Segments {
                account_storage: matches!(operator, ParameterOp::Error),
                ..Segments::default()
            },
            captured: (!matches!(operator, ParameterOp::Error)).then_some(Captured {
                value: String::new(),
                max_bytes: capacity,
            }),
            pattern: None,
            // Diagnostics leave the pattern context, including in nested operands.
            pattern_context: self.pattern_context && !matches!(operator, ParameterOp::Error),
            // Ordinary diagnostics also retain segments/output while snapshotting.
            pattern_snapshots: self.pattern_snapshots || matches!(operator, ParameterOp::Error),
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        if matches!(operator, ParameterOp::Error) {
            let value = child.diagnostic_operand(source, state, depth + 1).await?;
            self.raw_remaining -= capacity - child.raw_remaining;
            drop(child);
            let message = if source.is_empty() {
                if colon {
                    "parameter null or not set"
                } else {
                    "parameter not set"
                }
                .to_owned()
            } else {
                value
            };
            return Err(Error::Parameter {
                line: None,
                name: name.to_owned(),
                message,
            });
        }
        child
            .operand(source, state, quoted, scalar, depth + 1, false)
            .await?;
        self.raw_remaining -= capacity - child.raw_remaining;
        let ifs_changed = child.ifs_changed || name == "IFS";
        let captured = child.captured.take().ok_or(2)?;
        drop(child);
        self.work.admit_storage(captured.value.len())?;
        // A prefix frame may also retain the durable value it will restore.
        if state.borrow().prefix_saved(name) {
            self.work
                .admit_storage(name.len().saturating_add(captured.value.len()))?;
        }
        state
            .borrow_mut()
            .assign_parameter(name.to_owned(), captured.value.clone());
        self.ifs_changed |= ifs_changed;
        if ifs_changed {
            self.ifs = None;
        }
        self.emit(
            &captured.value,
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
    async fn diagnostic_operand(
        &mut self,
        source: &str,
        state: &SharedState,
        depth: usize,
    ) -> Result<String, Error> {
        // Bash expands error text independently of the surrounding context.
        // Direct literals retain whitespace; unquoted expansions split on IFS.
        if source.is_empty() {
            self.work.checkpoint(self.cancel).await?;
            return Ok(String::new());
        }
        let mut scanner = operand::Scanner::new(source, false, false, false);
        while let Some(piece) = scanner.next(self.work, self.cancel).await? {
            if let operand::Piece::Text { value, protected } = piece {
                self.literal(value, state, protected).await?;
                continue;
            }
            self.operand_piece(piece, state, false, false, depth)
                .await?;
        }
        self.current_ifs(state).await?;
        std::mem::take(&mut self.segments)
            .join(
                self.ifs.take().ok_or(2)?,
                self.max_raw,
                self.work.fields_remaining,
                self.work,
                self.cancel,
            )
            .await
    }
    async fn operand(
        &mut self,
        source: &str,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
        pattern_source: bool,
    ) -> Result<(), Error> {
        let mut scanner =
            operand::Scanner::new(source, quoted, self.pattern_context, pattern_source);
        while let Some(piece) = scanner.next(self.work, self.cancel).await? {
            self.operand_piece(piece, state, quoted, scalar, depth)
                .await?;
        }
        // An outer quoted expansion exists even when its selected operand is empty.
        self.segment("", Protection::None, scalar || quoted).await
    }
    async fn operand_piece(
        &mut self,
        piece: operand::Piece<'_>,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> Result<(), Error> {
        match piece {
            operand::Piece::Text { value, protected } => {
                self.segment(
                    value,
                    Protection::expansion(scalar || quoted || protected, state),
                    scalar || quoted || protected,
                )
                .await
            }
            operand::Piece::Expansion { part, protected } => {
                self.part(&part, state, quoted || protected, scalar, depth)
                    .await
            }
        }
    }
    async fn separator(&mut self, ch: Option<char>, protected: bool) -> Result<(), Error> {
        if let Some(ch) = ch {
            let protection = if protected {
                Protection::All
            } else {
                Protection::None
            };
            self.segment(ch.encode_utf8(&mut [0; 4]), protection, false)
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
    ) -> Result<(), Error> {
        let (count, at) = {
            let s = state.borrow();
            match part {
                WordPart::Variable(name) => (s.positional.len(), name == "@"),
                WordPart::ArrayAccess { index, .. } => (s.pipestatus.len(), index == "@"),
                _ => return Err(2.into()),
            }
        };
        if count > self.elements_remaining {
            return Err(2.into());
        }
        self.elements_remaining -= count;
        let ifs_separator = Ifs::separator(state);
        let list = !scalar && (at || !quoted);
        self.segments.needs_split |= list;
        self.segments.list_word |= list;
        self.segments.split_space |= !scalar
            && !quoted
            && !at
            && matches!(part, WordPart::Variable(_))
            && ifs_separator.is_none();
        let separator = if scalar && at {
            Some(' ')
        } else if list {
            ifs_separator.or(Some(' '))
        } else {
            ifs_separator
        };
        // Quoted '*' and every scalar context keep one field even for no values.
        if scalar || (quoted && !at) {
            self.segments.empty(self.work)?;
        }
        for index in 0..count {
            self.element_boundary(index, list, separator, quoted || scalar)
                .await?;
            let value = list_value(part, state, index, self.raw_remaining)?;
            self.segment(
                &value,
                Protection::expansion(quoted || scalar, state),
                quoted || scalar,
            )
            .await?;
        }
        Ok(())
    }
    async fn element_boundary(
        &mut self,
        index: usize,
        list: bool,
        separator: Option<char>,
        protected: bool,
    ) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        if index == 0 {
            return Ok(());
        }
        if list {
            let ch = separator.ok_or(2)?;
            self.admit_raw(ch.len_utf8())?;
            self.segments.parts.push(Segment::ListSeparator(ch));
            return Ok(());
        }
        self.separator(separator, protected).await
    }
}

fn case_mode(operator: &ParameterOp) -> Option<(bool, bool)> {
    match operator {
        ParameterOp::UpperFirst => Some((true, false)),
        ParameterOp::UpperAll => Some((true, true)),
        ParameterOp::LowerFirst => Some((false, false)),
        ParameterOp::LowerAll => Some((false, true)),
        _ => None,
    }
}

fn trim_mode(operator: &ParameterOp) -> Option<(bool, bool)> {
    match operator {
        ParameterOp::RemovePrefixShort => Some((true, false)),
        ParameterOp::RemovePrefixLong => Some((true, true)),
        ParameterOp::RemoveSuffixShort => Some((false, false)),
        ParameterOp::RemoveSuffixLong => Some((false, true)),
        _ => None,
    }
}

fn utf8_locale(locale: &str) -> bool {
    // Recognize UTF-8 codeset suffixes without scanning or copying an arbitrary
    // locale value. C/POSIX, empty and other locales use the C byte-count path.
    locale
        .get(locale.len().saturating_sub(6)..)
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".UTF-8"))
        || locale
            .get(locale.len().saturating_sub(5)..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".UTF8"))
}

fn bounded(value: Cow<'_, str>, max: usize) -> Result<String, Error> {
    if value.len() > max {
        return Err(2.into());
    }
    Ok(value.into_owned())
}
fn scalar_value(part: &WordPart, state: &SharedState, max: usize) -> Result<String, Error> {
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
        _ => return Err(2.into()),
    };
    bounded(value, max)
}
fn list_value(
    part: &WordPart,
    state: &SharedState,
    index: usize,
    max: usize,
) -> Result<String, Error> {
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
        _ => Err(2.into()),
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

async fn expand(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_bytes: usize,
    max_fields: usize,
    max_raw: usize,
    scalar: bool,
    work: &mut Work,
) -> Result<Vec<String>, Error> {
    let mut expansion = Expansion {
        segments: Segments::default(),
        captured: None,
        pattern: None,
        pattern_context: false,
        pattern_snapshots: false,
        ifs: None,
        ifs_changed: false,
        work,
        cancel,
        max_raw,
        raw_remaining: max_raw,
        elements_remaining: max_raw.saturating_add(max_fields),
    };
    if scalar {
        expansion.segments.empty(expansion.work)?;
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
        let quoted = part_quoted(word, index, has_part_quotes);
        if is_list(part) {
            expansion.elements(part, state, quoted, scalar).await?;
            continue;
        }
        if let WordPart::Literal(value) = part {
            expansion.literal(value, state, scalar || quoted).await?;
            continue;
        }
        expansion.part(part, state, quoted, scalar, 0).await?;
    }
    expansion.current_ifs(state).await?;
    let ifs = expansion.ifs.take().ok_or(2)?;
    expansion
        .segments
        .split(ifs, max_bytes, max_fields, expansion.work, cancel)
        .await
}

pub(crate) async fn fields(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_bytes: usize,
    max_fields: usize,
    max_raw: usize,
    work: &mut Work,
) -> Result<Vec<String>, Error> {
    work.fields_remaining = work.fields_remaining.min(max_fields);
    let values = expand(
        word, state, cancel, max_bytes, max_fields, max_raw, false, work,
    )
    .await?;
    work.fields_remaining = work.fields_remaining.saturating_sub(values.len());
    Ok(values)
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
) -> Result<String, Error> {
    let values = expand(word, state, cancel, max, 1, max_raw, true, work).await?;
    Ok(values.into_iter().next().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join_with_storage(storage: usize, max_fields: usize) -> Result<(Fields, usize), Error> {
        let mut work = Work::new(64, storage, max_fields);
        let mut segments = Segments {
            needs_split: true,
            account_storage: true,
            ..Segments::default()
        };
        for ch in "a:b".chars() {
            segments.character(ch, false, &mut work)?;
        }
        let mut fields = Fields::new(3, max_fields);
        fields.joined = true;
        let cancel = Cancel::new();
        let fields = segments
            .collect(
                Ifs {
                    chars: BTreeSet::from([':']),
                },
                fields,
                &mut work,
                &cancel,
            )
            .now_or_never()
            .expect("the tiny join uses fewer than 64 checkpoints")?;
        Ok((fields, work.storage_remaining))
    }

    #[test]
    fn diagnostic_join_admits_coexisting_storage_at_the_exact_boundary() {
        // One retained segment slot and both eight-byte String capacities.
        let storage = std::mem::size_of::<Segment>() + 8 + 8;
        assert!(matches!(
            join_with_storage(storage - 1, 2),
            Err(Error::Status(2))
        ));
        let (fields, remaining) = join_with_storage(storage, 2)
            .unwrap_or_else(|_| panic!("exactly admitted segment and output must fit"));
        assert_eq!(fields.current, "a b");
        assert_eq!(fields.count, 2);
        assert_eq!(
            fields.out.capacity(),
            0,
            "joined fields never allocate slots"
        );
        assert_eq!(remaining, 0);
        assert!(matches!(
            join_with_storage(storage, 1),
            Err(Error::Status(2))
        ));
    }

    #[test]
    fn diagnostic_join_yields_and_cancels_without_returning_partial_text() {
        let segments = Segments {
            parts: vec![Segment::Text {
                value: "a:".repeat(1024),
                protected: false,
            }],
            needs_split: true,
            ..Segments::default()
        };
        let cancel = Cancel::new();
        let mut work = Work::new(16_384, 8192, 2048);
        let mut join = Box::pin(segments.join(
            Ifs {
                chars: BTreeSet::from([':']),
            },
            8192,
            2048,
            &mut work,
            &cancel,
        ));
        assert!(join.as_mut().now_or_never().is_none());
        cancel.cancel();
        assert!(matches!(join.now_or_never(), Some(Err(Error::Status(130)))));
    }
}
