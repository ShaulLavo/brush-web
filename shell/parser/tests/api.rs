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
        "echo <( (missing)+(2) )",
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
    // A fused `<((` span is raw text until it expands, as `$((` is in bash.
    for source in [
        "echo $( (echo x); echo y )",
        "echo <((echo x); echo y)",
        "echo <((missing)+(2))",
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

#[test]
fn brace_punctuation_stays_literal_data_with_structural_protection() {
    for (source, segments) in [
        (
            "args {'a,b',c}",
            vec![("{", false), ("a,b", true), (",c}", false)],
        ),
        (
            r#"args {"a,b",c}"#,
            vec![("{", false), ("a,b", true), (",c}", false)],
        ),
        (
            "args {a,'}'}",
            vec![("{a,", false), ("}", true), ("}", false)],
        ),
        (
            "args {'{a,b}',c}",
            vec![("{", false), ("{a,b}", true), (",c}", false)],
        ),
        (
            r"args {'a\,b',c}",
            vec![("{", false), (r"a\,b", true), (",c}", false)],
        ),
        (
            r#"args {"a\,b",c}"#,
            vec![("{", false), (r"a\,b", true), (",c}", false)],
        ),
        (
            r"args {a\,b,c}",
            vec![("{a", false), (",", true), ("b,c}", false)],
        ),
        (
            r"args {a\\,b}",
            vec![("{a", false), ("\\", true), (",b}", false)],
        ),
        (
            r"args {'\\',x}",
            vec![("{", false), (r"\\", true), (",x}", false)],
        ),
        (
            r#"args {"\\",x}"#,
            vec![("{", false), ("\\", true), (",x}", false)],
        ),
        (
            r"args \{a,b\}",
            vec![("{", true), ("a,b", false), ("}", true)],
        ),
        (
            r#"args {"'",'"'}"#,
            vec![
                ("{", false),
                ("'", true),
                (",", false),
                ("\"", true),
                ("}", false),
            ],
        ),
        (
            r#"args {"*?[]",x}"#,
            vec![("{", false), ("*?[]", true), (",x}", false)],
        ),
    ] {
        let word = argument(source);
        let expected: Vec<_> = segments
            .into_iter()
            .flat_map(|(text, quoted)| text.chars().map(move |ch| (ch, quoted)))
            .collect();
        assert_eq!(literal_characters(&word), expected, "{source}: {word:?}");
        assert!(
            word.parts
                .iter()
                .all(|part| matches!(part, WordPart::Literal(_)))
        );
    }
}

#[test]
fn empty_quoted_parts_survive_inside_and_beside_brace_groups() {
    for source in [
        "args {'',a}",
        "args {a,''}",
        r#"args {"",a}"#,
        r#"args {a,""}"#,
        "args ''{a,b}",
        r#"args ""{a,b}"#,
        "args {a,b}''",
        r#"args {a,b}"""#,
    ] {
        let word = argument(source);
        assert!(
            word.parts
                .iter()
                .zip(&word.part_quoted)
                .any(|(part, quoted)| {
                    *quoted && matches!(part, WordPart::Literal(text) if text.is_empty())
                }),
            "{source}: {word:?}"
        );
        assert!(
            literal_characters(&word).contains(&('{', false)),
            "{source}"
        );
    }
}

#[test]
fn mixed_assignment_literals_do_not_decode_source_backslashes_as_glob_escapes() {
    for (source, expected) in [
        (r"out='a\,b'{c,d}", r"a\,b{c,d}"),
        (r"out='a\*'b*", r"a\*b*"),
        (r"out='\\'{a,b}", r"\\{a,b}"),
        (r#"out="\\"{a,b}"#, r"\{a,b}"),
        (r"out=a\\{b,c}", r"a\{b,c}"),
    ] {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("expected assignment: {source}");
        };
        let AssignmentValue::Scalar(word) = &command.assignments[0].value else {
            panic!("expected scalar: {source}");
        };
        assert_eq!(word.to_string(), expected, "{source}: {word:?}");
    }
}

#[test]
fn brace_neighbors_do_not_change_parameter_operand_boundaries_or_quote_context() {
    for source in ["args ${u:-{a,b}}", r#"args "${u:-{a,b}}""#] {
        let word = argument(source);
        assert!(
            matches!(word.parts.as_slice(), [WordPart::ParameterExpansion {
                name, operator: ParameterOp::UseDefault, operand, colon_variant: true,
            }, WordPart::Literal(suffix)] if name == "u" && operand == "{a,b" && suffix == "}"),
            "{source}: {word:?}"
        );
    }
    let word = argument(r#"args {"${u:-a,b}",c}"#);
    assert!(
        matches!(word.parts.as_slice(), [WordPart::Literal(open),
            WordPart::ParameterExpansion { name, operand, .. }, WordPart::Literal(tail)]
            if open == "{" && name == "u" && operand == "a,b" && tail == ",c}"),
        "{word:?}"
    );
    assert_eq!(word.part_quoted, [false, true, false]);
}

#[test]
fn raw_words_are_retained_before_quote_and_parameter_removal() {
    let source =
        r#"first{a,b} '${u:-{a,b}}' ${u:-{{a,b},{c,d}}}; f() { :; }; after{c,d} > 'file{a,b}'"#;
    let script = Parser::new(source).parse().unwrap();
    let Command::List(list) = &script.commands[0] else {
        panic!("expected list");
    };
    let Command::Simple(first) = list.first.as_ref() else {
        panic!("expected first command");
    };
    assert_eq!(first.name.raw.as_deref(), Some("first{a,b}"));
    assert_eq!(first.args[0].raw.as_deref(), Some("'${u:-{a,b}}'"));
    assert_eq!(first.args[1].raw.as_deref(), Some("${u:-{{a,b},{c,d}}}"));
    let Command::Simple(last) = &list.rest.last().unwrap().1 else {
        panic!("expected final command");
    };
    assert_eq!(last.name.raw.as_deref(), Some("after{c,d}"));
    assert_eq!(last.redirects[0].target.raw.as_deref(), Some("'file{a,b}'"));
}

#[test]
fn expanded_word_api_uses_word_context_not_command_grammar() {
    for source in [
        "",
        "{",
        "}",
        "[",
        "]",
        "if",
        "then",
        "out=value",
        "!",
        "#text",
    ] {
        let word = Parser::parse_expanded_word_with_limits(source, 16, 4096).unwrap();
        assert_eq!(word.to_string(), source, "{source}: {word:?}");
        assert_eq!(word.raw.as_deref(), Some(source));
        assert!(!word.quoted, "{source}: {word:?}");
    }
    for source in ["one two", "a;b", "a|b", "a>b", "a\nb", "'unclosed", "$(|)"] {
        assert!(
            Parser::parse_expanded_word_with_limits(source, 16, 4096).is_err(),
            "{source}"
        );
    }
    assert!(Parser::parse_expanded_word_with_limits("abc", 16, 3).is_err());
    assert!(Parser::parse_expanded_word_with_limits("\\a", 16, 3).is_err());
    let nested = format!("{}: {}", "$(".repeat(20), ")".repeat(20));
    assert!(Parser::parse_expanded_word_with_limits(&nested, 4, 4096).is_err());
}

#[test]
fn expanded_word_api_distinguishes_resource_limits_from_generated_syntax() {
    for source in ["abc", "\\a"] {
        assert!(matches!(
            Parser::parse_expanded_word_with_limits(source, 16, 3),
            Err(Error::ResourceLimit(LimitExceeded::ParserFuel { .. }))
        ));
    }
    // The source fits, but its literal-escape metadata needs more work.
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(r"\a", 16, 5),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
    // The source fits, but parsing its command body exhausts the shared work.
    let command = "$(echo x)";
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(command, 16, command.len() + 3),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
    assert!(matches!(
        Parser::with_fuel("echo x", 0).parse(),
        Err(Error::ResourceLimit(LimitExceeded::ParserFuel {
            used: 0,
            limit: 0
        }))
    ));
    for source in [
        "`",
        "'unclosed",
        "\"unclosed",
        "$(|)",
        "$( [[ a == ]] )",
        "one two",
        "a;b",
    ] {
        assert!(
            matches!(
                Parser::parse_expanded_word_with_limits(source, 16, 4096),
                Err(Error::Parse { .. } | Error::ShellWord { .. })
            ),
            "{source:?}"
        );
    }
}

#[test]
fn expanded_word_api_types_ast_and_lexical_depth_limits() {
    let command = format!("{}: {}", "$(".repeat(5), ")".repeat(5));
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(&command, 4, 4096),
        Err(Error::ResourceLimit(LimitExceeded::AstDepth { .. }))
    ));
    let parameter = format!("{}value{}", "${v:-".repeat(5), "}".repeat(5));
    for source in [parameter.clone(), format!("\"{parameter}\"")] {
        assert!(
            matches!(
                Parser::parse_expanded_word_with_limits(&source, 4, 4096),
                Err(Error::ResourceLimit(LimitExceeded::ParameterDepth))
            ),
            "{source}"
        );
    }
    let conditional = format!("$( [[ {}x ]] )", "! ".repeat(258));
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(&conditional, 100, 20_000),
        Err(Error::ResourceLimit(LimitExceeded::ConditionalDepth))
    ));
    // A syntax error in an earlier substitution cannot hide a later limit.
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(&format!("$(|){command}"), 4, 4096),
        Err(Error::ResourceLimit(LimitExceeded::AstDepth { .. }))
    ));
}

#[test]
fn expanded_word_api_preserves_initial_depth_for_skipped_defaults() {
    let source = format!("{}value{}", "${v:-".repeat(80), "}".repeat(80));
    Parser::new(&format!("echo {source}")).parse().unwrap();
    let word = Parser::parse_expanded_word_with_limits(
        &source,
        ExecutionLimits::default().max_ast_depth,
        4096,
    )
    .unwrap();
    assert_eq!(word.raw.as_deref(), Some(source.as_str()));
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(&source, 16, 4096),
        Err(Error::ResourceLimit(LimitExceeded::ParameterDepth))
    ));
}

#[test]
fn expanded_word_api_shares_work_across_sibling_substitutions() {
    // Boundary scans charge each body character once per pass (lexer and
    // word); the rest is one child's grammar work, which siblings must share.
    let child = "$(a;a;a;a)";
    Parser::parse_expanded_word_with_limits(child, 16, 2 * child.len() + 3 + 20).unwrap();
    let source = child.repeat(16);
    assert!(matches!(
        Parser::parse_expanded_word_with_limits(&source, 16, 2 * source.len() + 3 + 20),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
}

#[test]
fn expanded_word_api_keeps_substring_admission_failures_typed() {
    let source = format!("${{v:<({})}}", ":".repeat(4100));
    let error = Parser::parse_expanded_word_with_limits(&source, 16, 30_000).unwrap_err();
    assert!(
        matches!(
            error,
            Error::ResourceLimit(LimitExceeded::ParameterCommandFuel)
        ),
        "{error}"
    );
    assert_eq!(
        LimitExceeded::ParameterCommandFuel.to_string(),
        "parser fuel exhausted in parameter command"
    );
    let error =
        Parser::parse_expanded_word_with_limits("$(echo ${v:-${w:-x}>})", 2, 4096).unwrap_err();
    assert!(
        matches!(
            error,
            Error::ResourceLimit(LimitExceeded::ParameterBoundaryDepth)
        ),
        "{error}"
    );
}

#[test]
fn expanded_word_api_retains_literal_protection_and_expansion_name_boundaries() {
    for source in [r"'a\,b'", r#""a\,b""#, r"a\,b", r"'\\'", r#""\\""#] {
        let word = Parser::parse_expanded_word_with_limits(source, 16, 4096).unwrap();
        let ordinary = argument(&format!("args {source}"));
        assert_eq!(word.to_string(), ordinary.to_string(), "{source}");
        assert_eq!(word.quoted, ordinary.quoted, "{source}");
        let protection = |word: &Word| {
            let has_part_quotes = word.part_quoted.iter().any(|quoted| *quoted);
            word.parts
                .iter()
                .enumerate()
                .flat_map(|(index, part)| {
                    let quoted = if has_part_quotes {
                        word.part_quoted[index]
                    } else {
                        word.quoted
                    };
                    let WordPart::Literal(text) = part else {
                        panic!("expected literal")
                    };
                    text.chars().map(move |ch| (ch, quoted))
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(protection(&word), protection(&ordinary), "{source}");
    }
    let word = Parser::parse_expanded_word_with_limits(r"\`", 16, 4096).unwrap();
    assert_eq!(word.to_string(), "`");
    assert_eq!(word.part_quoted, [true]);
    let word = Parser::parse_expanded_word_with_limits("$va", 16, 4096).unwrap();
    assert!(matches!(word.parts.as_slice(), [WordPart::Variable(name)] if name == "va"));
    let word = Parser::parse_expanded_word_with_limits(r#""$v"a"#, 16, 4096).unwrap();
    assert!(
        matches!(word.parts.as_slice(), [WordPart::Variable(name), WordPart::Literal(tail)]
        if name == "v" && tail == "a")
    );
    assert_eq!(word.part_quoted, [true, false]);
    for source in [r#""""#, "''"] {
        let word = Parser::parse_expanded_word_with_limits(source, 16, 4096).unwrap();
        assert!(word.quoted, "{source}: {word:?}");
        assert_eq!(word.to_string(), "", "{source}");
    }
    let word = Parser::parse_expanded_word_with_limits(r#"""a"#, 16, 4096).unwrap();
    assert!(word.parts.iter().zip(&word.part_quoted).any(
        |(part, quoted)| *quoted && matches!(part, WordPart::Literal(text) if text.is_empty())
    ));
}

#[test]
fn ansi_control_backslash_does_not_close_an_escaped_apostrophe() {
    for (source, expected) in [(r"$'\c\''", "\u{1c}'"), (r"$'\c\\'", "\u{1c}")] {
        let word = Parser::parse_expanded_word_with_limits(source, 16, 4096).unwrap();
        assert_eq!(word.to_string(), expected, "{source}: {word:?}");
        assert!(word.quoted, "{source}: {word:?}");
    }
    assert!(Parser::parse_expanded_word_with_limits(r"$'\c\'", 16, 4096).is_err());
}

#[test]
fn dollar_continuations_preserve_logical_openers_and_raw_spelling() {
    for (source, logical) in [
        ("$\\\n'\\''", r"$'\''"),
        ("\"x\"$\\\n'\\''", r#""x"$'\''"#),
        ("$\\\n{u:-a,b}", "${u:-a,b}"),
        ("\"$\\\n{u:-a,b}\"", r#""${u:-a,b}""#),
        ("${u:-$\\\n'\\''}", r"${u:-$'\''}"),
        ("\"$\\\n'abc'\"", r#""$'abc'""#),
    ] {
        let word = Parser::parse_expanded_word_with_limits(source, 16, 4096).unwrap();
        let control = Parser::parse_expanded_word_with_limits(logical, 16, 4096).unwrap();
        assert_eq!(
            format!("{:?}", word.parts),
            format!("{:?}", control.parts),
            "{source}"
        );
        assert_eq!(word.quoted, control.quoted, "{source}");
        assert_eq!(word.raw.as_deref(), Some(source));
    }
}

#[test]
fn arithmetic_boundaries_stay_opaque_in_quotes_and_parameter_operands() {
    for expression in ["1 << 2\n", "case == in", "1 + $((2 << 3\n))", "1 + ${u:-2}"] {
        for source in [
            format!("$(({expression})){{a,b}}"),
            format!("\"$(({expression})){{a,b}}\""),
            format!("${{va:-$(({expression}))}}{{a,b}}"),
            format!("\"${{va:-$(({expression}))}}{{a,b}}\""),
        ] {
            let word = argument(&format!("args {source}"));
            assert!(
                word.parts.iter().any(|part| matches!(
                    part,
                    WordPart::ArithmeticExpansion(_) | WordPart::ParameterExpansion { .. }
                )),
                "{source}: {word:?}"
            );
            assert_eq!(word.raw.as_deref(), Some(source.as_str()));
            let generated = Parser::parse_expanded_word_with_limits(&source, 100, 16384).unwrap();
            assert_eq!(generated.raw.as_deref(), Some(source.as_str()));
            assert!(
                generated.parts.iter().any(|part| matches!(
                    part,
                    WordPart::ArithmeticExpansion(_) | WordPart::ParameterExpansion { .. }
                )),
                "{source}: {generated:?}"
            );
        }
    }
}

#[test]
fn arithmetic_expansion_source_preserves_dollar_quote_boundaries() {
    for expression in [
        r#"0 + "$"((1+2))"#,
        r#"0 + "\$"((1+2))"#,
        r"0 + \$((1+2))",
        r#"0 + "$((1+2))""#,
    ] {
        let token = format!("$(({expression}))");
        let part = Parser::parse_substitution_token_with_limits(&token, 100, 16384).unwrap();
        assert!(matches!(&part, WordPart::ArithmeticExpansion(source) if source == expression));
        for source in [token.clone(), format!("\"{token}\"")] {
            let word = argument(&format!("args {source}"));
            assert!(
                matches!(word.parts.as_slice(), [WordPart::ArithmeticExpansion(text)] if text == expression),
                "{source}: {word:?}"
            );
            let generated = Parser::parse_expanded_word_with_limits(&source, 100, 16384).unwrap();
            assert!(
                matches!(generated.parts.as_slice(), [WordPart::ArithmeticExpansion(text)] if text == expression),
                "{source}: {generated:?}"
            );
            assert_eq!(word.raw.as_deref(), Some(source.as_str()));
            assert_eq!(generated.raw.as_deref(), Some(source.as_str()));
        }
    }
}

#[test]
fn ambiguous_substitutions_preserve_inactive_defaults_and_suffixes() {
    for source in [
        r#"v=ok; printf '<%s>\n' ${v:-$((case x in x) :;; esac) )}{a,b}"#,
        r#"v=ok; printf '<%s>\n' "${v:-$((case x in x) :;; esac) )}{a,b}""#,
        r#"v=ok; printf '<%s>\n' ${v:-$(echo "${u:-\${x}")}{a,b}"#,
        r#"v=ok; printf '<%s>\n' "${v:-$(echo "${u:-\${x}")}{a,b}""#,
    ] {
        Parser::new(source)
            .parse()
            .unwrap_or_else(|error| panic!("{source}: {error:?}"));
    }
    for source in [
        "${v:-$((printf é) )}{a,b}",
        "\"${v:-$((printf é) )}{a,b}\"",
        r#"${v:-$(echo "${u:-\$$(printf x)}")}{a,b}"#,
        "$((1 << 2)\\\n){a,b}",
    ] {
        let word = argument(&format!("args {source} suffix"));
        assert_eq!(word.raw.as_deref(), Some(source), "{source}");
        let generated = Parser::parse_expanded_word_with_limits(source, 100, 16384).unwrap();
        assert_eq!(generated.raw.as_deref(), Some(source), "{source}");
    }
}

#[test]
fn arithmetic_command_spans_preserve_utf8_and_later_tokens() {
    for source in [
        "$((printf é) )",
        "\"$((printf é) )\"",
        "\"\"$((printf é) )",
        "${v:-$((printf é) )}",
        "\"${v:-$((printf é) )}\"",
        "$( (printf é # (\n) )",
        "\"$( (printf é # (\n) )\"",
    ] {
        let script = Parser::new(&format!("args é {source} suffix"))
            .parse()
            .unwrap();
        let Command::Simple(command) = &script.commands[0] else {
            panic!("{script:?}");
        };
        assert_eq!(command.args.len(), 3, "{source}: {command:?}");
        assert_eq!(command.args[0].raw.as_deref(), Some("é"));
        assert_eq!(command.args[1].raw.as_deref(), Some(source));
        assert_eq!(command.args[2].to_string(), "suffix");
    }
}

#[test]
fn arithmetic_candidates_cannot_reinterpret_unmatched_raw_parens_as_comments() {
    for candidate in ["$((printf é # (\n))", "$((# (\nprintf é) )"] {
        for source in [
            candidate.to_string(),
            format!("\"{candidate}\""),
            format!("${{v:-{candidate}}}"),
            format!("\"${{v:-{candidate}}}\""),
        ] {
            assert!(
                Parser::new(&format!("args {source} suffix"))
                    .parse()
                    .is_err(),
                "{source}"
            );
            assert!(
                Parser::parse_expanded_word_with_limits(&source, 100, 16384).is_err(),
                "{source}"
            );
        }
    }
    // Three raw closes balance the lexical candidate. Its malformed command
    // body is not eagerly parsed when the containing default is unselected.
    for source in [
        "${v:-$((# (\nprintf é) ) )}",
        "\"${v:-$((# (\nprintf é) ) )}\"",
    ] {
        let word = argument(&format!("args {source} suffix"));
        assert_eq!(word.raw.as_deref(), Some(source));
    }
}

#[test]
fn substitution_boundary_scanning_is_charged_to_parser_fuel() {
    let source = format!("args $((printf '%s' '{}') )", "x".repeat(128));
    let error = Parser::with_limits(&source, 100, 64).parse().unwrap_err();
    assert!(
        matches!(
            error,
            Error::ResourceLimit(LimitExceeded::ParserFuel { .. })
        ),
        "{error:?}"
    );
    let limits = ExecutionLimits {
        max_work_units: 64,
        ..ExecutionLimits::default()
    };
    assert!(matches!(
        parse(&source, &limits),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
    let eof_source = format!("args $((printf '{}' # (\n)) suffix", "x".repeat(128));
    assert!(matches!(
        parse(&eof_source, &limits),
        Err(Error::ResourceLimit(LimitExceeded::WorkUnits { .. }))
    ));
}

#[test]
fn resolved_substitution_kind_controls_the_ast_without_rewriting_source() {
    for source in [
        "$((printf é) )",
        "\"$((printf é) )\"",
        "\"\"$((printf é) )",
        "$( (case x in x) :;; esac) )",
    ] {
        let word = argument(&format!("args {source} suffix"));
        assert!(
            word.parts
                .iter()
                .any(|part| matches!(part, WordPart::CommandSubstitution(_))),
            "{source}: {word:?}"
        );
        assert!(
            !word
                .parts
                .iter()
                .any(|part| matches!(part, WordPart::ArithmeticExpansion(_))),
            "{source}: {word:?}"
        );
        assert_eq!(word.raw.as_deref(), Some(source));
    }
    for source in [
        "$((1 << 2)\\\n)",
        "$(\\\n(1 << 2))",
        "\"$((1 << 2)\\\n)\"",
        "\"\"$((1 << 2)\\\n)",
    ] {
        let word = argument(&format!("args {source} suffix"));
        assert!(word.parts.iter().any(|part| matches!(part, WordPart::ArithmeticExpansion(expression) if expression == "1 << 2")), "{source}: {word:?}");
        assert_eq!(word.raw.as_deref(), Some(source));
    }
}

#[test]
fn substitution_end_of_input_and_heredoc_boundaries_follow_bash() {
    let strict = |source: &str| {
        Parser::new(source)
            .with_strict_substitution_bodies()
            .parse()
    };
    // A redirection with no target before the end of input is bash's token
    // error (127); an operator that waits for more input is the EOF error (2).
    for source in [
        "echo $(echo <",
        "echo $(echo >",
        "echo $(echo <<",
        "echo <(echo <",
        // A keyword that needs its word on the same line.
        "echo $(case",
        "echo <(case",
        "echo $(for",
        "echo $(select",
        "echo $(function",
        // `)` after `;;` is no pattern terminator.
        "echo $(case x in x) :;;)",
    ] {
        assert!(
            matches!(strict(source), Err(Error::ShellWord { .. })),
            "{source}"
        );
    }
    // A trailing line continuation joins the end of input: the EOF error.
    for source in [
        "echo $(case x",
        "echo $(case x in",
        "echo $(while",
        "echo $(echo |",
        "echo $(if true",
        "echo $( (x)",
        "echo $(echo <\\\n",
        "echo $(echo >\\\n",
        "echo $(echo <<\\\n",
    ] {
        assert!(
            matches!(strict(source), Err(Error::Parse { .. })),
            "{source}"
        );
    }
    assert!(matches!(
        strict("echo <(echo <)"),
        Err(Error::ShellWord { .. })
    ));
    // Fused `<((` text is not parsed before it expands; here-documents may end
    // at `delimiter)` and their delimiter may spell a `$(...)` word.
    for source in [
        "echo <((if true; then : fi))",
        "echo $(cat <<E\nx\nE)",
        "echo $(cat <<-E\n\tx\n\tE)",
        "echo $(cat <<'E'\nx\nE)",
        "echo $(cat <<$(echo E)\nx\n$(echo E)\n)",
        // A nested `$(` in the delimiter is scanned like any substitution.
        "echo $(cat <<$(echo \\))\nX\n$(echo \\))\n)",
        "echo $(cat <<$(echo ${x:-)})\nX\n$(echo ${x:-)})\n)",
        "echo $(cat <<-$(echo \\))\nX\n\t$(echo \\))\n)",
        // A continuation inside the delimiter, and quotes in a nested `$(`.
        "echo $(printf x <<foo\\\nbar\nfoobar\n)",
        "echo $(printf x <<-foo\\\nbar\n\tfoobar\n)",
        "echo $(printf x <<$(echo ')')\nx\n$(echo ')')\n)",
        // Escaped metacharacters belong to the delimiter (`foo)`, `$(`).
        "echo $(printf x <<foo\\)\nfoo)\n)",
        "echo $(printf x <<-foo\\)\n\tfoo)\n)",
        "echo $(printf x <<\\$\\(\n$(\n)",
    ] {
        strict(source).unwrap_or_else(|error| panic!("{source:?}: {error}"));
    }
}

#[test]
fn captured_body_validation_uses_substitution_heredoc_boundaries() {
    for source in ["(: <<EOF\nbody\nEOF)", "(: <<-EOF\n\tbody\n\tEOF)"] {
        Parser::new(source)
            .with_substitution_body()
            .parse()
            .unwrap_or_else(|error| panic!("{source:?}: {error}"));
        assert!(
            Parser::new(source)
                .with_strict_command_separators()
                .parse()
                .is_err(),
            "ordinary script grammar keeps the delimiter distinct: {source:?}"
        );
    }
}

fn trailing_simple_command(script: &Script) -> &shell_parser::parser::SimpleCommand {
    let mut command = script.commands.last().expect("the script has a command");
    while let Command::List(list) = command {
        command = list
            .rest
            .last()
            .map_or(list.first.as_ref(), |(_, command)| command);
    }
    let Command::Simple(command) = command else {
        panic!("expected trailing simple command");
    };
    command
}

#[test]
fn quoted_heredoc_delimiters_preserve_substitution_and_operand_boundaries() {
    // Bash 5.3.15 accepts the continuation and escaped-quote controls with
    // status 0, including an unselected default containing the process body.
    for (delimiter, eof) in [
        ("\"EO\\\nF\"", "EOF"),
        ("\"E\\\"OF\"", "E\"OF"),
        ("\"E\\\\OF\"", "E\\OF"),
        ("\"E\\$OF\"", "E$OF"),
        ("\"E\\`OF\"", "E`OF"),
        ("\"E\\qOF\"", "E\\qOF"),
        ("'E\\\"OF'", "E\\\"OF"),
    ] {
        let body = format!(": <<{delimiter}\nbody\n{eof}\n");
        for source in [
            format!("args \"$({body})\" suffix"),
            format!("args <({body}) suffix"),
            format!("v=guard; args \"${{v:-<({body})}}\" suffix"),
        ] {
            let script = Parser::new(&source)
                .with_strict_substitution_bodies()
                .parse()
                .unwrap_or_else(|error| panic!("{source:?}: {error}"));
            let command = trailing_simple_command(&script);
            assert_eq!(command.name.to_string(), "args", "{source:?}");
            assert_eq!(command.args.len(), 2, "{source:?}");
            assert_eq!(command.args[1].to_string(), "suffix", "{source:?}");
        }
    }
}

#[test]
fn heredoc_backticks_keep_typed_deferred_substitutions() {
    for (body, expected) in [
        ("(printf x)", "command"),
        ("printf '('", "command"),
        ("fi", "deferred"),
    ] {
        let source = format!("cat <<EOF\n`{body}`\nEOF\n");
        let script = Parser::new(&source)
            .parse()
            .unwrap_or_else(|error| panic!("{source:?}: {error}"));
        let Command::Simple(command) = &script.commands[0] else {
            panic!("expected simple heredoc command: {source:?}");
        };
        let target = &command.redirects[0].target;
        match (expected, target.parts.first()) {
            ("command", Some(WordPart::CommandSubstitution(_))) => {}
            ("command", other) => panic!("expected typed command substitution: {other:?}"),
            ("deferred", Some(WordPart::UnparsedCommandSubstitution { source, .. })) => {
                assert_eq!(source.as_str(), body);
            }
            ("deferred", other) => panic!("expected deferred backtick body: {other:?}"),
            _ => unreachable!(),
        }
    }
}

#[test]
fn process_substitution_printer_charges_flat_elif_output() {
    let mut source = String::from("echo \"${unset:-<(if false; then :;");
    for _ in 0..256 {
        source.push_str(" elif false; then :;");
    }
    source.push_str(" fi)}\"\n");
    let result = Parser::new(&source).parse();
    assert!(
        matches!(
            &result,
            Err(Error::ResourceLimit(LimitExceeded::ParserFuel { .. }))
        ),
        "flat elif printing must consume the parser budget: {result:?}"
    );
}

#[test]
fn last_async_lazy_operators_are_scalar_nodes_and_named_bang_targets_stay_indirect() {
    for (operator, expected) in [
        ("-", ParameterOp::UseDefault),
        ("+", ParameterOp::UseReplacement),
        ("=", ParameterOp::AssignDefault),
        ("?", ParameterOp::Error),
    ] {
        for colon in [false, true] {
            let colon_text = if colon { ":" } else { "" };
            let token = format!("${{!{colon_text}{operator}operand}}");
            let part =
                Parser::parse_parameter_token_with_limits(&token, 16, 1024, true, false).unwrap();
            assert!(
                matches!(part, WordPart::ParameterExpansion {
                name, operator, operand, colon_variant,
            } if name == "!" && operator == expected && operand == "operand" && colon_variant == colon),
                "{token}"
            );
        }
    }
    let word = argument("echo \"${!pointer+operand}\"");
    assert!(
        matches!(&word.parts[0], WordPart::IndirectExpansion { name, operator: Some(ParameterOp::UseReplacement), .. } if name == "pointer")
    );
}
