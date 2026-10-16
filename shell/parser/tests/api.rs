use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use shell_parser::limits::{ExecutionBudget, ExecutionLimits, LimitExceeded};
use shell_parser::{
    AssignmentValue, Command, Error, ParseOptions, Parser, Script, Word, WordPart, parse,
    parse_with_budget,
};

fn argument(source: &str) -> Word {
    let script = Parser::new(source).parse().unwrap();
    let Command::Simple(command) = script.commands.into_iter().next().unwrap() else {
        panic!("expected a simple command: {source}");
    };
    command.args.into_iter().next().unwrap()
}

fn literal_characters(word: &Word) -> Vec<(char, bool)> {
    word.parts
        .iter()
        .enumerate()
        .flat_map(|(index, part)| {
            let quoted = word.part_quoted.get(index).copied().unwrap_or(word.quoted);
            let text = match part {
                WordPart::Literal(text) => text.as_str(),
                _ => "",
            };
            text.chars().map(move |ch| (ch, quoted))
        })
        .collect()
}

#[test]
fn literal_escape_protection_survives_lexing_and_quote_continuations() {
    for (source, expected) in [
        (r#"echo a\:b${IFS:=:}"#, ":"),
        (r#"echo a\éb${IFS:=é}"#, "é"),
        (r#"echo a\ b${IFS:= }"#, " "),
        (r#"echo a\"b${IFS:=:}"#, "\""),
        (r#"echo a\'b${IFS:=:}"#, "'"),
        (r#"echo a\`b${IFS:=:}"#, "`"),
        (r#"echo a\\b${IFS:=:}"#, "\\"),
        (r#"echo a\~b${IFS:=:}"#, "~"),
        (r#"echo a\*b${IFS:=:}"#, "*"),
        (r#"echo "a"\*b${IFS:=:}"#, "a*"),
        (r#"echo "a"\:b${IFS:=:}"#, "a:"),
        (r#"echo ]a\:b${IFS:=:}"#, ":"),
        (r#"echo }a\:b${IFS:=:}"#, ":"),
    ] {
        let word = argument(source);
        let protected: String = literal_characters(&word)
            .into_iter()
            .filter_map(|(ch, quoted)| quoted.then_some(ch))
            .collect();
        assert_eq!(protected, expected, "lost lexical protection: {source}");
        assert!(
            word.parts.iter().any(
                |part| matches!(part, WordPart::ParameterExpansion { name, .. } if name == "IFS")
            ),
            "the later expansion must remain active: {source}"
        );
        assert!(
            !literal_characters(&word).contains(&('b', true)),
            "escape protection must end after one character: {source}"
        );
    }
    assert_eq!(
        literal_characters(&argument(r#"echo a\:b${IFS:=:}"#)),
        [('a', false), (':', true), ('b', false)]
    );
}

#[test]
fn escaped_syntax_is_literal_and_ends_parameter_names() {
    let word = argument(r#"echo $x\y${IFS:=:}"#);
    assert!(matches!(&word.parts[0], WordPart::Variable(name) if name == "x"));
    assert_eq!(literal_characters(&word), [('y', true)]);
    for source in [r#"echo \$x"#, r#"echo $\{x}"#, r#"echo "a"\$x"#] {
        let word = argument(source);
        assert!(
            word.parts
                .iter()
                .all(|part| matches!(part, WordPart::Literal(_))),
            "escaped syntax became an expansion: {source}"
        );
    }
    for marker in ['\u{1e}', '\u{1f}'] {
        let word = argument(&format!("echo a\\{marker}b${{IFS:=:}}"));
        assert_eq!(
            literal_characters(&word),
            [('a', false), (marker, true), ('b', false)]
        );
        let word = argument(&format!("echo a\\{marker}{{b,c}}\\*d*${{IFS:=:}}"));
        assert_eq!(
            literal_characters(&word),
            [
                ('a', false),
                (marker, true),
                ('{', false),
                ('b', false),
                (',', false),
                ('c', false),
                ('}', false),
                ('*', true),
                ('d', false),
                ('*', false),
            ]
        );
    }
}

#[test]
fn lexical_escape_metadata_survives_assignment_slicing_and_token_lookahead() {
    for (source, expected) in [
        (r#"out=\"a:b\""#, "\"a:b\""),
        (r#"out=\'a:b\'"#, "'a:b'"),
        (r#"out=a\:b${IFS:=:}"#, "a:b${IFS:=:}"),
        (r#"out=\(word\)"#, "(word)"),
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("expected assignment: {source}");
        };
        let AssignmentValue::Scalar(word) = &command.assignments[0].value else {
            panic!("escaped parentheses cannot begin an array: {source}");
        };
        assert_eq!(word.to_string(), expected, "{source}");
        assert!(word.part_quoted.contains(&true), "{source}");
    }
    for source in [
        r#"a\bc=v"#,
        r#"a\=v"#,
        r#"a\+=v"#,
        r#"\if"#,
        r#"\then"#,
        r#"\fi"#,
        r#"\!"#,
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("escaped spelling must be a command word: {source}");
        };
        assert!(command.assignments.is_empty(), "{source}");
    }
    // Parsing a leading plain command looks ahead for `(` before consuming its
    // escaped argument. That lookahead must retain the lexical metadata.
    assert_eq!(
        literal_characters(&argument(r#"cmd a\:b${IFS:=:}"#)),
        [('a', false), (':', true), ('b', false)]
    );
    for (source, expected) in [(r#"a[1\+1]=value"#, r#"1\+1"#), (r#"a[\1]=value"#, r#"\1"#)] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("expected an indexed assignment");
        };
        assert_eq!(command.assignments[0].index.as_deref(), Some(expected));
    }
}

#[test]
fn line_continuations_do_not_create_literal_protection() {
    let joined = argument("echo a\\\nb${IFS:=:}");
    assert_eq!(literal_characters(&joined), [('a', false), ('b', false)]);
    let variable = argument("echo $x\\\ny${IFS:=:}");
    assert!(matches!(&variable.parts[0], WordPart::Variable(name) if name == "xy"));
}

#[test]
fn lexical_escape_work_uses_parser_and_shared_request_limits() {
    let source = format!("echo {}", "\\x".repeat(128));
    assert!(Parser::with_limits(&source, 100, 64).parse().is_err());
    let limits = ExecutionLimits {
        max_work_units: 64,
        ..ExecutionLimits::default()
    };
    assert!(matches!(
        parse(&source, &limits),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
}

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
