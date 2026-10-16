//! Scalar trim rules adapted from Bashkit expansion.rs::remove_pattern{,_glob}
//! and glob.rs::glob_match_steps at the pinned revision in sources.lock.json.
//! This matcher advances all basic-glob states over borrowed character slices.
//! It allocates no candidate strings and never treats exhausted work as a miss.
use super::{Error, Protection, Work, admit_string_growth, case};
use crate::executor::Cancel;
use std::mem::size_of;

#[derive(Clone, Copy)]
struct Character {
    value: char,
    protected: bool,
    escaped_protected: bool,
}

#[derive(Default)]
pub(super) struct Pattern {
    chars: Vec<Character>,
    quoted_empty: bool,
}
impl Pattern {
    pub(super) fn keep_empty(&mut self) {
        self.quoted_empty = true;
    }
    pub(super) fn push(
        &mut self,
        value: char,
        protection: Protection,
        work: &mut Work,
    ) -> Result<(), Error> {
        admit_element(&mut self.chars, work)?;
        self.chars.push(Character {
            value,
            protected: protection.protects(value),
            escaped_protected: false,
        });
        Ok(())
    }
    fn active(&self, index: usize, value: char) -> bool {
        self.chars
            .get(index)
            .is_some_and(|ch| ch.value == value && !ch.protected)
    }
    async fn normalize(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        // Backslashes introduced by an unquoted variable are pattern escapes.
        // Source escapes have already been removed and structurally protected.
        let mut read = 0;
        let mut write = 0;
        while read < self.chars.len() {
            work.checkpoint(cancel).await?;
            let escape = self.active(read, '\\') && read + 1 < self.chars.len();
            read += usize::from(escape);
            let mut ch = self.chars[read];
            ch.escaped_protected = escape && ch.protected;
            ch.protected |= escape;
            self.chars[write] = ch;
            read += 1;
            write += 1;
        }
        self.chars.truncate(write);
        Ok(())
    }
    async fn bracket(
        &self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<(Atom, usize)>, Error> {
        let negated = self.active(start, '!') || self.active(start, '^');
        let start = start + usize::from(negated);
        let mut end = start;
        // A leading ']' belongs to the class, including after negation.
        if self.active(end, ']') {
            end += 1;
        }
        while end < self.chars.len() {
            work.checkpoint(cancel).await?;
            if self.active(end, ']') {
                return Ok(Some((
                    Atom::Class {
                        start,
                        end,
                        negated,
                    },
                    end + 1,
                )));
            }
            if self.active(end, '[') && [':', '.', '='].iter().any(|&ch| self.active(end + 1, ch)) {
                return Err(2.into());
            }
            end += 1;
        }
        Ok(None)
    }
    async fn compile(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Vec<Atom>, Error> {
        self.normalize(work, cancel).await?;
        let mut atoms = Vec::new();
        let mut index = 0;
        while index < self.chars.len() {
            work.checkpoint(cancel).await?;
            let (atom, next) = self.atom(index, work, cancel).await?;
            admit_element(&mut atoms, work)?;
            atoms.push(atom);
            index = next;
        }
        Ok(atoms)
    }
    async fn atom(
        &self,
        index: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(Atom, usize), Error> {
        let ch = self.chars[index];
        // GNU Bash cannot match an expansion-provided escape followed by an
        // already quoted character outside a bracket. Keep that distinction
        // typed; inside a bracket it remains an ordinary literal member.
        if ch.escaped_protected {
            return Ok((Atom::Never, index + 1));
        }
        if ch.protected {
            return Ok((Atom::Literal(ch.value), index + 1));
        }
        if matches!(ch.value, '@' | '?' | '*' | '+' | '!') && self.active(index + 1, '(') {
            return Err(2.into());
        }
        if ch.value == '[' {
            if let Some(class) = self.bracket(index + 1, work, cancel).await? {
                return Ok(class);
            }
            return Ok((Atom::Literal('['), index + 1));
        }
        let atom = match ch.value {
            '*' => Atom::Star,
            '?' => Atom::Any,
            value => Atom::Literal(value),
        };
        Ok((atom, index + 1))
    }
    async fn matches(
        &self,
        atom: &Atom,
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        match *atom {
            Atom::Literal(ch) => Ok(ch == value),
            Atom::Any => Ok(true),
            Atom::Never => Ok(false),
            Atom::Star => Err(2.into()),
            Atom::Class {
                start,
                end,
                negated,
            } => {
                self.class_matches(start, end, negated, value, work, cancel)
                    .await
            }
        }
    }
    async fn class_matches(
        &self,
        mut index: usize,
        end: usize,
        negated: bool,
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        let mut matched = false;
        while index < end {
            work.checkpoint(cancel).await?;
            let first = self.chars[index].value;
            if index + 2 < end && self.active(index + 1, '-') {
                matched |= first <= value && value <= self.chars[index + 2].value;
                index += 3;
                continue;
            }
            matched |= first == value;
            index += 1;
        }
        Ok(matched != negated)
    }
    pub(super) async fn remove<'a>(
        &mut self,
        value: &'a str,
        prefix: bool,
        longest: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<&'a str, Error> {
        let mut atoms = self.compile(work, cancel).await?;
        // Reverse atoms, never the contents of bracket expressions.
        if !prefix {
            let count = atoms.len();
            for index in 0..count / 2 {
                work.checkpoint(cancel).await?;
                atoms.swap(index, count - index - 1);
            }
        }
        let mut states = Vec::new();
        let count = atoms.len().checked_add(1).ok_or(2)?;
        work.admit_storage(count)?;
        states
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(2))?;
        states.push(true);
        for atom in &atoms {
            work.checkpoint(cancel).await?;
            states.push(matches!(atom, Atom::Star) && *states.last().ok_or(2)?);
        }
        let mut matched = states[atoms.len()].then_some(if prefix { 0 } else { value.len() });
        if matched.is_some() && !longest {
            return Ok(value);
        }
        let mut characters = value.char_indices();
        loop {
            work.checkpoint(cancel).await?;
            let next = if prefix {
                characters.next()
            } else {
                characters.next_back()
            };
            let Some((index, ch)) = next else { break };
            self.advance(&atoms, &mut states, ch, work, cancel).await?;
            if !states[atoms.len()] {
                continue;
            }
            matched = Some(if prefix { index + ch.len_utf8() } else { index });
            if !longest {
                break;
            }
        }
        let boundary = matched.unwrap_or(if prefix { 0 } else { value.len() });
        Ok(if prefix {
            &value[boundary..]
        } else {
            &value[..boundary]
        })
    }
    pub(super) async fn change_case(
        &mut self,
        value: &str,
        upper: bool,
        all: bool,
        locale: case::Locale,
        max_bytes: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<String, Error> {
        if !locale.utf8() {
            self.require_ascii(work, cancel).await?;
        }
        let atoms = self.compile(work, cancel).await?;
        let mut states = Vec::new();
        let count = atoms.len().checked_add(1).ok_or(2)?;
        work.admit_storage(count)?;
        states
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(2))?;
        for _ in 0..=atoms.len() {
            work.checkpoint(cancel).await?;
            states.push(false);
        }
        let mut result = String::new();
        for (index, ch) in value.chars().enumerate() {
            work.checkpoint(cancel).await?;
            let eligible = (all || index == 0) && (locale.utf8() || ch.is_ascii());
            let selected = eligible
                && self
                    .matches_character(&atoms, &mut states, ch, work, cancel)
                    .await?;
            let mapped = if selected { locale.map(ch, upper)? } else { ch };
            if mapped.len_utf8() > max_bytes.saturating_sub(result.len()) {
                return Err(2.into());
            }
            admit_string_growth(&mut result, mapped.len_utf8(), work)?;
            result.push(mapped);
        }
        Ok(result)
    }
    async fn require_ascii(&self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        for ch in &self.chars {
            work.checkpoint(cancel).await?;
            if !ch.value.is_ascii() {
                return Err(2.into());
            }
        }
        Ok(())
    }
    async fn matches_character(
        &self,
        atoms: &[Atom],
        states: &mut [bool],
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        // Omitted and unquoted expanded-empty patterns default to '?'.
        // An explicitly quoted empty pattern matches no character.
        if atoms.is_empty() {
            return Ok(!self.quoted_empty);
        }
        states[0] = true;
        for (index, atom) in atoms.iter().enumerate() {
            work.checkpoint(cancel).await?;
            states[index + 1] = matches!(atom, Atom::Star) && states[index];
        }
        self.advance(atoms, states, value, work, cancel).await?;
        Ok(states[atoms.len()])
    }
    async fn advance(
        &self,
        atoms: &[Atom],
        states: &mut [bool],
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let mut previous = states[0];
        states[0] = false;
        for (index, atom) in atoms.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let old = states[index + 1];
            states[index + 1] = if matches!(atom, Atom::Star) {
                states[index] || old
            } else {
                previous && self.matches(atom, value, work, cancel).await?
            };
            previous = old;
        }
        Ok(())
    }
}

enum Atom {
    Literal(char),
    Never,
    Any,
    Star,
    Class {
        start: usize,
        end: usize,
        negated: bool,
    },
}

// Reserve actual container capacity before allocation, including spare slots.
fn admit_element<T>(values: &mut Vec<T>, work: &mut Work) -> Result<(), Error> {
    if values.len() < values.capacity() {
        return Ok(());
    }
    let capacity = values.capacity().saturating_mul(2).max(4);
    let bytes = (capacity - values.capacity())
        .checked_mul(size_of::<T>())
        .ok_or(2)?;
    work.admit_storage(bytes)?;
    values
        .try_reserve_exact(capacity - values.len())
        .map_err(|_| Error::Status(2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    #[test]
    fn case_result_admits_capacity_not_only_written_bytes() {
        // The omitted pattern needs one state byte and the first String
        // growth reserves eight bytes, even for a one-byte result.
        for storage in [8, 9] {
            let mut pattern = Pattern::default();
            let mut work = Work::new(32, storage, 2);
            let cancel = Cancel::new();
            let result = pattern
                .change_case("a", true, true, case::Locale::C, 8, &mut work, &cancel)
                .now_or_never()
                .expect("small mapping finishes in one turn");
            if storage == 8 {
                assert!(matches!(result, Err(Error::Status(2))));
            } else {
                assert_eq!(
                    result.unwrap_or_else(|_| panic!("admitted mapping must fit")),
                    "A"
                );
                assert_eq!(work.storage_remaining, 0);
            }
        }
    }

    #[test]
    fn pattern_vectors_admit_spare_capacity_before_allocating() {
        let mut values = Vec::<Character>::new();
        let bytes = 4 * size_of::<Character>();
        let mut work = Work::new(32, bytes - 1, 2);
        assert!(matches!(
            admit_element(&mut values, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(values.capacity(), 0);
        let mut work = Work::new(32, bytes, 2);
        admit_element(&mut values, &mut work).unwrap_or_else(|_| panic!("exact capacity must fit"));
        assert_eq!(values.capacity(), 4);
        assert_eq!(work.storage_remaining, 0);
    }
}
