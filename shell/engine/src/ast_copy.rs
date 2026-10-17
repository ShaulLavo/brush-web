//! Cooperative admission for synchronous parser-AST clones. Account for every
//! owned allocation before the caller clones; never print or serialize the AST.
use crate::{
    executor::Cancel,
    expand::{self, Work},
};
use shell_parser::parser::{
    ArithmeticForCommand, Assignment, AssignmentValue, CaseCommand, CaseItem, Command, CommandList,
    CompoundCommand, CoprocCommand, ForCommand, FunctionDef, IfCommand, ListOperator, ParameterOp,
    Pipeline, Redirect, SelectCommand, SimpleCommand, TimeCommand, UntilCommand, WhileCommand,
    Word, WordPart,
};
use std::mem::size_of;

/// Admit the storage and work of `commands.to_vec()` before making that copy.
///
/// The parser bounds source nesting. This visitor is additionally iterative and
/// keeps only a constant number of pending children per ancestor: wide vectors
/// are visited one element at a time, not queued wholesale. Its own stack growth
/// is admitted before allocation and conservatively remains charged to `work`.
pub(crate) async fn admit(
    commands: &[Command],
    cancel: &Cancel,
    work: &mut Work,
) -> Result<(), expand::Error> {
    work.checkpoint(cancel).await?;
    let mut stack = Vec::new();
    push_vec(&mut stack, commands, Visit::Commands, work)?;
    while let Some(visit) = stack.pop() {
        work.checkpoint(cancel).await?;
        match visit {
            Visit::Commands(items) => {
                visit_slice(&mut stack, items, Visit::Commands, Visit::Command, work)?;
            }
            Visit::Words(items) => {
                visit_slice(&mut stack, items, Visit::Words, Visit::Word, work)?;
            }
            Visit::Parts(items) => {
                visit_slice(&mut stack, items, Visit::Parts, Visit::Part, work)?;
            }
            Visit::Redirects(items) => {
                visit_slice(&mut stack, items, Visit::Redirects, Visit::Redirect, work)?;
            }
            Visit::Assignments(items) => {
                visit_slice(
                    &mut stack,
                    items,
                    Visit::Assignments,
                    Visit::Assignment,
                    work,
                )?;
            }
            Visit::Cases(items) => {
                visit_slice(&mut stack, items, Visit::Cases, Visit::Case, work)?;
            }
            Visit::Strings(items) => {
                visit_slice(&mut stack, items, Visit::Strings, |s| Visit::Text(s), work)?;
            }
            Visit::ListRest(items) => {
                visit_slice(
                    &mut stack,
                    items,
                    Visit::ListRest,
                    |(_, command)| Visit::Command(command),
                    work,
                )?;
            }
            Visit::ElifBranches(items) => {
                if let Some(((condition, body), rest)) = items.split_first() {
                    push_nonempty(&mut stack, rest, Visit::ElifBranches, work)?;
                    push_vec(&mut stack, body, Visit::Commands, work)?;
                    push_vec(&mut stack, condition, Visit::Commands, work)?;
                }
            }
            Visit::Command(command) => match command {
                Command::Simple(SimpleCommand {
                    expansion_line: _,
                    name,
                    args,
                    redirects,
                    assignments,
                    span: _,
                }) => {
                    push_vec(&mut stack, assignments, Visit::Assignments, work)?;
                    push_vec(&mut stack, redirects, Visit::Redirects, work)?;
                    push_vec(&mut stack, args, Visit::Words, work)?;
                    push(&mut stack, Visit::Word(name), work)?;
                }
                Command::Pipeline(Pipeline {
                    negated: _,
                    commands,
                    span: _,
                }) => push_vec(&mut stack, commands, Visit::Commands, work)?,
                Command::List(CommandList {
                    first,
                    rest,
                    span: _,
                }) => {
                    push_vec(&mut stack, rest, Visit::ListRest, work)?;
                    push_boxed_command(&mut stack, first, work)?;
                }
                Command::Compound(compound, redirects) => {
                    push_vec(&mut stack, redirects, Visit::Redirects, work)?;
                    push(&mut stack, Visit::Compound(compound), work)?;
                }
                Command::Function(FunctionDef {
                    name,
                    body,
                    source,
                    span: _,
                }) => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push_optional_text(&mut stack, source, work)?;
                    push_boxed_command(&mut stack, body, work)?;
                }
            },
            Visit::Compound(compound) => match compound {
                CompoundCommand::If(IfCommand {
                    condition,
                    then_branch,
                    elif_branches,
                    else_branch,
                    span: _,
                }) => {
                    if let Some(commands) = else_branch {
                        push_vec(&mut stack, commands, Visit::Commands, work)?;
                    }
                    push_vec(&mut stack, elif_branches, Visit::ElifBranches, work)?;
                    push_vec(&mut stack, then_branch, Visit::Commands, work)?;
                    push_vec(&mut stack, condition, Visit::Commands, work)?;
                }
                CompoundCommand::For(ForCommand {
                    variable,
                    words,
                    body,
                    span: _,
                }) => {
                    push(&mut stack, Visit::Text(variable), work)?;
                    if let Some(words) = words {
                        push_vec(&mut stack, words, Visit::Words, work)?;
                    }
                    push_vec(&mut stack, body, Visit::Commands, work)?;
                }
                CompoundCommand::ArithmeticFor(ArithmeticForCommand {
                    init,
                    condition,
                    step,
                    raw,
                    body,
                    span: _,
                }) => {
                    push(&mut stack, Visit::Text(init), work)?;
                    push(&mut stack, Visit::Text(condition), work)?;
                    push(&mut stack, Visit::Text(step), work)?;
                    if let Some(raw) = raw {
                        push_vec(&mut stack, raw, Visit::Strings, work)?;
                    }
                    push_vec(&mut stack, body, Visit::Commands, work)?;
                }
                CompoundCommand::While(WhileCommand {
                    condition,
                    body,
                    span: _,
                })
                | CompoundCommand::Until(UntilCommand {
                    condition,
                    body,
                    span: _,
                }) => {
                    push_vec(&mut stack, body, Visit::Commands, work)?;
                    push_vec(&mut stack, condition, Visit::Commands, work)?;
                }
                CompoundCommand::Case(CaseCommand {
                    word,
                    cases,
                    span: _,
                }) => {
                    push_vec(&mut stack, cases, Visit::Cases, work)?;
                    push(&mut stack, Visit::Word(word), work)?;
                }
                CompoundCommand::Select(SelectCommand {
                    variable,
                    words,
                    body,
                    span: _,
                }) => {
                    push(&mut stack, Visit::Text(variable), work)?;
                    push_vec(&mut stack, words, Visit::Words, work)?;
                    push_vec(&mut stack, body, Visit::Commands, work)?;
                }
                CompoundCommand::Subshell(commands) | CompoundCommand::BraceGroup(commands) => {
                    push_vec(&mut stack, commands, Visit::Commands, work)?;
                }
                CompoundCommand::Arithmetic(text) => {
                    push(&mut stack, Visit::Text(text), work)?;
                }
                CompoundCommand::Time(time) => {
                    work.admit_storage(size_of::<TimeCommand>())?;
                    let TimeCommand {
                        posix_format: _,
                        format,
                        output,
                        append: _,
                        verbose: _,
                        option_error,
                        command,
                        span: _,
                    } = time.as_ref();
                    if let Some(format) = format {
                        push(&mut stack, Visit::Word(format), work)?;
                    }
                    if let Some(output) = output {
                        push(&mut stack, Visit::Word(output), work)?;
                    }
                    push_optional_text(&mut stack, option_error, work)?;
                    if let Some(command) = command {
                        push_boxed_command(&mut stack, command, work)?;
                    }
                }
                CompoundCommand::Conditional(words) => {
                    push_vec(&mut stack, words, Visit::Words, work)?;
                }
                CompoundCommand::Coproc(CoprocCommand {
                    name,
                    body,
                    span: _,
                }) => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push_boxed_command(&mut stack, body, work)?;
                }
            },
            Visit::Case(CaseItem {
                patterns,
                commands,
                terminator: _,
            }) => {
                push_vec(&mut stack, patterns, Visit::Words, work)?;
                push_vec(&mut stack, commands, Visit::Commands, work)?;
            }
            Visit::Word(Word {
                parts,
                quoted: _,
                has_unquoted_glob: _,
                part_quoted,
                raw,
            }) => {
                admit_vec(part_quoted, work)?;
                push_optional_text(&mut stack, raw, work)?;
                push_vec(&mut stack, parts, Visit::Parts, work)?;
            }
            Visit::Part(part) => match part {
                WordPart::Literal(text)
                | WordPart::Variable(text)
                | WordPart::ArithmeticExpansion(text)
                | WordPart::Length(text)
                | WordPart::ArrayLength(text)
                | WordPart::BadSubstitution(text) => {
                    push(&mut stack, Visit::Text(text), work)?;
                }
                WordPart::CompoundAssignment {
                    name,
                    append: _,
                    elements,
                } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push_vec(&mut stack, elements, Visit::Words, work)?;
                }
                WordPart::CommandSubstitution(commands)
                | WordPart::ProcessSubstitution {
                    commands,
                    is_input: _,
                } => push_vec(&mut stack, commands, Visit::Commands, work)?,
                WordPart::UnparsedCommandSubstitution { source, error } => {
                    push(&mut stack, Visit::Text(source), work)?;
                    push(&mut stack, Visit::Text(error), work)?;
                }
                WordPart::UnparsedProcessSubstitution {
                    source,
                    is_input: _,
                } => push(&mut stack, Visit::Text(source), work)?,
                WordPart::ParameterExpansion {
                    name,
                    operator,
                    operand,
                    colon_variant: _,
                } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push(&mut stack, Visit::Text(operand), work)?;
                    push(&mut stack, Visit::ParameterOp(operator), work)?;
                }
                WordPart::IndirectExpansion {
                    name,
                    operator,
                    operand,
                    colon_variant: _,
                } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push(&mut stack, Visit::Text(operand), work)?;
                    if let Some(operator) = operator {
                        push(&mut stack, Visit::ParameterOp(operator), work)?;
                    }
                }
                WordPart::ArrayAccess { name, index } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push(&mut stack, Visit::Text(index), work)?;
                }
                WordPart::ArrayIndices { name, star: _ }
                | WordPart::Transformation { name, operator: _ } => {
                    push(&mut stack, Visit::Text(name), work)?;
                }
                WordPart::Substring {
                    name,
                    offset,
                    length,
                } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push(&mut stack, Visit::Text(offset), work)?;
                    push_optional_text(&mut stack, length, work)?;
                }
                WordPart::IndirectSuffix { name, suffix } => {
                    push(&mut stack, Visit::Text(name), work)?;
                    push(&mut stack, Visit::Text(suffix), work)?;
                }
                WordPart::PrefixMatch { prefix, star: _ } => {
                    push(&mut stack, Visit::Text(prefix), work)?;
                }
            },
            Visit::ParameterOp(operator) => match operator {
                ParameterOp::ReplaceFirst {
                    pattern,
                    replacement,
                }
                | ParameterOp::ReplaceAll {
                    pattern,
                    replacement,
                } => {
                    push(&mut stack, Visit::Text(pattern), work)?;
                    push(&mut stack, Visit::Text(replacement), work)?;
                }
                ParameterOp::UseDefault
                | ParameterOp::AssignDefault
                | ParameterOp::UseReplacement
                | ParameterOp::Error
                | ParameterOp::RemovePrefixShort
                | ParameterOp::RemovePrefixLong
                | ParameterOp::RemoveSuffixShort
                | ParameterOp::RemoveSuffixLong
                | ParameterOp::UpperFirst
                | ParameterOp::UpperAll
                | ParameterOp::LowerFirst
                | ParameterOp::LowerAll
                | ParameterOp::ToggleFirst
                | ParameterOp::ToggleAll => {}
            },
            Visit::Redirect(Redirect {
                expansion_line: _,
                fd: _,
                fd_var,
                kind: _,
                target,
                heredoc_delim,
            }) => {
                push_optional_text(&mut stack, fd_var, work)?;
                push_optional_text(&mut stack, heredoc_delim, work)?;
                push(&mut stack, Visit::Word(target), work)?;
            }
            Visit::Assignment(Assignment {
                name,
                index,
                value,
                append: _,
            }) => {
                push(&mut stack, Visit::Text(name), work)?;
                push_optional_text(&mut stack, index, work)?;
                match value {
                    AssignmentValue::Scalar(word) => push(&mut stack, Visit::Word(word), work)?,
                    AssignmentValue::Array(words) => {
                        push_vec(&mut stack, words, Visit::Words, work)?;
                    }
                }
            }
            Visit::Text(text) => {
                work.admit_storage(text.len())?;
                // No scan or UTF-8 slicing is needed: clone copies bytes. Charge
                // bounded byte chunks so even one large payload yields regularly.
                for _ in 0..text.len().div_ceil(64) {
                    work.checkpoint(cancel).await?;
                }
            }
        }
    }
    // Catch cancellation that arrived at the last cooperative yield, before the
    // caller enters the admitted synchronous clone.
    work.checkpoint(cancel).await
}

/// Admit a single command, including its slot (also suitable for a boxed body).
pub(crate) async fn command(
    command: &Command,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<(), expand::Error> {
    admit(std::slice::from_ref(command), cancel, work).await
}

enum Visit<'a> {
    Commands(&'a [Command]),
    Words(&'a [Word]),
    Parts(&'a [WordPart]),
    Redirects(&'a [Redirect]),
    Assignments(&'a [Assignment]),
    Cases(&'a [CaseItem]),
    Strings(&'a [String]),
    ListRest(&'a [(ListOperator, Command)]),
    ElifBranches(&'a [(Vec<Command>, Vec<Command>)]),
    Command(&'a Command),
    Compound(&'a CompoundCommand),
    Word(&'a Word),
    Part(&'a WordPart),
    ParameterOp(&'a ParameterOp),
    Redirect(&'a Redirect),
    Assignment(&'a Assignment),
    Case(&'a CaseItem),
    Text(&'a str),
}

fn admit_vec<T>(items: &[T], work: &mut Work) -> Result<(), expand::Error> {
    let bytes = items.len().checked_mul(size_of::<T>()).ok_or(2)?;
    work.admit_storage(bytes)
}

fn push<'a>(
    stack: &mut Vec<Visit<'a>>,
    visit: Visit<'a>,
    work: &mut Work,
) -> Result<(), expand::Error> {
    if stack.len() == stack.capacity() {
        let capacity = stack.capacity().checked_mul(2).ok_or(2)?.max(1);
        let bytes = (capacity - stack.capacity())
            .checked_mul(size_of::<Visit<'a>>())
            .ok_or(2)?;
        work.admit_storage(bytes)?;
        stack
            .try_reserve_exact(capacity - stack.len())
            .map_err(|_| expand::Error::Status(2))?;
    }
    stack.push(visit);
    Ok(())
}

fn push_nonempty<'a, T>(
    stack: &mut Vec<Visit<'a>>,
    items: &'a [T],
    visit: fn(&'a [T]) -> Visit<'a>,
    work: &mut Work,
) -> Result<(), expand::Error> {
    if !items.is_empty() {
        push(stack, visit(items), work)?;
    }
    Ok(())
}

fn push_vec<'a, T>(
    stack: &mut Vec<Visit<'a>>,
    items: &'a [T],
    visit: fn(&'a [T]) -> Visit<'a>,
    work: &mut Work,
) -> Result<(), expand::Error> {
    admit_vec(items, work)?;
    push_nonempty(stack, items, visit, work)
}

fn visit_slice<'a, T>(
    stack: &mut Vec<Visit<'a>>,
    items: &'a [T],
    rest: fn(&'a [T]) -> Visit<'a>,
    item: fn(&'a T) -> Visit<'a>,
    work: &mut Work,
) -> Result<(), expand::Error> {
    if let Some((first, tail)) = items.split_first() {
        push_nonempty(stack, tail, rest, work)?;
        push(stack, item(first), work)?;
    }
    Ok(())
}

fn push_optional_text<'a>(
    stack: &mut Vec<Visit<'a>>,
    text: &'a Option<String>,
    work: &mut Work,
) -> Result<(), expand::Error> {
    if let Some(text) = text {
        push(stack, Visit::Text(text), work)?;
    }
    Ok(())
}

fn push_boxed_command<'a>(
    stack: &mut Vec<Visit<'a>>,
    command: &'a Command,
    work: &mut Work,
) -> Result<(), expand::Error> {
    work.admit_storage(size_of::<Command>())?;
    push(stack, Visit::Command(command), work)
}
