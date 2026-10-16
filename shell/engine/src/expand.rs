//! Deliberately narrow, original expansion adapter for the engine gate. Broad
//! Bash word rules (splitting, globbing, substitutions) belong to plan 004 step 3.
use crate::{
    executor::{Budget, Cancel},
    state::SharedState,
};
use shell_parser::parser::{Word, WordPart};

pub(crate) async fn word(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
) -> Result<String, i32> {
    let mut result = String::new();
    let mut budget = Budget::new(32);
    for part in &word.parts {
        budget.checkpoint(cancel).await.map_err(|_| 130)?;
        let value = match part {
            WordPart::Literal(text) => text.clone(),
            WordPart::Variable(name) => state.borrow().parameter(name),
            WordPart::ArrayAccess { name, index } if name == "PIPESTATUS" => {
                let state = state.borrow();
                match index.as_str() {
                    "*" | "@" => state
                        .pipestatus
                        .iter()
                        .map(i32::to_string)
                        .collect::<Vec<_>>()
                        .join(" "),
                    _ => index
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| state.pipestatus.get(i))
                        .map(i32::to_string)
                        .unwrap_or_default(),
                }
            }
            _ => return Err(2),
        };
        if value.len() > max.saturating_sub(result.len()) {
            return Err(2);
        }
        let mut rest = value.as_str();
        while !rest.is_empty() {
            budget.checkpoint(cancel).await.map_err(|_| 130)?;
            let mut end = rest.len().min(4096);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            result.push_str(&rest[..end]);
            rest = &rest[end..];
        }
    }
    Ok(result)
}
