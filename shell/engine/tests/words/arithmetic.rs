//! GNU Bash 5.3 scalar arithmetic regressions. Operator/bases cases adapt
//! Bashkit arithmetic.rs unit tests and spec_cases/bash/arithmetic.test.sh at
//! 491c3281f668b76d64b15210b8f5d7bf97244be0; async resource tests are original.
use super::*;

#[test]
fn scalar_operators_precedence_bases_and_wrapping() {
    let rig = Rig::new(Limits::default());
    let cases = [
        ("1+2*3", "7"),
        ("2**3**2", "512"),
        ("-2**2", "4"),
        ("1<<2+1", "8"),
        ("32>>2", "8"),
        ("-1>>65", "-1"),
        ("7/3", "2"),
        ("7%3", "1"),
        ("~0", "-1"),
        ("!3", "0"),
        ("1<2", "1"),
        ("1<=1", "1"),
        ("3>2", "1"),
        ("3>=4", "0"),
        ("1==1", "1"),
        ("1!=1", "0"),
        ("1|2&4", "1"),
        ("7^3", "4"),
        ("1||0&&0", "1"),
        ("1,2,3", "3"),
        ("0x1f+017+2#101", "51"),
        ("64#@+64#_", "125"),
        ("36#Z", "35"),
        ("0x", "0"),
        ("99999999999999999999", "7766279631452241919"),
        ("9223372036854775807+1", "-9223372036854775808"),
        ("-9223372036854775808/-1", "-9223372036854775808"),
        ("-9223372036854775808%-1", "0"),
        ("2**64", "0"),
        ("5++1", "6"),
        ("5--1", "6"),
        ("--5", "5"),
    ];
    for (source, expected) in cases {
        assert_eq!(rig.run(&format!("args \"$(({source}))\"")), 0, "{source}");
        assert_eq!(rig.calls.borrow().last().unwrap(), &[expected], "{source}");
    }
}

#[test]
fn assignments_incdec_and_rhs_order_are_durable() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("x=7; args \"$((x+=x=4))\" \"$x\"; args \"$((x=y=9,x++ + ++x))\" \"$x\" \"$y\""),
        0
    );
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["11", "11"], vec!["20", "11", "9"]]
    );
    let operations = [
        ("+=", "10"),
        ("-=", "4"),
        ("*=", "21"),
        ("/=", "2"),
        ("%=", "1"),
        ("<<=", "56"),
        (">>=", "0"),
        ("&=", "3"),
        ("^=", "4"),
        ("|=", "7"),
    ];
    for (op, expected) in operations {
        assert_eq!(rig.run(&format!("x=7; args \"$((x{op}3))\" \"$x\"")), 0);
        assert_eq!(rig.calls.borrow().last().unwrap(), &[expected, expected]);
    }
}

#[test]
fn short_circuit_skips_arithmetic_not_shell_expansion() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x=1; y=2; args \"$((0&&(x=9)))\" \"$((1||(y=9)))\" \"$((1?x++:y++))\" \"$((0?1/0:3))\" \"$x\" \"$y\""), 0);
    assert_eq!(
        *rig.calls.borrow().last().unwrap(),
        ["0", "1", "1", "3", "2", "2"]
    );
    assert_eq!(rig.run("args \"$((0 && ${missing:=4}))\" \"$missing\""), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["0", "4"]);
}

#[test]
fn recursive_scalars_and_dollar_preexpansion_have_distinct_order() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x=1; y='x+2'; args \"$((y))\"; args \"$((x=2,$x))\" \"$x\"; x=1; args \"$((x=2,$((x+1))))\" \"$x\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["3"], vec!["1", "2"], vec!["2", "2"]]
    );
    assert_eq!(rig.run("x='y=4'; y=0; args \"$((x))\" \"$y\""), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["4", "4"]);
}

#[test]
fn arithmetic_commands_and_let_errors_do_not_abort_following_commands() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x=0; ((x=9,1/0)); args \"$?\" \"$x\"; let 'x=4,08' 'x=99'; args \"$?\" \"$x\"; let 0 'x=3'; args \"$?\" \"$x\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["1", "9"], vec!["1", "4"], vec!["0", "3"]]
    );
    assert_eq!(rig.run("x=1; let 'x=2,$x'; args \"$?\" \"$x\""), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["1", "2"]);
}

#[test]
fn expansion_errors_abort_and_completed_writes_survive() {
    for expression in ["x=9,1/0", "x=9,08", "x=9,2**-1", "x=9,1+", "x=9,1=2"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("x=0; args \"$(({expression}))\"; args after")),
            1,
            "{expression}"
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.shell.state().borrow().variables.get("x").unwrap(), "9");
        assert!(!rig.errors.bytes().is_empty());
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("(( $((1/0)) )); args after"), 1);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn scalar_substrings_use_arithmetic_and_snapshot_source() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=abcdef; x=1; args \"${v:x+1:2*2}\" \"${v: -3: -1}\"; args \"${v:(v=3):1}\" \"$v\"; v=abcdef; args \"${v:1:(v=2)}\" \"$v\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["cdef", "de"], vec!["d", "3"], vec!["bc", "2"]]
    );
}

#[test]
fn unset_and_out_of_range_slices_skip_unneeded_arithmetic() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x=0; args \"${missing:x++:1/0}\" \"$x\"; v=abc; args \"${v:99:(x=9)}\" \"${v: -99:1/0}\" \"$x\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["", "0"], vec!["", "", "0"]]);
    assert_eq!(rig.run("v=''; args \"${v:0:-1}\"; args after"), 1);
}

#[test]
fn substring_utf8_and_special_scalars() {
    let rig = Rig::new(Limits::default());
    rig.variable("LC_ALL", "C.UTF-8");
    assert_eq!(rig.run("v='hé日本'; args \"${v:1:2}\" \"${v: -2:1}\" \"${PWD:0:5}\" \"${?:0:1}\"; f() { args \"${1:1:2}\" \"${#:0:1}\"; }; f abcd xyz"), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["é日", "日", "/home", "0"], vec!["bc", "2"]]
    );
}

#[test]
fn arithmetic_unavailable_categories_remain_explicit() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("args \"$((a[0]))\""), 2);
    assert_eq!(rig.run("args \"${array[@]:1:2}\""), 2);
}

#[test]
fn nested_arithmetic_operands_and_scalar_slices_are_supported() {
    check(
        "v=abc; args ${v^^$((1+2))} ${v^^${v:1}} ${v#$((1+2))} ${v#${v:1}} ${u:-$((1+2))}",
        &[&["abc", "abc", "abc", "abc", "3"]],
    );
    check(
        "f() { args \"${unused:-${1:1:1}}\" \"${unused:-${#:0:1}}\" \"${unused:-${?:0:1}}\"; }; f abc",
        &[&["b", "1", "0"]],
    );
    check("x=1; args \"${u:-$((1 + ${x:-')'}))}\"", &[&["2"]]);
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("args ${u:?$((1+2))}; args after"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert!(String::from_utf8(rig.errors.bytes()).unwrap().contains("3"));
}

#[test]
fn malformed_lengths_are_fatal_in_selected_operands() {
    for token in [
        "${#x-default}",
        "${#x/foo/bar}",
        "${#x:1}",
        "${#!x}",
        "${#,,}",
    ] {
        for source in [
            format!("args {token}; args after"),
            format!("args ${{u:-{token}}}; args after"),
        ] {
            let rig = Rig::new(Limits::default());
            assert_eq!(rig.run(&source), 1, "{source}");
            assert!(rig.calls.borrow().is_empty(), "{source}");
        }
    }
}

#[test]
fn terminating_recursive_scalars_observe_intermediate_writes() {
    check("x='(x=1)+x'; args \"$((x))\" \"$x\"", &[&["2", "1"]]);
    check(
        "x='(y-=1)>0?x:1'; y=3; args \"$((x))\" \"$y\"",
        &[&["1", "0"]],
    );
}

#[test]
fn arithmetic_side_effects_refresh_ifs_for_the_whole_word() {
    check("IFS=,; v=a1b; args pre$v$((IFS=1))", &[&["prea", "b"]]);
    check(
        "IFS=,; v=a1b; s=abc; args pre$v${s:(IFS=1):1}",
        &[&["prea", "bb"]],
    );
    check(
        "IFS=,; v=a1b; args pre$v$(( ${z:=$((IFS=1))} ))",
        &[&["prea", "b"]],
    );
}

#[test]
fn substring_arithmetic_errors_are_fatal_in_arithmetic_commands() {
    for source in [
        "v=abc; (( ${v:1/0} )); args after",
        "v=abc; (( ${v:0:-9} )); args after",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn byte_locale_substrings_require_valid_utf8_boundaries() {
    let rig = Rig::new(Limits::default());
    rig.variable("LC_ALL", "C");
    assert_eq!(rig.run("v='aéb'; args \"${v:1:2}\""), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["é"]);
    assert_eq!(rig.run("v='aéb'; args \"${v:1:1}\""), 2);
}

#[test]
fn unchanged_writes_do_not_hide_arithmetic_recursion() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x='(y=1)+x'; y=3; args \"$((x))\"; args after"), 1);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.shell.state().borrow().variables["y"], "1");
}

#[test]
fn every_recursive_scalar_form_reaches_its_bounded_depth_without_stack_growth() {
    // Run this unchanged in native and WASI suites. Walk through the deepest
    // accepted form, not only an oversized input rejected by the outer parser.
    for form in [
        "indirect",
        "default",
        "replacement",
        "arithmetic",
        "substring",
    ] {
        let mut expression = "1".to_owned();
        let mut rejected = false;
        for depth in 1..=40 {
            expression = match form {
                "indirect" => format!("${{!p:-{expression}}}"),
                "default" => format!("${{u:-{expression}}}"),
                "replacement" => format!("${{v/1/{expression}}}"),
                "arithmetic" => format!("$(({expression}))"),
                "substring" => format!("${{v:0:{expression}}}"),
                _ => unreachable!(),
            };
            eprintln!("depth trace {form} {depth}");
            let rig = Rig::new(Limits::default());
            rig.variable("p", "missing");
            rig.variable("v", "1");
            let code = rig.run(&format!("args \"{expression}\""));
            if code == 2 {
                assert!(depth >= 8, "{form} rejected too early at depth {depth}");
                assert!(rig.calls.borrow().is_empty(), "{form} depth {depth}");
                rejected = true;
                break;
            }
            assert_eq!(code, 0, "{form} depth {depth}");
            assert_eq!(*rig.calls.borrow(), [vec!["1"]], "{form} depth {depth}");
        }
        assert!(rejected, "{form} never reached its explicit depth bound");
    }
}

#[test]
fn arithmetic_errors_discard_the_read_unit_and_resume_at_top_level_newline() {
    for command in [
        "args $((1/0))",
        "result=$((1/0))",
        "args $((echo unexpected [))",
        "v=abc; args ${v:1/0}",
        "v=abc; args ${v:1>>(+(2))}",
        "{ args $((1/0)); args inner; }",
        "f() { args $((1/0)); args inner; }; f",
        "args $((1/0)) && args inner",
        "args $((1/0)) || args inner",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("{command}; args skipped\nargs after=$?")),
            0,
            "{command}"
        );
        assert_eq!(*rig.calls.borrow(), [vec!["after=1"]], "{command}");
        assert!(!rig.errors.bytes().is_empty());
    }
}

#[test]
fn positional_substrings_preserve_selected_empty_fields_and_shell_name() {
    check(
        "f() { args \"${@:0:2}\"; args \"${@:2:2}\"; args \"${@: -1}\"; args \"${@:99:1/0}\"; }; f 'a b' '' c",
        &[&["bash", "a b"], &["", "c"], &["c"], &[]],
    );
    check(
        "f() { args \"${unused:-${@:2:2}}\"; }; f a '' c",
        &[&["", "c"]],
    );
}

#[test]
fn positional_slice_arithmetic_orders_effects_and_rejects_negative_lengths() {
    check(
        "x=1; f() { args \"${@:x++:1}\" \"$x\"; }; f a b",
        &[&["a", "2"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("f() { args \"${@:1:-1}\"; args forbidden; }; f a b"),
        1
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn cancelling_positional_slice_emission_keeps_writes_and_unwinds_function_arguments() {
    let rig = Rig::new(Limits::default());
    let value = "x".repeat(1024);
    let source = format!("f() {{ args \"${{@:(started=1):2}}\"; }}; f '{value}' '{value}'");
    let job = rig.shell.start(&source).unwrap();
    rig.drive_until_variable("started", "1");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args \"$#\" \"$started\""), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["0", "1"]]);
}

#[test]
fn whole_script_parsing_preserves_empty_alias_arithmetic_compatibility() {
    for name in ["a", "empty_word", "_drop7"] {
        let source =
            format!("shopt -s expand_aliases\nalias {name}=\n{name} (( value = 0 ))\necho done");
        check_output(&source, "done\n");
    }
}

#[test]
fn substring_shell_boundaries_preserve_general_shell_grammar() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("v=abcdef; x=3; y=1; args \"${v:(x>>((y+=(1)))):1}\" \"$y\""),
        0
    );
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["a", "2"]);
    assert_eq!(rig.run("v=abcdef; args \"${v:(4>>(!(2))):1}\""), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["e"]);
}

#[test]
fn substring_shell_boundary_failures_are_typed_and_fatal() {
    for (expression, expected) in [
        ("(1)>(+(2))", 127),
        ("(1)<(-(3))", 127),
        ("(1)>>(+(2))", 1),
        ("(1)<<(~(3))", 1),
        ("(1)>((2)+(3))", 1),
        ("(1)>>((alpha|=(3)))", 1),
    ] {
        for context in ["word", "arithmetic", "function"] {
            check_substring_boundary_failure(expression, expected, context);
        }
    }
}

fn check_substring_boundary_failure(expression: &str, expected: i32, context: &str) {
    let rig = Rig::new(Limits::default());
    let slice = format!("${{v:({expression}):1}}");
    let source = match context {
        "arithmetic" => format!("v=abcdef; (( {slice} )); args forbidden"),
        "function" => {
            format!("v=abcdef; f() {{ args \"{slice}\"; args forbidden; }}; f; args forbidden")
        }
        _ => format!("v=abcdef; args \"{slice}\"; args forbidden"),
    };
    assert_eq!(
        rig.run(&source),
        if context == "arithmetic" { 1 } else { expected },
        "{source}"
    );
    assert!(rig.calls.borrow().is_empty(), "{source}");
}

#[test]
fn substring_word_errors_are_eager_but_expansion_errors_remain_lazy() {
    for source in [
        "present=ok; args \"${present:-${v:(1>(+(2))):1}}\"; args forbidden",
        "false && args \"${v:(1>(-(2))):1}\"; args forbidden",
        "f() { args \"${v:(1<(~(2))):1}\"; }; args forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 127, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("present=ok; args \"${present:-${v:(1>>(+(2))):1}}\"; args forbidden"),
        1
    );
    assert!(rig.calls.borrow().is_empty());
    check(
        "false && args \"${v:(1>>((2)+(3))):1}\"; args after",
        &[&["after"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("v=abc; args \"$(( ${v:(1>(+(2))):1} ))\"; args forbidden"),
        1
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn substring_boundary_scans_yield_cancel_and_admit_storage_before_arithmetic() {
    let spaces = " ".repeat(900);
    let source = format!("args \"${{v:(x=9,1>>({spaces}1)):1}}\"");
    let rig = Rig::new(Limits::default());
    rig.variable("v", "abcdef");
    rig.variable("x", "0");
    let job = rig.shell.start(&source).unwrap();
    rig.ex.drive(1);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.shell.state().borrow().variables["x"], "0");
    assert!(rig.calls.borrow().is_empty());

    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    rig.variable("v", "abcdef");
    rig.variable("x", "0");
    assert_eq!(rig.run(&source), 2);
    assert_eq!(rig.shell.state().borrow().variables["x"], "0");
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn substring_checks_leave_opaque_arithmetic_substitutions_unevaluated() {
    check("present=ok; args \"${present:-$((1>(+(2))))}\"", &[&["ok"]]);
    check("unset absent; args \"${absent:-$((1>(+(2))))}\"", &[&["0"]]);
}

#[test]
fn substring_word_errors_preserve_completed_earlier_lines() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("echo before\nargs \"${v:1>(+(2))}\"; args forbidden"),
        127
    );
    assert_eq!(rig.output.bytes(), b"before\n");
    assert!(rig.calls.borrow().is_empty());
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("exit 5\nargs \"${v:1>(+(2))}\""), 5);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn substring_boundary_storage_stops_at_the_matching_parenthesis() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", "abcdef");
    let source = format!("args \"${{v:(1>>(1){}):1}}\"", " ".repeat(3000));
    assert_eq!(rig.run(&source), 0);
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["a"]);
}

#[test]
fn quoted_boundary_text_in_unselected_substring_operands_stays_lazy() {
    check(
        "v=abcdef; u=2; args \"${v:0:${u:-'<(bad'}}\"; args after",
        &[&["ab"], &["after"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("v=abcdef; args \"${v:0:${u:-'<(bad'}}\"; args forbidden"),
        1
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn a_later_word_error_remains_visible_after_an_arithmetic_read_unit_error() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("args $((1/0))\nargs \"${v:1>(+(2))}\""), 127);
    assert!(rig.calls.borrow().is_empty());
}
