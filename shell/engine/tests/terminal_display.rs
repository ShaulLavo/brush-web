//! Original, deterministic VT transcript regressions. No worker, browser or guest build.
#[path = "../src/terminal.rs"]
mod terminal;
use terminal::{Action, Editor};

struct Screen {
    columns: usize,
    lines: Vec<Vec<u8>>,
    row: usize,
    column: usize,
}
impl Screen {
    fn new(columns: usize) -> Self {
        Self {
            columns,
            lines: vec![vec![b' '; columns]],
            row: 0,
            column: 0,
        }
    }
    fn ensure_row(&mut self) {
        while self.lines.len() <= self.row {
            self.lines.push(vec![b' '; self.columns]);
        }
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut at = 0;
        while at < bytes.len() {
            match bytes[at] {
                b'\r' => self.column = 0,
                b'\n' => {
                    self.row += 1;
                    self.ensure_row();
                }
                0x1b => {
                    assert_eq!(bytes[at + 1], b'[');
                    let start = at + 2;
                    at = start;
                    while bytes[at].is_ascii_digit() {
                        at += 1;
                    }
                    let number = std::str::from_utf8(&bytes[start..at])
                        .unwrap()
                        .parse::<usize>()
                        .unwrap_or(0);
                    match bytes[at] {
                        b'A' => self.row = self.row.saturating_sub(number.max(1)),
                        b'C' => self.column = (self.column + number.max(1)).min(self.columns - 1),
                        b'D' => self.column = self.column.saturating_sub(number.max(1)),
                        b'J' => {
                            assert_eq!(number, 0);
                            self.lines[self.row][self.column.min(self.columns)..].fill(b' ');
                            self.lines.truncate(self.row + 1);
                        }
                        b'K' => {
                            assert_eq!(number, 2);
                            self.lines[self.row].fill(b' ');
                        }
                        other => panic!("unsupported editor CSI {}", char::from(other)),
                    }
                }
                byte => {
                    if self.column == self.columns {
                        self.row += 1;
                        self.column = 0;
                        self.ensure_row();
                    }
                    self.lines[self.row][self.column] = byte;
                    self.column += 1;
                }
            }
            at += 1;
        }
    }
    fn text(&self) -> String {
        let bytes: Vec<_> = self.lines.iter().flatten().copied().collect();
        String::from_utf8(bytes).unwrap().trim_end().to_string()
    }
}
fn type_bytes(editor: &mut Editor, screen: &mut Screen, bytes: &[u8]) {
    for byte in bytes {
        editor.resize("$ ", screen.columns);
        match editor.feed(*byte) {
            Action::Echo(byte) => {
                screen.write(&[byte]);
                editor.echoed(byte);
            }
            Action::Redraw => screen.write(&editor.redraw("$ ")),
            // Escape sequences arrive byte by byte, just as they do in the guest.
            // Their incomplete prefixes intentionally produce no display action.
            Action::None => {}
            other => panic!("unexpected action {other:?}"),
        }
    }
}
fn start(columns: usize) -> (Editor, Screen) {
    let mut editor = Editor::default();
    editor.begin("$ ", columns);
    let mut screen = Screen::new(columns);
    screen.write(b"$ ");
    (editor, screen)
}
#[test]
fn long_appended_commands_echo_each_byte_once_without_duplicate_prefixes() {
    for columns in [8, 12, 80] {
        let (mut editor, mut screen) = start(columns);
        let source = "printf 'a command longer than several terminal rows'; echo COMMAND_DONE";
        for byte in source.bytes() {
            assert_eq!(editor.feed(byte), Action::Echo(byte));
            screen.write(&[byte]);
            editor.echoed(byte);
        }
        assert_eq!(screen.text(), format!("$ {source}"));
        assert_eq!(
            editor.feed(b'\r'),
            Action::Submit(source.as_bytes().to_vec())
        );
    }
}
#[test]
fn editing_a_wrapped_command_clears_from_the_first_row_and_removes_old_tail() {
    let (mut editor, mut screen) = start(12);
    type_bytes(&mut editor, &mut screen, b"echo abcdefghijklmnopqrstuvwxyz");
    type_bytes(&mut editor, &mut screen, b"\x1b[H\x0b");
    assert_eq!(screen.text(), "$");
    assert_eq!((screen.row, screen.column), (0, 2));
    type_bytes(&mut editor, &mut screen, b"echo repaired");
    assert_eq!(screen.text(), "$ echo repaired");
    assert_eq!(
        editor.feed(b'\r'),
        Action::Submit(b"echo repaired".to_vec())
    );
}
#[test]
fn wrapped_middle_insertion_and_deletion_restore_the_caret_not_just_the_last_row() {
    let (mut editor, mut screen) = start(8);
    type_bytes(&mut editor, &mut screen, b"abcdefghijklmnop\x1b[D\x1b[DZ");
    assert_eq!(screen.text(), "$ abcdefghijklmnZop");
    assert_eq!((screen.row, screen.column), (2, 1));
    type_bytes(&mut editor, &mut screen, &[127]);
    assert_eq!(screen.text(), "$ abcdefghijklmnop");
    assert_eq!((screen.row, screen.column), (2, 0));
}
#[test]
fn exact_margin_backspace_cancels_pending_wrap_without_creating_a_duplicate_row() {
    let (mut editor, mut screen) = start(8);
    type_bytes(&mut editor, &mut screen, b"abcdef");
    type_bytes(&mut editor, &mut screen, &[127]);
    assert_eq!(screen.text(), "$ abcde");
    assert_eq!((screen.row, screen.column), (0, 7));
    type_bytes(&mut editor, &mut screen, b"ghi");
    assert_eq!(screen.text(), "$ abcdeghi");
}
#[test]
fn resize_recounts_the_existing_caret_before_editing_reflowed_text() {
    let (mut editor, mut screen) = start(12);
    type_bytes(&mut editor, &mut screen, b"abcdefghijklmnopqrst");
    // Model terminal reflow, which happens before the next keyboard input.
    screen = Screen::new(8);
    screen.write(b"$ abcdefghijklmnopqrst");
    type_bytes(&mut editor, &mut screen, b"\x1b[H\x0b");
    assert_eq!(screen.text(), "$");
    assert_eq!((screen.row, screen.column), (0, 2));
}
