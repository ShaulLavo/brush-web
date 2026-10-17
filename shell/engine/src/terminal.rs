//! Original bounded single-line terminal editor. The guest owns echo; the browser
//! forwards raw bytes, including ANSI arrows, without maintaining shell state.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Redraw,
    Submit(Vec<u8>),
    Eof,
    Interrupt,
    None,
}
#[derive(Default)]
pub struct Editor {
    line: Vec<u8>,
    cursor: usize,
    escape: Vec<u8>,
    history: Vec<Vec<u8>>,
    history_at: Option<usize>,
    draft: Vec<u8>,
}
impl Editor {
    pub fn clear(&mut self) {
        self.line.clear();
        self.cursor = 0;
        self.escape.clear();
        self.history_at = None;
        self.draft.clear();
    }
    pub fn redraw(&self, prompt: &str) -> Vec<u8> {
        let mut bytes = b"\r\x1b[2K".to_vec();
        bytes.extend_from_slice(prompt.as_bytes());
        bytes.extend_from_slice(&self.line);
        let right = String::from_utf8_lossy(&self.line[self.cursor..])
            .chars()
            .count();
        if right > 0 {
            bytes.extend_from_slice(format!("\x1b[{right}D").as_bytes());
        }
        bytes
    }
    fn previous(&self) -> usize {
        let mut at = self.cursor.saturating_sub(1);
        while at > 0 && self.line[at] & 0xc0 == 0x80 {
            at -= 1;
        }
        at
    }
    fn next(&self) -> usize {
        let mut at = (self.cursor + 1).min(self.line.len());
        while at < self.line.len() && self.line[at] & 0xc0 == 0x80 {
            at += 1;
        }
        at
    }
    fn history(&mut self, up: bool) {
        if self.history.is_empty() {
            return;
        }
        let next = match (self.history_at, up) {
            (None, true) => {
                self.draft = self.line.clone();
                Some(self.history.len() - 1)
            }
            (Some(at), true) => Some(at.saturating_sub(1)),
            (Some(at), false) if at + 1 < self.history.len() => Some(at + 1),
            _ => None,
        };
        self.history_at = next;
        self.line = next
            .map(|at| self.history[at].clone())
            .unwrap_or_else(|| self.draft.clone());
        self.cursor = self.line.len();
    }
    pub fn feed(&mut self, byte: u8) -> Action {
        if !self.escape.is_empty() {
            self.escape.push(byte);
            if self.escape.len() == 2 && (byte == b'[' || byte == b'O') {
                return Action::None;
            }
            if self.escape.len() > 8 {
                self.escape.clear();
                return Action::None;
            }
            if byte.is_ascii_digit() || byte == b';' {
                return Action::None;
            }
            match self.escape.as_slice() {
                b"\x1b[A" => self.history(true),
                b"\x1b[B" => self.history(false),
                b"\x1b[D" if self.cursor > 0 => self.cursor = self.previous(),
                b"\x1b[C" if self.cursor < self.line.len() => self.cursor = self.next(),
                b"\x1b[H" | b"\x1bOH" | b"\x1b[1~" => self.cursor = 0,
                b"\x1b[F" | b"\x1bOF" | b"\x1b[4~" => self.cursor = self.line.len(),
                b"\x1b[3~" if self.cursor < self.line.len() => {
                    self.line.drain(self.cursor..self.next());
                }
                _ => {}
            }
            self.escape.clear();
            return Action::Redraw;
        }
        match byte {
            0x1b => {
                self.escape.push(byte);
                Action::None
            }
            b'\r' | b'\n' => {
                let line = self.line.clone();
                if !line.is_empty() && self.history.last() != Some(&line) {
                    if self.history.len() == 100 {
                        self.history.remove(0);
                    }
                    self.history.push(line.clone());
                }
                self.clear();
                Action::Submit(line)
            }
            3 => {
                self.clear();
                Action::Interrupt
            }
            4 if self.line.is_empty() => Action::Eof,
            4 if self.cursor < self.line.len() => {
                self.line.drain(self.cursor..self.next());
                Action::Redraw
            }
            8 | 127 if self.cursor > 0 => {
                let at = self.previous();
                self.line.drain(at..self.cursor);
                self.cursor = at;
                Action::Redraw
            }
            1 => {
                self.cursor = 0;
                Action::Redraw
            }
            5 => {
                self.cursor = self.line.len();
                Action::Redraw
            }
            11 => {
                self.line.truncate(self.cursor);
                Action::Redraw
            }
            21 => {
                self.line.drain(..self.cursor);
                self.cursor = 0;
                Action::Redraw
            }
            23 => {
                let end = self.cursor;
                while self.cursor > 0 && self.line[self.cursor - 1].is_ascii_whitespace() {
                    self.cursor -= 1;
                }
                while self.cursor > 0 && !self.line[self.cursor - 1].is_ascii_whitespace() {
                    self.cursor -= 1;
                }
                while self.cursor > 0 && self.line[self.cursor] & 0xc0 == 0x80 {
                    self.cursor -= 1;
                }
                self.line.drain(self.cursor..end);
                Action::Redraw
            }
            12 => Action::Redraw,
            b'\t' | 32..=126 | 128..=255 if self.line.len() < 64 * 1024 => {
                self.line.insert(self.cursor, byte);
                self.cursor += 1;
                Action::Redraw
            }
            _ => Action::None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editing_and_history_keep_byte_exact_commands() {
        let mut editor = Editor::default();
        for byte in b"echo ac\x1b[Db\x1b[F" {
            editor.feed(*byte);
        }
        assert_eq!(editor.feed(b'\r'), Action::Submit(b"echo abc".to_vec()));
        for byte in b"draft\x1b[A" {
            editor.feed(*byte);
        }
        assert!(editor.redraw("$ ").ends_with(b"echo abc"));
        for byte in b"\x1b[B" {
            editor.feed(*byte);
        }
        assert_eq!(editor.feed(b'\n'), Action::Submit(b"draft".to_vec()));
    }
    #[test]
    fn utf8_backspace_ctrl_d_and_interrupt() {
        let mut editor = Editor::default();
        for byte in "é中".bytes() {
            editor.feed(byte);
        }
        editor.feed(127);
        assert_eq!(editor.feed(b'\n'), Action::Submit("é".as_bytes().to_vec()));
        assert_eq!(editor.feed(4), Action::Eof);
        editor.feed(b'x');
        assert_eq!(editor.feed(3), Action::Interrupt);
        assert_eq!(editor.feed(4), Action::Eof);
    }
}
