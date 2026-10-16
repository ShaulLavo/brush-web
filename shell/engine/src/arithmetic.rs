//! Scalar arithmetic adapted from Bashkit arithmetic.rs at 491c3281f668b76d64b15210b8f5d7bf97244be0.
//! The grammar, wrapping integer rules and operator semantics are upstream-derived.
//! Streaming lexing, async work admission and immediate durable scalar writes are
//! original adapters: no interpreter overlay, token vector, or blocking evaluator.
use crate::{
    executor::Cancel,
    expand::{self, Error, Work},
    state::SharedState,
};
use futures::{
    FutureExt,
    future::{Either, LocalBoxFuture, Ready, ready},
};
use std::future::Future;

pub(crate) type ArithmeticFuture<'a, T = i64> =
    Either<Ready<Result<T, Error>>, LocalBoxFuture<'a, Result<T, Error>>>;

// Admit the exact future frame before boxing it. A rejected admission returns
// an inline ready future, so even failure does not allocate an error frame.
pub(crate) fn admitted<'a, T: 'a, F: Future<Output = Result<T, Error>> + 'a>(
    work: &'a mut Work,
    build: impl FnOnce(&'a mut Work) -> F,
) -> ArithmeticFuture<'a, T> {
    if let Err(error) = work.admit_storage(std::mem::size_of::<F>()) {
        return Either::Left(ready(Err(error)));
    }
    Either::Right(build(work).boxed_local())
}

const MAX_DEPTH: usize = 64;
const OPS: &[&str] = &[
    "<<=", ">>=", "**", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=",
    "*=", "/=", "%=", "&=", "^=", "|=", "+", "-", "*", "/", "%", "<", ">", "!", "~", "&", "^", "|",
    "?", ":", "=", ",",
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Token<'a> {
    Number(&'a str),
    Ident(&'a str),
    Op(&'static str),
    Open,
    Close,
    Invalid,
    Unsupported,
    End,
}
struct Parser<'a> {
    source: &'a str,
    cursor: usize,
    current: Token<'a>,
    next: Token<'a>,
}
impl<'a> Parser<'a> {
    async fn new(source: &'a str, work: &mut Work, cancel: &Cancel) -> Result<Self, Error> {
        let mut parser = Self {
            source,
            cursor: 0,
            current: Token::End,
            next: Token::End,
        };
        parser.current = parser.lex(work, cancel).await?;
        parser.next = parser.lex(work, cancel).await?;
        Ok(parser)
    }
    async fn lex(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Token<'a>, Error> {
        let bytes = self.source.as_bytes();
        while self.cursor < bytes.len() {
            work.checkpoint(cancel).await?;
            if bytes[self.cursor].is_ascii_whitespace() {
                self.cursor += 1;
            } else if bytes[self.cursor..].starts_with(b"\\\n") {
                self.cursor += 2;
            } else {
                break;
            }
        }
        let start = self.cursor;
        let Some(&ch) = bytes.get(start) else {
            return Ok(Token::End);
        };
        if ch.is_ascii_alphanumeric() || ch == b'_' {
            let number = ch.is_ascii_digit();
            self.cursor += 1;
            while let Some(&ch) = bytes.get(self.cursor) {
                work.checkpoint(cancel).await?;
                if !(ch.is_ascii_alphanumeric()
                    || ch == b'_'
                    || number && matches!(ch, b'#' | b'@'))
                {
                    break;
                }
                self.cursor += 1;
            }
            let text = &self.source[start..self.cursor];
            return Ok(if number {
                Token::Number(text)
            } else {
                Token::Ident(text)
            });
        }
        if !ch.is_ascii() {
            self.cursor += self.source[start..].chars().next().ok_or(2)?.len_utf8();
            return Ok(Token::Invalid);
        }
        self.cursor += 1;
        match ch {
            b'(' => Ok(Token::Open),
            b')' => Ok(Token::Close),
            b'[' | b']' | b'`' => Ok(Token::Unsupported),
            _ => {
                for &op in OPS {
                    if self.source[start..].starts_with(op) {
                        self.cursor = start + op.len();
                        return Ok(Token::Op(op));
                    }
                }
                Ok(Token::Invalid)
            }
        }
    }
    async fn advance(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        self.current = self.next;
        self.next = self.lex(work, cancel).await?;
        Ok(())
    }
}

pub(crate) fn fault<T>(message: &'static str, work: &mut Work) -> Result<T, Error> {
    work.admit_storage(message.len() * 2 + 128)?;
    Err(Error::Arithmetic {
        message,
        line: None,
        expansion: false,
    })
}

pub(crate) fn evaluate<'a>(
    source: &'a str,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
) -> ArithmeticFuture<'a> {
    admitted(work, move |work| async move {
        work.enter_arithmetic()?;
        let result = async {
            work.checkpoint(cancel).await?;
            if source.len() > max {
                return Err(2.into());
            }
            let expanded;
            let source = if source.contains(['$', '"', '\\']) {
                expanded = expand::arithmetic_text(source, state, cancel, max, work).await?;
                expanded.as_str()
            } else {
                source
            };
            expression(source, state, cancel, max, work, 0).await
        }
        .await;
        work.leave_arithmetic();
        result
    })
}

/// let arguments have already undergone shell expansion as ordinary words.
/// Re-expanding their literal dollar or quote text would execute it twice.
pub(crate) async fn evaluate_literal(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<i64, Error> {
    expression(source, state, cancel, max, work, 0).await
}

fn expression<'a>(
    source: &'a str,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ArithmeticFuture<'a> {
    admitted(work, move |work| async move {
        if depth >= MAX_DEPTH {
            return Err(2.into());
        }
        if source.len() > max {
            return Err(2.into());
        }
        let mut parser = Parser::new(source, work, cancel).await?;
        if parser.current == Token::End {
            return Ok(0);
        }
        let result = parse(&mut parser, 0, true, state, cancel, max, work, depth + 1).await?;
        if parser.current == Token::Unsupported {
            return Err(2.into());
        }
        if parser.current != Token::End {
            return fault("syntax error in expression", work);
        }
        Ok(result)
    })
}

fn assignment(op: &str) -> bool {
    matches!(
        op,
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "^=" | "|="
    )
}
fn precedence(op: &str) -> Option<u8> {
    Some(match op {
        "," => 0,
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "^=" | "|=" => 1,
        "?" => 2,
        "||" => 3,
        "&&" => 4,
        "|" => 5,
        "^" => 6,
        "&" => 7,
        "==" | "!=" => 8,
        "<" | ">" | "<=" | ">=" => 9,
        "<<" | ">>" => 10,
        "+" | "-" | "++" | "--" => 11,
        "*" | "/" | "%" => 12,
        "**" => 13,
        _ => return None,
    })
}

fn parse<'a, 's: 'a>(
    p: &'a mut Parser<'s>,
    min: u8,
    active: bool,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ArithmeticFuture<'a> {
    admitted(work, move |work| async move {
        if depth >= MAX_DEPTH {
            return Err(2.into());
        }
        work.checkpoint(cancel).await?;
        // Capture compound-assignment's old value before the RHS mutates it.
        // Plain '=' never recursively evaluates its unused old value.
        let mut value = if min <= 1
            && let (Token::Ident(name), Token::Op(op)) = (p.current, p.next)
            && assignment(op)
        {
            p.advance(work, cancel).await?;
            p.advance(work, cancel).await?;
            let old = if op == "=" {
                0
            } else {
                read(name, active, state, cancel, max, work, depth + 1).await?
            };
            let rhs = parse(p, 1, active, state, cancel, max, work, depth + 1).await?;
            let result = if op == "=" {
                rhs
            } else {
                binary(&op[..op.len() - 1], old, rhs, active, work)?
            };
            store(name, result, active, state, max, work)?;
            result
        } else {
            unary(p, active, state, cancel, max, work, depth + 1).await?
        };
        loop {
            work.checkpoint(cancel).await?;
            let Token::Op(mut op) = p.current else {
                break;
            };
            let Some(prec) = precedence(op) else {
                break;
            };
            if prec < min {
                break;
            }
            if assignment(op) {
                return fault("attempted assignment to non-variable", work);
            }
            if op == "?" {
                p.advance(work, cancel).await?;
                let yes = parse(
                    p,
                    0,
                    active && value != 0,
                    state,
                    cancel,
                    max,
                    work,
                    depth + 1,
                )
                .await?;
                if p.current != Token::Op(":") {
                    return fault("`:' expected for conditional expression", work);
                }
                p.advance(work, cancel).await?;
                let no = parse(
                    p,
                    2,
                    active && value == 0,
                    state,
                    cancel,
                    max,
                    work,
                    depth + 1,
                )
                .await?;
                value = if value != 0 { yes } else { no };
                continue;
            }
            // On a non-lvalue, 5++1 and 5--1 mean binary sign + unary sign.
            if matches!(op, "++" | "--") {
                op = if op == "++" { "+" } else { "-" };
                p.current = Token::Op(op);
            } else {
                p.advance(work, cancel).await?;
            }
            let rhs_active = active && !(op == "&&" && value == 0 || op == "||" && value != 0);
            let rhs = parse(
                p,
                if op == "**" { prec } else { prec + 1 },
                rhs_active,
                state,
                cancel,
                max,
                work,
                depth + 1,
            )
            .await?;
            value = binary(op, value, rhs, active, work)?;
        }
        Ok(value)
    })
}

fn unary<'a, 's: 'a>(
    p: &'a mut Parser<'s>,
    active: bool,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ArithmeticFuture<'a> {
    admitted(work, move |work| async move {
        if depth >= MAX_DEPTH {
            return Err(2.into());
        }
        work.checkpoint(cancel).await?;
        if let Token::Op(op @ ("++" | "--")) = p.current {
            if let Token::Ident(name) = p.next {
                p.advance(work, cancel).await?;
                p.advance(work, cancel).await?;
                let old = read(name, active, state, cancel, max, work, depth + 1).await?;
                let value = if op == "++" {
                    old.wrapping_add(1)
                } else {
                    old.wrapping_sub(1)
                };
                store(name, value, active, state, max, work)?;
                return Ok(value);
            }
            // Two unary signs when there is no identifier after the token.
            p.current = Token::Op(if op == "++" { "+" } else { "-" });
            let value = unary(p, active, state, cancel, max, work, depth + 1).await?;
            return Ok(if op == "--" {
                value.wrapping_neg()
            } else {
                value
            });
        }
        if let Token::Op(op @ ("+" | "-" | "!" | "~")) = p.current {
            p.advance(work, cancel).await?;
            let value = unary(p, active, state, cancel, max, work, depth + 1).await?;
            return Ok(match op {
                "-" => value.wrapping_neg(),
                "!" => i64::from(value == 0),
                "~" => !value,
                _ => value,
            });
        }
        match p.current {
            Token::Number(text) => {
                let value = number(text, work, cancel).await?;
                p.advance(work, cancel).await?;
                Ok(value)
            }
            Token::Ident(name) => {
                p.advance(work, cancel).await?;
                let value = read(name, active, state, cancel, max, work, depth + 1).await?;
                if let Token::Op(op @ ("++" | "--")) = p.current {
                    p.advance(work, cancel).await?;
                    store(
                        name,
                        if op == "++" {
                            value.wrapping_add(1)
                        } else {
                            value.wrapping_sub(1)
                        },
                        active,
                        state,
                        max,
                        work,
                    )?;
                }
                Ok(value)
            }
            Token::Open => {
                p.advance(work, cancel).await?;
                let value = parse(p, 0, active, state, cancel, max, work, depth + 1).await?;
                if p.current != Token::Close {
                    return fault("missing `)'", work);
                }
                p.advance(work, cancel).await?;
                Ok(value)
            }
            Token::Unsupported => Err(2.into()),
            _ => fault("syntax error: operand expected", work),
        }
    })
}

async fn read(
    name: &str,
    active: bool,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<i64, Error> {
    if !active {
        return Ok(0);
    }
    let value = {
        let s = state.borrow();
        let value = s.scalar_parameter(name).unwrap_or("");
        if value.len() > max {
            return Err(2.into());
        }
        work.admit_storage(value.len())?;
        value.to_owned()
    };
    work.enter_scalar_arithmetic(name, cancel).await?;
    let result = expression(&value, state, cancel, max, work, depth).await;
    work.leave_scalar_arithmetic();
    result
}
fn store(
    name: &str,
    value: i64,
    active: bool,
    state: &SharedState,
    max: usize,
    work: &mut Work,
) -> Result<(), Error> {
    if !active {
        return Ok(());
    }
    let digits = if value == 0 {
        1
    } else {
        value.unsigned_abs().ilog10() as usize + 1
    } + usize::from(value < 0);
    if name.len() > max || digits > max {
        return Err(2.into());
    }
    // State insertion and an active prefix frame may both retain the value.
    work.admit_storage(name.len().saturating_mul(2).saturating_add(80 + 128))?;
    let text = value.to_string();
    let mut state = state.borrow_mut();
    let changed = state.scalar_parameter(name) != Some(text.as_str());
    if state.assign_parameter(name.to_owned(), text).is_err() {
        work.admit_storage(name.len().saturating_mul(2).saturating_add(160))?;
        return Err(Error::Readonly {
            name: name.to_owned(),
            line: None,
            expansion: false,
        });
    }
    work.arithmetic_writes = work.arithmetic_writes.wrapping_add(u64::from(changed));
    Ok(())
}

async fn number(text: &str, work: &mut Work, cancel: &Cancel) -> Result<i64, Error> {
    let (base, digits) =
        if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            (16, digits)
        } else if let Some((prefix, digits)) = text.split_once('#') {
            if prefix.starts_with('0') {
                return fault("invalid number", work);
            }
            let mut base = 0u32;
            for byte in prefix.bytes() {
                work.checkpoint(cancel).await?;
                if !byte.is_ascii_digit() {
                    return fault("invalid arithmetic base", work);
                }
                base = base
                    .saturating_mul(10)
                    .saturating_add(u32::from(byte - b'0'));
            }
            if !(2..=64).contains(&base) {
                return fault("invalid arithmetic base", work);
            }
            (base, digits)
        } else if text.len() > 1 && text.starts_with('0') {
            (8, &text[1..])
        } else {
            (10, text)
        };
    if digits.is_empty() {
        return if base == 16 && !text.contains('#') {
            Ok(0)
        } else {
            fault("invalid integer constant", work)
        };
    }
    let mut value = 0i64;
    for byte in digits.bytes() {
        work.checkpoint(cancel).await?;
        let digit = match byte {
            b'0'..=b'9' => u32::from(byte - b'0'),
            b'a'..=b'z' => u32::from(byte - b'a') + 10,
            b'A'..=b'Z' => u32::from(byte - b'A') + if base > 36 { 36 } else { 10 },
            b'@' => 62,
            b'_' => 63,
            _ => return fault("invalid number", work),
        };
        if digit >= base {
            return fault("value too great for base", work);
        }
        value = value
            .wrapping_mul(i64::from(base))
            .wrapping_add(i64::from(digit));
    }
    Ok(value)
}
fn binary(op: &str, left: i64, right: i64, active: bool, work: &mut Work) -> Result<i64, Error> {
    Ok(match op {
        "+" => left.wrapping_add(right),
        "-" => left.wrapping_sub(right),
        "*" => left.wrapping_mul(right),
        "/" | "%" => {
            if right == 0 {
                if !active {
                    return Ok(0);
                }
                return fault("division by 0", work);
            }
            if op == "/" {
                left.wrapping_div(right)
            } else {
                left.wrapping_rem(right)
            }
        }
        "**" => {
            if right < 0 {
                if !active {
                    return Ok(0);
                }
                return fault("exponent less than 0", work);
            }
            let mut exponent = right as u64;
            let mut base = left;
            let mut result = 1i64;
            // At most 63 iterations, independent of exponent magnitude.
            while exponent != 0 {
                if exponent & 1 != 0 {
                    result = result.wrapping_mul(base);
                }
                base = base.wrapping_mul(base);
                exponent >>= 1;
            }
            result
        }
        "<<" => left.wrapping_shl((right & 63) as u32),
        ">>" => left.wrapping_shr((right & 63) as u32),
        "<" => i64::from(left < right),
        ">" => i64::from(left > right),
        "<=" => i64::from(left <= right),
        ">=" => i64::from(left >= right),
        "==" => i64::from(left == right),
        "!=" => i64::from(left != right),
        "&" => left & right,
        "^" => left ^ right,
        "|" => left | right,
        "&&" => i64::from(left != 0 && right != 0),
        "||" => i64::from(left != 0 || right != 0),
        "," => right,
        _ => return fault("syntax error in expression", work),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Executor, state::State};

    fn finish<T: Clone + 'static>(ex: &Executor, job: crate::executor::JoinHandle<T>) -> T {
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            ex.drive(64);
        }
        panic!("arithmetic exceeded bounded executor turns");
    }

    #[test]
    fn future_frame_and_scalar_snapshot_storage_are_admitted_before_growth() {
        let ex = Executor::new();
        let job = ex.spawn(async {
            let state = State::default().shared();
            state
                .borrow_mut()
                .variables
                .insert("x".into(), "7".repeat(1000));
            let cancel = Cancel::new();
            let mut empty = Work::new(100_000, 0, 1);
            assert!(matches!(
                evaluate("1", &state, &cancel, 4096, &mut empty).await,
                Err(Error::Status(2))
            ));
            let mut bounded = Work::new(100_000, 1_000_000, 1);
            assert!(matches!(
                evaluate("x", &state, &cancel, 999, &mut bounded).await,
                Err(Error::Status(2))
            ));
            assert_eq!(state.borrow().variables["x"].len(), 1000);
            let mut fuel = Work::new(1, 1_000_000, 1);
            assert!(matches!(
                evaluate("1+2", &state, &cancel, 4096, &mut fuel).await,
                Err(Error::Status(2))
            ));
        });
        finish(&ex, job);
    }

    #[test]
    fn loops_yield_and_cancel_without_rolling_back_completed_writes() {
        let ex = Executor::new();
        let state = State::default().shared();
        let observed = state.clone();
        let cancel = Cancel::new();
        let token = cancel.clone();
        let job = ex.spawn(async move {
            let source = format!("x=9,{}1", "1+".repeat(10_000));
            let mut work = Work::new(1_000_000, 64 * 1024 * 1024, 1);
            match evaluate(&source, &state, &token, 100_000, &mut work).await {
                Err(Error::Status(code)) => code,
                _ => 0,
            }
        });
        for _ in 0..100 {
            ex.drive(1);
            if observed.borrow().variables.contains_key("x") {
                break;
            }
        }
        assert_eq!(
            observed.borrow().variables.get("x").map(String::as_str),
            Some("9")
        );
        assert!(
            !job.is_finished(),
            "large arithmetic must yield before finishing"
        );
        cancel.cancel();
        assert_eq!(finish(&ex, job), 130);
        assert_eq!(observed.borrow().variables["x"], "9");
    }

    #[test]
    fn recursive_cycles_are_domain_errors_but_parser_depth_is_resource_failure() {
        let ex = Executor::new();
        let job = ex.spawn(async {
            let state = State::default().shared();
            state.borrow_mut().variables.insert("x".into(), "y".into());
            state.borrow_mut().variables.insert("y".into(), "x".into());
            let cancel = Cancel::new();
            let mut work = Work::new(1_000_000, 1_000_000, 1);
            assert!(matches!(
                evaluate("x", &state, &cancel, 4096, &mut work).await,
                Err(Error::Arithmetic { .. })
            ));
            let mut work = Work::new(1_000_000, 1_000_000, 1);
            let source = format!("{}1{}", "(".repeat(100), ")".repeat(100));
            assert!(matches!(
                evaluate(&source, &state, &cancel, 4096, &mut work).await,
                Err(Error::Status(2))
            ));
        });
        finish(&ex, job);
    }
}
