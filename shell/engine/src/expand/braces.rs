//! Original structural brace expansion. Shell parts stay opaque and borrowed:
//! only unquoted source literal characters can be delimiters. No private Unicode
//! placeholders or recursive AST clones are used.
use super::{Cancel, Error, Word, Work, admit_string_growth, admit_vec_slot};
use std::borrow::Cow;

enum Piece<'a> {
    Source(&'a str),
    Text(Cow<'a, str>, bool),
}
impl Piece<'_> {
    fn character(&self) -> Option<char> {
        match self {
            Self::Source(value) if value.len() == 1 => value.chars().next(),
            _ => None,
        }
    }
    fn duplicate(&self, work: &mut Work) -> Result<Self, Error> {
        Ok(match self {
            Self::Source(value) => Self::Source(value),
            Self::Text(Cow::Owned(value), quoted) => {
                work.admit_storage(value.len())?;
                Self::Text(Cow::Owned(value.clone()), *quoted)
            }
            Self::Text(Cow::Borrowed(value), quoted) => Self::Text(Cow::Borrowed(value), *quoted),
        })
    }
}

async fn copy<'a>(
    to: &mut Vec<Piece<'a>>,
    from: &[Piece<'a>],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    for piece in from {
        work.checkpoint(cancel).await?;
        admit_vec_slot(to, work)?;
        to.push(piece.duplicate(work)?);
    }
    Ok(())
}

fn number(value: &str) -> Option<i64> {
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

struct Range {
    start: i64,
    end: i64,
    step: u64,
    numeric: bool,
    width: usize,
    count: u128,
}
fn range(source: &str) -> Option<Range> {
    let mut fields = source.split("..");
    let left = fields.next()?;
    let right = fields.next()?;
    let step = fields.next();
    if fields.next().is_some() {
        return None;
    }
    let numeric = number(left).is_some() && number(right).is_some();
    let (start, end) = if numeric {
        (number(left)?, number(right)?)
    } else if left.len() == 1
        && right.len() == 1
        && left.as_bytes()[0].is_ascii_alphabetic()
        && right.as_bytes()[0].is_ascii_alphabetic()
    {
        (left.as_bytes()[0] as i64, right.as_bytes()[0] as i64)
    } else {
        return None;
    };
    let step = step.map(number).unwrap_or(Some(1))?.unsigned_abs().max(1);
    let count = (end as i128 - start as i128).unsigned_abs() / step as u128 + 1;
    // Bash only recognizes a literal leading zero, optionally after '-'.
    // A '+' prefix never requests padding.
    let padded = [left, right].iter().any(|value| {
        let digits = value.strip_prefix('-').unwrap_or(value);
        digits.len() > 1 && digits.starts_with('0')
    });
    Some(Range {
        start,
        end,
        step,
        numeric,
        width: if padded {
            left.len().max(right.len())
        } else {
            0
        },
        count,
    })
}

async fn alternatives<'a>(
    body: &[Piece<'a>],
    limit: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<Vec<Vec<Piece<'a>>>>, Error> {
    let mut depth = 0usize;
    let mut start = 0;
    let mut commas = Vec::new();
    for (index, piece) in body.iter().enumerate() {
        work.checkpoint(cancel).await?;
        match piece.character() {
            Some('{') => depth += 1,
            Some('}') => depth = depth.saturating_sub(1),
            Some(',') if depth == 0 => {
                admit_vec_slot(&mut commas, work)?;
                commas.push(index);
            }
            _ => {}
        }
    }
    if !commas.is_empty() {
        if commas.len() >= limit {
            return Err(2.into());
        }
        let mut result = Vec::new();
        for end in commas.into_iter().chain(std::iter::once(body.len())) {
            work.checkpoint(cancel).await?;
            let mut alternative = Vec::new();
            copy(&mut alternative, &body[start..end], work, cancel).await?;
            admit_vec_slot(&mut result, work)?;
            result.push(alternative);
            start = end + 1;
        }
        return Ok(Some(result));
    }
    let mut source = String::new();
    for piece in body {
        work.checkpoint(cancel).await?;
        if matches!(piece, Piece::Text(Cow::Borrowed("\\\n"), false)) {
            continue;
        }
        let Piece::Source(value) = piece else {
            return Ok(None);
        };
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            admit_string_growth(&mut source, ch.len_utf8(), work)?;
            source.push(ch);
        }
    }
    let Some(range) = range(&source) else {
        return Ok(None);
    };
    if range.count > limit as u128 {
        return Err(2.into());
    }
    let mut result = Vec::new();
    for index in 0..range.count as usize {
        work.checkpoint(cancel).await?;
        let offset = index as i128 * range.step as i128;
        let value = if range.start <= range.end {
            range.start as i128 + offset
        } else {
            range.start as i128 - offset
        };
        let text = if range.numeric {
            let value = value as i64;
            // Exact formatting scratch is admitted before formatting. The sign
            // is part of Bash's padding width, not an extra character.
            let digits = value.unsigned_abs().checked_ilog10().unwrap_or(0) as usize + 1;
            let length = range.width.max(digits + usize::from(value < 0));
            work.admit_storage(length)?;
            format!("{value:0width$}", width = range.width)
        } else {
            work.admit_storage(1)?;
            // Bash's sequence formatter emits an empty word for the backslash
            // code point between Z and a. It remains present through splitting.
            if value == i128::from(b'\\') {
                String::new()
            } else {
                (value as u8 as char).to_string()
            }
        };
        let mut item = Vec::new();
        admit_vec_slot(&mut item, work)?;
        let keep_empty = !range.numeric && text.is_empty();
        item.push(Piece::Text(Cow::Owned(text), keep_empty));
        admit_vec_slot(&mut result, work)?;
        result.push(item);
    }
    Ok(Some(result))
}

async fn group<'a>(
    parts: &mut [Piece<'a>],
    limit: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<(usize, usize, Vec<Vec<Piece<'a>>>)>, Error> {
    for open in 0..parts.len() {
        work.checkpoint(cancel).await?;
        if parts[open].character() != Some('{') {
            continue;
        }
        let mut depth = 0usize;
        let mut close = None;
        for (index, piece) in parts.iter().enumerate().skip(open) {
            work.checkpoint(cancel).await?;
            match piece.character() {
                Some('{') => depth += 1,
                Some('}') => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else {
            parts[open] = Piece::Text(Cow::Borrowed("{"), false);
            continue;
        };
        if let Some(items) = alternatives(&parts[open + 1..close], limit, work, cancel).await? {
            return Ok(Some((open, close, items)));
        }
        // An invalid enclosing group is source text, not another expansion
        // opportunity after its children expand (`{{1..2}..3}`).
        parts[open] = Piece::Text(Cow::Borrowed("{"), false);
        parts[close] = Piece::Text(Cow::Borrowed("}"), false);
    }
    Ok(None)
}

#[derive(Clone, Copy)]
enum Frame {
    Quote(char),
    AnsiQuote,
    Group(char),
}

async fn dollar_opener(
    source: &str,
    mut after: usize,
    allow_ansi: bool,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<(usize, char)>, Error> {
    // A continuation disappears before recognizing `${`, `$(` or `$'`.
    // Preserve its raw bytes in the borrowed opaque span for later lexing.
    while source[after..].starts_with("\\\n") {
        work.checkpoint(cancel).await?;
        after += 2;
    }
    Ok(source.as_bytes().get(after).and_then(|byte| {
        (matches!(byte, b'{' | b'(') || allow_ansi && *byte == b'\'')
            .then_some((after, *byte as char))
    }))
}

/// Reuse the parser's command-boundary grammar for comments, heredocs, case
/// patterns, quotes and nested substitutions. Feeding it is iterative; no
/// command AST is built and no substitution is executed.
async fn command_end(
    source: &str,
    after_open: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    use shell_parser::parser::{CommandBoundaryScanner, CommandBoundaryStep};

    // Initial frame/parens/code-state vectors are allocated by `new`.
    work.admit_storage(std::mem::size_of::<CommandBoundaryScanner>().saturating_add(512))?;
    let mut scanner = CommandBoundaryScanner::new();
    let mut chars = source[after_open..].chars();
    let mut finished = false;
    loop {
        work.checkpoint(cancel).await?;
        let (ch, replay) = if scanner.has_pending() {
            (scanner.pending_char(), true)
        } else if let Some(ch) = chars.next() {
            (Some(ch), false)
        } else if !finished {
            finished = true;
            (None, false)
        } else {
            break;
        };
        // The raw tape and literal buffers grow with text. Structural steps
        // also admit frame/case/heredoc vectors and fallback-opener storage.
        // Replayed characters and EOF frame unwinds pay the same admission.
        let structural =
            ch.is_none_or(|ch| ch.is_whitespace() || matches!(ch, '$' | '(' | ')' | '<' | '>'));
        work.admit_storage(16 + usize::from(structural) * 512)?;
        let step = if replay {
            scanner.resume()
        } else if let Some(ch) = ch {
            scanner.feed(ch)
        } else {
            scanner.finish()
        };
        match step {
            CommandBoundaryStep::Close => return Ok(after_open + scanner.offset()),
            CommandBoundaryStep::Limit => return Err(Error::Status(2)),
            CommandBoundaryStep::Body => {}
        }
    }
    Ok(source.len())
}

async fn opaque_end(
    source: &str,
    start: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    let mut chars = source[start..].char_indices().peekable();
    let (_, first) = chars.next().ok_or(2)?;
    let mut frames = Vec::new();
    admit_vec_slot(&mut frames, work)?;
    if first == '$' {
        let (open_index, open) = dollar_opener(source, start + 1, true, work, cancel)
            .await?
            .ok_or(2)?;
        if open == '(' {
            return command_end(source, open_index + 1, work, cancel).await;
        }
        while chars
            .peek()
            .is_some_and(|(index, _)| start + *index <= open_index)
        {
            chars.next();
            work.checkpoint(cancel).await?;
        }
        frames.push(if open == '\'' {
            Frame::AnsiQuote
        } else {
            Frame::Group('}')
        });
    } else {
        frames.push(Frame::Quote(first));
    }
    while let Some((index, ch)) = chars.next() {
        work.checkpoint(cancel).await?;
        let frame = *frames.last().ok_or(2)?;
        if matches!(frame, Frame::AnsiQuote) {
            // ANSI-C escapes stay raw until the word lexer decodes them.
            if ch == '\\' {
                if chars.next().is_some() {
                    work.checkpoint(cancel).await?;
                }
            } else if ch == '\'' {
                frames.pop();
            }
        } else if matches!(frame, Frame::Quote('\'')) {
            if ch == '\'' {
                frames.pop();
            }
        } else if ch == '\\' {
            if chars.next().is_some() {
                work.checkpoint(cancel).await?;
            }
        } else if matches!(frame, Frame::Quote(quote) if quote == ch) {
            frames.pop();
        } else if ch == '$'
            && let Some((open_index, open)) = dollar_opener(
                source,
                start + index + 1,
                !matches!(frame, Frame::Quote('"')),
                work,
                cancel,
            )
            .await?
        {
            while chars
                .peek()
                .is_some_and(|(index, _)| start + *index <= open_index)
            {
                chars.next();
                work.checkpoint(cancel).await?;
            }
            if open == '(' {
                let end = command_end(source, open_index + 1, work, cancel).await?;
                while chars.peek().is_some_and(|(index, _)| start + *index < end) {
                    chars.next();
                    work.checkpoint(cancel).await?;
                }
            } else {
                admit_vec_slot(&mut frames, work)?;
                frames.push(if open == '\'' {
                    Frame::AnsiQuote
                } else {
                    Frame::Group('}')
                });
            }
        } else if let Frame::Group(close) = frame {
            if ch == close {
                frames.pop();
            } else if matches!((ch, close), ('{', '}') | ('(', ')')) {
                admit_vec_slot(&mut frames, work)?;
                frames.push(Frame::Group(close));
            } else if matches!(ch, '\'' | '"' | '`') {
                admit_vec_slot(&mut frames, work)?;
                frames.push(Frame::Quote(ch));
            }
        } else if ch == '`' && matches!(frame, Frame::Quote('"')) {
            admit_vec_slot(&mut frames, work)?;
            frames.push(Frame::Quote(ch));
        }
        if frames.is_empty() {
            return Ok(start + index + ch.len_utf8());
        }
    }
    // Initial parsing already rejected incomplete shell constructs. A brace
    // scanner never invents a second parser error or turns their contents into
    // brace syntax when a raw spelling is intentionally partial.
    Ok(source.len())
}

pub(super) async fn variants(
    word: &Word,
    limit: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<Vec<String>>, Error> {
    let Some(source) = word.raw.as_deref() else {
        return Ok(None);
    };
    // A word without any opening brace needs no scanner frame allocation.
    let mut has_open = false;
    for byte in source.bytes() {
        work.checkpoint(cancel).await?;
        if byte == b'{' {
            has_open = true;
            break;
        }
    }
    if !has_open {
        return Ok(None);
    }
    // Ordinary words need neither a piece vector nor a second owned spelling.
    let mut found = false;
    let mut scan = 0;
    while scan < source.len() {
        work.checkpoint(cancel).await?;
        let ch = source[scan..].chars().next().ok_or(2)?;
        if matches!(ch, '\'' | '"' | '`')
            || ch == '$'
                && dollar_opener(source, scan + 1, true, work, cancel)
                    .await?
                    .is_some()
        {
            scan = opaque_end(source, scan, work, cancel).await?;
        } else if ch == '\\' {
            scan += 1 + source[scan + 1..].chars().next().map_or(0, char::len_utf8);
        } else {
            found |= ch == '{';
            scan += ch.len_utf8();
        }
    }
    if !found {
        return Ok(None);
    }
    let mut pieces = Vec::new();
    let mut cursor = 0;
    let mut has_braces = false;
    while cursor < source.len() {
        work.checkpoint(cancel).await?;
        let ch = source[cursor..].chars().next().ok_or(2)?;
        let opaque = matches!(ch, '\'' | '"' | '`')
            || ch == '$'
                && dollar_opener(source, cursor + 1, true, work, cancel)
                    .await?
                    .is_some();
        let mut end = if opaque {
            opaque_end(source, cursor, work, cancel).await?
        } else if ch == '\\' {
            let mut chars = source[cursor + 1..].chars();
            cursor + 1 + chars.next().map_or(0, char::len_utf8)
        } else {
            cursor + ch.len_utf8()
        };
        // Only delimiters need individual pieces. Borrow ordinary literal runs
        // as one source span rather than allocating a slot for every byte.
        if !opaque && !matches!(ch, '\\' | '{' | '}' | ',') {
            while end < source.len() {
                work.checkpoint(cancel).await?;
                let next = source[end..].chars().next().ok_or(2)?;
                if matches!(next, '\\' | '{' | '}' | ',' | '\'' | '"' | '`' | '$') {
                    break;
                }
                end += next.len_utf8();
            }
        }
        admit_vec_slot(&mut pieces, work)?;
        if opaque || ch == '\\' {
            pieces.push(Piece::Text(Cow::Borrowed(&source[cursor..end]), false));
        } else {
            has_braces |= ch == '{';
            pieces.push(Piece::Source(&source[cursor..end]));
        }
        cursor = end;
    }
    if !has_braces {
        return Ok(None);
    }
    let mut variants = Vec::new();
    admit_vec_slot(&mut variants, work)?;
    variants.push(pieces);
    let mut expanded = false;
    loop {
        let mut changed = false;
        let mut next = Vec::new();
        for mut pieces in variants {
            work.checkpoint(cancel).await?;
            if let Some((open, close, items)) = group(&mut pieces, limit, work, cancel).await? {
                changed = true;
                expanded = true;
                for item in items {
                    work.checkpoint(cancel).await?;
                    if next.len() >= limit {
                        return Err(2.into());
                    }
                    let mut replacement = Vec::new();
                    copy(&mut replacement, &pieces[..open], work, cancel).await?;
                    for piece in item {
                        work.checkpoint(cancel).await?;
                        admit_vec_slot(&mut replacement, work)?;
                        replacement.push(piece);
                    }
                    copy(&mut replacement, &pieces[close + 1..], work, cancel).await?;
                    admit_vec_slot(&mut next, work)?;
                    next.push(replacement);
                }
            } else {
                if next.len() >= limit {
                    return Err(2.into());
                }
                admit_vec_slot(&mut next, work)?;
                next.push(pieces);
            }
        }
        variants = next;
        if !changed {
            break;
        }
    }
    if !expanded {
        return Ok(None);
    }
    let mut result = Vec::new();
    for variant in variants {
        let mut raw = String::new();
        let mut variant = variant.into_iter().peekable();
        while let Some(piece) = variant.next() {
            let value = match &piece {
                Piece::Source(value) => *value,
                Piece::Text(_, true) => "''",
                Piece::Text(Cow::Owned(value), _) if value == "`" && variant.peek().is_none() => {
                    "\\`"
                }
                Piece::Text(value, _) => value.as_ref(),
            };
            for ch in value.chars() {
                work.checkpoint(cancel).await?;
                admit_string_growth(&mut raw, ch.len_utf8(), work)?;
                raw.push(ch);
            }
        }
        admit_vec_slot(&mut result, work)?;
        result.push(raw);
    }
    Ok(Some(result))
}
