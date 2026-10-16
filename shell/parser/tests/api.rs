use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use shell_parser::limits::{ExecutionBudget, ExecutionLimits, LimitExceeded};
use shell_parser::{
    AssignmentValue, Command, Error, ParameterOp, ParseOptions, Parser, Script, Word, WordPart,
    parse, parse_with_budget,
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
fn scalar_pattern_brackets_keep_quoted_braces_inside_the_operand() {
    for (spelling, expected) in [
        ("#", ParameterOp::RemovePrefixShort),
        ("##", ParameterOp::RemovePrefixLong),
        ("%", ParameterOp::RemoveSuffixShort),
        ("%%", ParameterOp::RemoveSuffixLong),
    ] {
        for brace in ['{', '}'] {
            let source = format!("args ${{v{spelling}['{brace}']}}tail");
            let word = argument(&source);
            let [
                WordPart::ParameterExpansion {
                    name,
                    operator,
                    operand,
                    ..
                },
                WordPart::Literal(tail),
            ] = word.parts.as_slice()
            else {
                panic!("lost operand boundary: {source}: {word:?}");
            };
            assert_eq!(name, "v");
            assert_eq!(operator, &expected);
            assert!(operand.starts_with('[') && operand.ends_with(']'));
            assert!(operand.contains(brace));
            assert_eq!(tail, "tail");
        }
    }
}

#[test]
fn nested_and_malformed_bracket_patterns_keep_their_parameter_boundaries() {
    for source in [
        r#"args ${u:-${v#['}']}}tail"#,
        r#"args ${u:=${v%%['{']}}tail"#,
        r#"args ${v#['}'}tail"#,
        r#"args ${v%%['{'}tail"#,
    ] {
        let word = argument(source);
        assert_eq!(word.parts.len(), 2, "{source}");
        assert!(matches!(
            &word.parts[0],
            WordPart::ParameterExpansion { .. }
        ));
        assert!(matches!(&word.parts[1], WordPart::Literal(tail) if tail == "tail"));
    }
    for source in [r#"args ${v#['}] }"#, r#"args ${v%['{] }"#] {
        assert!(
            Parser::new(source).parse().is_err(),
            "unclosed quote: {source}"
        );
    }
}

#[test]
fn pattern_bracket_fix_preserves_target_subscripts_and_literal_escape_metadata() {
    for (source, expected_index) in [
        (r#"args ${a['key']}tail"#, "key"),
        (r#"args ${a[${i}]}tail"#, "${i}"),
    ] {
        let word = argument(source);
        assert!(
            matches!(&word.parts[0], WordPart::ArrayAccess { name, index }
            if name == "a" && index == expected_index)
        );
        assert!(matches!(&word.parts[1], WordPart::Literal(tail) if tail == "tail"));
    }
    let word = argument("args ${#a[@]}tail");
    assert!(matches!(&word.parts[0], WordPart::ArrayLength(name) if name == "a"));
    assert!(matches!(&word.parts[1], WordPart::Literal(tail) if tail == "tail"));
    let word = argument("args ${#a[0]}tail");
    assert!(matches!(&word.parts[0], WordPart::Length(name) if name == "a[0]"));
    assert!(matches!(&word.parts[1], WordPart::Literal(tail) if tail == "tail"));
    let word = argument(r#"args ${v#['}']}a\:b${IFS:=:}"#);
    assert_eq!(
        literal_characters(&word),
        [('a', false), (':', true), ('b', false)]
    );
    let word = argument(r#"args "${u:-'${v:-x}'}"tail"#);
    assert!(
        matches!(&word.parts[0], WordPart::ParameterExpansion { operand, .. }
        if operand == "'${v:-x}'")
    );
    assert!(matches!(&word.parts[1], WordPart::Literal(tail) if tail == "tail"));
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

#[test]
fn replacement_operands_retain_nested_slashes_and_quotes() {
    for source in [
        r#"args ${v/${p:-a/b}/${r:-x/y}}tail"#,
        r#"args "${v/'a/b'/'x/y'}"tail"#,
    ] {
        let word = argument(source);
        let WordPart::ParameterExpansion { operator, .. } = &word.parts[0] else {
            panic!("lost replacement: {word:?}");
        };
        let ParameterOp::ReplaceFirst {
            pattern,
            replacement,
        } = operator
        else {
            panic!("lost replacement operator: {word:?}");
        };
        assert!(pattern.contains("a/b"), "{word:?}");
        assert!(replacement.contains("x/y"), "{word:?}");
        assert!(matches!(word.parts.last(), Some(WordPart::Literal(tail)) if tail == "tail"));
    }
}

#[test]
fn replacement_operands_keep_bare_braces_and_single_quote_backslashes_bounded() {
    for source in [
        r#"args ${v/b/{}} next"#,
        r#"args "${v/b/'a\'}" next"#,
        r#"args "${v/b/{}" next"#,
        r#"args "${v/b/'${x'}" next"#,
        r#"args "${v/b/'$(x'}" next"#,
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = script.commands.into_iter().next().unwrap() else {
            panic!("expected a simple command: {source}");
        };
        assert_eq!(command.args.len(), 2, "{source}");
        assert!(matches!(
            command.args[0].parts.first(),
            Some(WordPart::ParameterExpansion { .. })
        ));
        assert!(matches!(
            command.args[1].parts.as_slice(),
            [WordPart::Literal(next)] if next == "next"
        ));
    }
}

#[test]
fn quoted_replacement_substitution_lookalikes_stay_inside_single_quotes() {
    for source in [r#"args "${v/b/'$(x'}" next"#, r#"args "${v/b/'${x'}" next"#] {
        let word = argument(source);
        let WordPart::ParameterExpansion { operator, .. } = &word.parts[0] else {
            panic!("lost replacement: {word:?}");
        };
        let ParameterOp::ReplaceFirst { replacement, .. } = operator else {
            panic!("lost replacement operator: {word:?}");
        };
        assert!(
            replacement.ends_with('\''),
            "swallowed closing brace: {word:?}"
        );
    }
}

#[test]
fn nested_replacements_keep_enclosing_operand_and_word_boundaries() {
    for source in [
        r#"args "${u:-${v/b/{}}" next"#,
        r#"args "${u:-${v/b/'$(x'}}" next"#,
        r#"args "${v/b/${w/y/'$(x'}}" next"#,
        r#"args "${v/b/${w/y/{}}" next"#,
        r#"args "${v/b/${u:-'$(x'}}" next"#,
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("{source}");
        };
        assert_eq!(command.args.len(), 2, "{source}");
        assert_eq!(
            command.args[0].parts.len(),
            1,
            "{source}: {:?}",
            command.args[0]
        );
        assert!(
            matches!(
                command.args[0].parts[0],
                WordPart::ParameterExpansion { .. }
            ),
            "{source}"
        );
        assert!(
            matches!(command.args[1].parts.as_slice(), [WordPart::Literal(next)] if next == "next")
        );
    }
}

#[test]
fn admitted_scalar_tokens_retain_quote_and_pattern_context() {
    for (source, outer_quoted, pattern, expected) in [
        (r#"${u:-"don't"}"#, false, false, r#""don't""#),
        (r#"${u:-"'"}"#, true, false, r#""'""#),
        (r#"${u:-'$(x'}"#, true, true, r#"'$(x'"#),
        (r#"${u:-'${x}'}"#, true, false, r#"'${x}'"#),
        (r#"${u:-"a}b"}"#, true, false, r#""a}b""#),
    ] {
        let part =
            Parser::parse_parameter_token_with_limits(source, 32, 65536, outer_quoted, pattern)
                .unwrap();
        let WordPart::ParameterExpansion { operand, .. } = part else {
            panic!("lost admitted token: {source}");
        };
        assert_eq!(operand, expected, "{source}");
    }
}

#[test]
fn lazy_default_reparse_keeps_quoted_substitution_lookalikes_literal() {
    for source in [r#"${u:-'$(x'}"#, r#"${u:-'${x'}"#] {
        let word = Parser::parse_word_string(source);
        let [WordPart::ParameterExpansion { operand, .. }] = word.parts.as_slice() else {
            panic!("lost lazy operand: {word:?}");
        };
        assert!(operand.ends_with('\''), "swallowed outer brace: {word:?}");
    }
}

#[test]
fn hash_scalar_substrings_are_not_length_expansions() {
    let word = argument("args ${#:0:1}");
    assert!(
        matches!(word.parts.as_slice(), [WordPart::Substring { name, offset, length }] if name == "#" && offset == "0" && length.as_deref() == Some("1"))
    );
    assert!(
        matches!(argument("args ${#v}").parts.as_slice(), [WordPart::Length(name)] if name == "v")
    );
}

#[test]
fn shell_body_validation_requires_separators_at_top_level() {
    for source in [
        "(missing)+(2)",
        "(18446744073709551616)>=(64#_)",
        "(echo x) echo y",
    ] {
        assert!(
            Parser::new(source)
                .with_strict_command_separators()
                .parse()
                .is_err(),
            "{source}"
        );
    }
    for source in [
        "(echo x); (echo y)",
        "(echo x)\n(echo y)",
        "(echo x) | (echo y)",
        "(echo x) && (echo y)",
    ] {
        assert!(
            Parser::new(source)
                .with_strict_command_separators()
                .parse()
                .is_ok(),
            "{source}"
        );
    }
}

#[test]
fn whole_script_defaults_preserve_original_separator_policy() {
    for name in ["a", "empty_word", "_drop7"] {
        let source =
            format!("shopt -s expand_aliases\nalias {name}=\n{name} (( value = 0 ))\necho done");
        assert!(Parser::new(&source).parse().is_ok(), "{source}");
        assert!(
            parse(&source, &ExecutionLimits::default()).is_ok(),
            "{source}"
        );
        assert!(
            Parser::new(&source)
                .with_strict_command_separators()
                .parse()
                .is_err()
        );
    }
}

#[test]
fn strict_separator_policy_reaches_nested_shell_bodies() {
    for source in [
        "echo $( (missing)+(2) )",
        "echo $( (echo x) echo y )",
        "echo <((missing)+(2))",
    ] {
        assert!(Parser::new(source).parse().is_ok(), "{source}");
        assert!(
            Parser::new(source)
                .with_strict_command_separators()
                .parse()
                .is_err(),
            "{source}"
        );
    }
    for source in ["echo $( (echo x); echo y )", "echo <((echo x); echo y)"] {
        assert!(
            Parser::new(source)
                .with_strict_command_separators()
                .parse()
                .is_ok(),
            "{source}"
        );
    }
}

#[test]
fn array_assignments_consume_one_closing_parenthesis_in_subshells() {
    for source in [
        "(alpha+=(beta))",
        "(alpha=(beta))",
        "((alpha+=(beta)))",
        "(alpha+=(beta gamma)); echo done",
    ] {
        let parsed = Parser::with_limits_and_options(source, 32, 65536, Default::default()).parse();
        assert!(parsed.is_ok(), "{source}: {parsed:?}");
    }
}

#[test]
fn nested_lists_require_separators_after_commands_and_redirects() {
    for source in [
        "(alpha|=((beta)&(3)))",
        "((alpha)>=(3))",
        "((alpha)+(beta))",
        "((alpha)**(3))",
        "((alpha)>>(beta))",
    ] {
        assert!(
            Parser::with_limits_and_options(source, 32, 65536, Default::default())
                .with_strict_command_separators()
                .parse()
                .is_err(),
            "{source}"
        );
    }
}

#[test]
fn explicit_shell_options_apply_to_the_first_pattern_group() {
    for source in [
        "+(2)",
        "echo @(alpha|beta)",
        "echo ?(alpha)",
        "echo *(alpha)",
    ] {
        assert!(
            Parser::with_limits_and_options(source, 32, 65536, Default::default())
                .parse()
                .is_err(),
            "{source}"
        );
        assert!(
            Parser::new(source).parse().is_ok(),
            "default upstream pattern mode: {source}"
        );
    }
    assert!(
        Parser::with_limits_and_options("!(2)", 32, 65536, Default::default())
            .parse()
            .is_ok()
    );
}

#[test]
fn substring_word_syntax_is_checked_before_lazy_selection() {
    for source in [
        "echo \"${present:-${v:1>(+(2))}}\"",
        "false && echo \"${v:1<(-(2))}\"",
        "f() { echo \"${v:1>(~(2))}\"; }",
    ] {
        assert!(
            matches!(
                Parser::new(source).parse(),
                Err(shell_parser::Error::ShellWord { .. })
            ),
            "{source}"
        );
    }
    for source in [
        "echo '${v:1>(+(2))}'",
        "echo \"$(( ${v:1>(+(2))} ))\"",
        "echo \"${present:-$((1>(+(2))))}\"",
        "echo \"${v:1>>(+(2))}\"",
    ] {
        assert!(Parser::new(source).parse().is_ok(), "{source}");
    }
}

#[test]
fn substring_word_validation_shares_fuel_and_request_budget() {
    use shell_parser::limits::{ExecutionBudget, ExecutionLimits, LimitExceeded};
    use std::sync::{Arc, atomic::AtomicBool};
    let source = "echo \"${v:1>(alpha beta gamma)}\"";
    assert!(Parser::with_limits(source, 32, 8).parse().is_err());
    let limits = ExecutionLimits {
        max_work_units: 8,
        ..Default::default()
    };
    let budget = ExecutionBudget::new(&limits, Arc::new(AtomicBool::new(false)));
    assert!(matches!(
        Parser::new(source).with_execution_budget(budget).parse(),
        Err(shell_parser::Error::ResourceLimit(
            LimitExceeded::WorkUnits { .. }
        ))
    ));
}

#[test]
fn substring_fields_ignore_delimiters_inside_quoted_operands() {
    for text in ["<(bad", "(", ")", "}", "{", "?:", "\\\"("] {
        let source = format!("args \"${{v:0:${{u:-'{text}'}}}}\"");
        let word = argument(&source);
        assert!(
            matches!(word.parts.as_slice(), [WordPart::Substring { name, offset, length }]
            if name == "v" && offset == "0" && length.as_deref() == Some(format!("${{u:-'{text}'}}").as_str())),
            "{source}: {word:?}"
        );
    }
}
