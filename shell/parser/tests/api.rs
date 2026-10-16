use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use shell_parser::limits::{ExecutionBudget, ExecutionLimits, LimitExceeded};
use shell_parser::{
    Command, Error, ParseOptions, Parser, Script, WordPart, parse, parse_with_budget,
};

#[test]
fn public_ast_is_available_without_an_interpreter() {
    let script: Script = parse("echo \"$HOME\" | cat", &ExecutionLimits::default()).unwrap();
    assert!(matches!(&script.commands[0], Command::Pipeline(_)));
    let script = Parser::new("echo $HOME").parse().unwrap();
    let Command::Simple(command) = &script.commands[0] else {
        panic!("expected a simple command");
    };
    assert!(matches!(&command.args[0].parts[0], WordPart::Variable(name) if name == "HOME"));
    let _: shell_parser::parser::Span = script.span;
    let _ = ParseOptions::default();
}

#[test]
fn input_size_is_measured_in_bytes() {
    let limits = ExecutionLimits {
        max_input_bytes: 2,
        ..ExecutionLimits::default()
    };
    assert!(matches!(
        parse("界", &limits),
        Err(Error::ResourceLimit(LimitExceeded::InputTooLarge(3, 2)))
    ));
}

#[test]
fn configured_parser_limits_are_enforced() {
    let limits = ExecutionLimits {
        max_parser_operations: 0,
        ..ExecutionLimits::default()
    };
    assert!(parse("echo ok", &limits).is_err());
    let limits = ExecutionLimits {
        max_ast_depth: 1,
        ..ExecutionLimits::default()
    };
    // Adjacent `((` starts arithmetic syntax, not two nested subshells.
    let nested = "( ( (echo nested) ) )";
    assert!(parse(nested, &ExecutionLimits::default()).is_ok());
    assert!(parse(nested, &limits).is_err());
    let limits = ExecutionLimits {
        parser_timeout: Duration::ZERO,
        ..ExecutionLimits::default()
    };
    assert!(matches!(
        parse("echo ok", &limits),
        Err(Error::ResourceLimit(LimitExceeded::ParserTimeout(_)))
    ));
}

#[test]
fn substitutions_cannot_reset_the_shared_work_budget() {
    let limits = ExecutionLimits {
        max_work_units: 2,
        ..ExecutionLimits::default()
    };
    let budget = ExecutionBudget::new(&limits, Arc::new(AtomicBool::new(false)));
    assert!(matches!(
        parse_with_budget("echo $(echo $(echo nested))", &limits, budget.clone()),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
    assert!(matches!(
        budget.check(),
        Err(LimitExceeded::WorkUnits { .. })
    ));
    assert!(parse_with_budget("echo later", &limits, budget).is_err());
}

#[test]
fn pre_cancelled_requests_reject_even_empty_scripts() {
    let limits = ExecutionLimits::default();
    let budget = ExecutionBudget::new(&limits, Arc::new(AtomicBool::new(true)));
    assert!(matches!(
        parse_with_budget("", &limits, budget),
        Err(Error::ResourceLimit(LimitExceeded::Cancelled))
    ));
}

#[test]
fn syntax_error_locations_are_preserved() {
    assert!(matches!(
        parse("echo ok\nfi", &ExecutionLimits::default()),
        Err(Error::Parse {
            line: 2,
            column: 1,
            ..
        })
    ));
}

#[test]
fn simple_expansion_lines_use_the_first_complete_command_element() {
    for (source, line) in [
        ("echo >\\\n${u:?bad}", 1),
        ("a=\"one\ntwo\" echo >${u:?bad}", 2),
        (">\\\n${u:?bad} echo", 2),
        ("echo \"one\ntwo\" >${u:?bad}", 1),
        ("\"cmd\n\" >${u:?bad}", 2),
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("expected simple command: {source}");
        };
        assert_eq!(command.expansion_line, Some(line), "{source}");
        assert_eq!(command.redirects[0].expansion_line, Some(line), "{source}");
    }
}

#[test]
fn compound_redirect_lines_follow_the_grammar_and_survive_function_storage() {
    for (source, line) in [
        ("{\n :\n} >\\\n${u:?bad}", Some(4)),
        ("{ :; } >${u:?bad} >\"later\nword\"", Some(2)),
        ("(\n :\n) >\\\n${u:?bad}", Some(3)),
        ("while false; do\n :\ndone >\"${u:?one\ntwo}\"", Some(4)),
        ("\nf() {\n :\n} >${u:?bad}", Some(2)),
        ("f()\n{\n :\n} >${u:?bad}", Some(2)),
        ("f() (\n :\n) >\"${u:?one\ntwo}\"", Some(3)),
        ("f() while false; do :; done >${u:?bad}", None),
    ] {
        let script = Parser::new(source).parse().unwrap();
        let command = match &script.commands[0] {
            Command::Function(function) => function.body.as_ref(),
            command => command,
        };
        let Command::Compound(_, redirects) = command else {
            panic!("expected compound command: {source}");
        };
        assert!(!redirects.is_empty(), "{source}");
        assert!(
            redirects
                .iter()
                .all(|redirect| redirect.expansion_line == line),
            "{source}"
        );
    }
}
