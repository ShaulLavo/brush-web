//! Original brace controls: ordered source expansion, opaque scalar syntax, and
//! engine resource/cancellation contracts. These run unchanged natively and on
//! wasm32-wasip1; no subprocess, host thread, or platform stack-size assumption.
use super::*;

#[test]
fn brace_lists_preserve_source_order_duplicates_and_cartesian_order() {
    check(
        "args pre{red,blue,green}post {one,two}{1,2} {same,same} {z,{a,b},q}",
        &[&[
            "preredpost",
            "prebluepost",
            "pregreenpost",
            "one1",
            "one2",
            "two1",
            "two2",
            "same",
            "same",
            "z",
            "a",
            "b",
            "q",
        ]],
    );
    check(
        "args {a,b}{1,{2,3}} {é,🙂}",
        &[&["a1", "a2", "a3", "b1", "b2", "b3", "é", "🙂"]],
    );
}

#[test]
fn brace_variants_expand_parameters_and_arithmetic_in_final_word_order() {
    check(
        r#"n=0; args {a,b}$((n+=1)){x,y}; args "$n"; args {${saved:=first},${saved:=second}} "$saved""#,
        &[
            &["a1x", "a2y", "b3x", "b4y"],
            &["4"],
            &["first", "first", "first"],
        ],
    );
}

#[test]
fn brace_numeric_ranges_follow_endpoints_and_normalize_steps() {
    check(
        "args {1..4} {4..1} {1..7..2} {7..1..-2} {1..3..0} {3..1..2} {2..2..99}",
        &[&[
            "1", "2", "3", "4", "4", "3", "2", "1", "1", "3", "5", "7", "7", "5", "3", "1", "1",
            "2", "3", "3", "1", "2",
        ]],
    );
    check(
        "args {-02..2} {+01..+3} {001..3} {03..-1..2} {-3..3..-2}",
        &[&[
            "-02", "-01", "000", "001", "002", "1", "2", "3", "001", "002", "003", "03", "01",
            "-1", "-3", "-1", "1", "3",
        ]],
    );
    check(
        "args {9223372036854775806..9223372036854775807} {-9223372036854775808..-9223372036854775807} {1..3..-9223372036854775808}",
        &[&[
            "9223372036854775806",
            "9223372036854775807",
            "-9223372036854775808",
            "-9223372036854775807",
            "1",
        ]],
    );
}

#[test]
fn brace_ascii_ranges_include_cross_case_punctuation_and_the_empty_backslash() {
    check(
        "args {a..e..2} {e..a..-2} {Z..a}",
        &[&[
            "a", "c", "e", "e", "c", "a", "Z", "[", "", "]", "^", "_", "`", "a",
        ]],
    );
}

#[test]
fn brace_invalid_enclosing_groups_never_become_new_expansion_syntax() {
    check(
        "args {{1..2}..3} {{a,b}} {a{b,c}} {x..{a,b}} {left,{x,y}right}",
        &[&[
            "{1..3}", "{2..3}", "{a}", "{b}", "{ab}", "{ac}", "{x..a}", "{x..b}", "left", "xright",
            "yright",
        ]],
    );
    check(
        "args {one} {} {1..x} {1..2..x} {1..2..3..4} {a..é} {9223372036854775808..2} pre{a,b post}suffix",
        &[&[
            "{one}",
            "{}",
            "{1..x}",
            "{1..2..x}",
            "{1..2..3..4}",
            "{a..é}",
            "{9223372036854775808..2}",
            "pre{a,b",
            "post}suffix",
        ]],
    );
}

#[test]
fn brace_quotes_and_escapes_protect_only_the_source_characters_they_cover() {
    check(
        r#"args \{a,b\} "{a,b}" '{a,b}' {a\,b,c} {'a,b',c} {a,"b,c"} {a\},b}; args "pre"{a,b}'post' \${left,right}"#,
        &[
            &[
                "{a,b}", "{a,b}", "{a,b}", "a,b", "c", "a,b", "c", "a", "b,c", "a}", "b",
            ],
            &["preapost", "prebpost", "$left", "$right"],
        ],
    );
}

#[test]
fn brace_empty_alternatives_keep_explicit_quotes_but_drop_unquoted_null_words() {
    check(
        r#"args {,} {,,} {"",''} {,""} pre{,}post {a,,b}; args {,$missing} {"$missing",$missing} {,}suffix"#,
        &[
            &["", "", "", "prepost", "prepost", "a", "b"],
            &["", "suffix", "suffix"],
        ],
    );
    check(
        r#"args {"",a}{'',b} {"",''}"""#,
        &[&["", "b", "a", "ab", "", ""]],
    );
}

#[test]
fn brace_relexes_unbraced_variable_names_without_losing_name_boundaries_or_quotes() {
    check(
        r#"_v=root; _vA=first; _vB=; args $_v{A,B} ${_v}{A,B}; args $_v{,A,B}; args $_v{A,B}"" "$_v"{A,B} \$_v{A,B}"#,
        &[
            &["first", "rootA", "rootB"],
            &["root", "first"],
            &["first", "", "rootA", "rootB", "$_vA", "$_vB"],
        ],
    );
    // A generated word may contain a very long identifier but little or no
    // output. Its spelling is scanner/parser storage, not emitted raw bytes.
    let name = format!("v{}", "name".repeat(1500));
    let rig = Rig::new(Limits {
        expansion_bytes: 8 * 1024 * 1024,
        ..Limits::default()
    });
    rig.variable(&format!("{name}A"), "short");
    rig.variable(&format!("{name}B"), "");
    assert_eq!(
        rig.run(&format!(r#"args ${name}{{A,B}} ${name}{{A,B}}"""#)),
        0
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["short", "short", ""]]);
}

#[test]
fn brace_expansion_does_not_reinterpret_parameter_results_or_opaque_operands() {
    check(
        r#"v='{a,b}'; set=yes; args $v "$v" ${u:-{x,y}} ${saved:={p,q}} "$saved"; args ${set:-$(args {forbidden,never})} {${v},tail}"#,
        &[
            &["{a,b}", "{a,b}", "{x,y}", "{p,q}", "{p,q"],
            &["yes", "{a,b}", "tail"],
        ],
    );
    // Private-use characters are ordinary user data, not brace sentinels.
    check(
        "args '\u{e000}\u{e001}'{a,b} {\u{f0000},\u{10fffd}}",
        &[&[
            "\u{e000}\u{e001}a",
            "\u{e000}\u{e001}b",
            "\u{f0000}",
            "\u{10fffd}",
        ]],
    );
}

#[test]
fn brace_scalar_assignment_declaration_and_redirect_contexts_stay_opaque() {
    // Declaration RHSs and redirects are intentionally scalar engine contexts,
    // rather than a request to add Bash's declaration/ambiguous-redirect rules.
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"x={a,b}; export y={1..3}; f() { local z={red,blue}; args "$x" "$y" "$z"; }; f; TEMP={left,right} args; args "${TEMP-unset}"; args >{left,right}"#),
        0,
    );
    assert_eq!(
        *rig.calls.borrow(),
        &[
            vec!["{a,b}", "{1..3}", "{red,blue}"],
            vec![],
            vec!["unset"],
            vec![],
        ],
    );
    assert!(
        rig.fs
            .read_file("/home/guest/{left,right}")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn brace_generated_words_have_no_fixed_four_kilobyte_cutoff() {
    let long = "x".repeat(4100);
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(&format!("args {{{long},short}}")), 0);
    assert_eq!(*rig.calls.borrow(), &[vec![long, "short".into()]]);
}

#[test]
fn brace_field_and_product_admission_fail_without_partial_command_dispatch() {
    for source in [
        "args already {1..8}",
        "echo forbidden {1..8}",
        "f() { args forbidden; }; f already {1..8}",
        "args {1..4}{a..d}",
        "args {$v,last}",
    ] {
        let rig = Rig::new(Limits {
            arguments: 4,
            ..Limits::default()
        });
        rig.variable("v", "a b c");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert_eq!(rig.run("args recovered"), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), &[vec!["recovered"]], "{source}");
    }
    for (arguments, status) in [(7, 0), (6, 2)] {
        let rig = Rig::new(Limits {
            arguments,
            ..Limits::default()
        });
        assert_eq!(rig.run("args {a,b}{1..3}"), status);
        if status == 0 {
            assert_eq!(
                *rig.calls.borrow(),
                &[vec!["a1", "a2", "a3", "b1", "b2", "b3"]]
            );
        } else {
            assert!(rig.calls.borrow().is_empty());
        }
    }
}

#[test]
fn brace_range_and_product_bounds_are_checked_before_enumerating_huge_counts() {
    for source in [
        "args {-9223372036854775808..9223372036854775807}",
        "args {a,b}{-9223372036854775808..9223372036854775807}",
        "args {1..1000000000}{1..1000000000}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert_eq!(rig.run("args recovered"), 0);
    }
}

#[test]
fn brace_raw_output_budget_is_shared_even_when_ifs_removes_the_results() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64 * 1024,
        ..Limits::default()
    });
    // Whitespace IFS removes the fields (bash: `set -- {$v,}` leaves none);
    // a non-whitespace IFS would keep one empty field per delimiter.
    rig.variable("IFS", " ");
    rig.variable("v", &" ".repeat(12_000));
    assert_eq!(rig.run("args {$v,}"), 0);
    assert_eq!(*rig.calls.borrow(), &[Vec::<String>::new()]);
    rig.calls.borrow_mut().clear();
    assert_eq!(rig.run("args {$v,$v,$v,$v,$v,$v}"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["recovered"]]);
}

#[test]
fn brace_generated_spelling_and_repeated_copies_need_storage_even_for_tiny_values() {
    let name = format!("v{}", "n".repeat(17_000));
    let source = format!("args {{${name},last}}");
    // The value is tiny. At least the generated identifier copy alone exceeds
    // this storage budget; small final argv is not permission to allocate it.
    for (expansion_bytes, status) in [(16 * 1024, 2), (8 * 1024 * 1024, 0)] {
        let rig = Rig::new(Limits {
            expansion_bytes,
            ..Limits::default()
        });
        rig.variable(&name, "short");
        assert_eq!(rig.run(&source), status);
        if status == 0 {
            assert_eq!(*rig.calls.borrow(), &[vec!["short", "last"]]);
        } else {
            assert!(rig.calls.borrow().is_empty());
            assert!(rig.output.bytes().is_empty());
            assert_eq!(rig.run("args recovered"), 0);
        }
    }

    let name = format!("v{}", "n".repeat(1000));
    let one = format!("{{${name},z}}");
    let rig = Rig::new(Limits {
        expansion_bytes: 256 * 1024,
        ..Limits::default()
    });
    rig.variable(&name, "s");
    assert_eq!(rig.run(&format!("args {one}")), 0);
    rig.calls.borrow_mut().clear();
    // Every generated parser/copy operation belongs to the same command budget,
    // not a fresh allowance per brace word. Outputs total only a few bytes.
    assert_eq!(
        rig.run(&format!("args {}", format!("{one} ").repeat(16))),
        2
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn default_limits_admit_a_ten_thousand_word_range() {
    // Bash expands `{0..10000}` for a builtin; peak, not cumulative, temporary
    // storage is charged, so the default command budget holds it.
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("args {0..10000}"), 0);
    let calls = rig.calls.borrow();
    assert_eq!(calls[0].len(), 10_001);
    assert_eq!(calls[0].first().map(String::as_str), Some("0"));
    assert_eq!(calls[0].last().map(String::as_str), Some("10000"));
}

#[test]
fn brace_scanning_range_emission_and_products_cooperate_with_cancellation() {
    for word in [
        format!("{{{},tail}}", "x".repeat(24_000)),
        "{1..50000}".into(),
        "{1..200}{1..200}".into(),
        format!(
            "${{scope:-$((printf '%s' '{}') )}}{{a,b}}",
            "x".repeat(12_000)
        ),
    ] {
        // Admissible but long: exact reservations reject an oversized range
        // up front, so the budget lets each word run until interrupted.
        let rig = Rig::new(Limits {
            arguments: 60_000,
            expansion_bytes: 8 * 1024 * 1024,
            ..Limits::default()
        });
        rig.variable("scope", "outside");
        // Function prefix assignments are not supported yet; the local frame
        // and positional parameters still have to unwind on cancellation.
        let job = rig
            .shell
            .start(&format!(
                "f() {{ local scope=inside; started=yes; args {word}; }}; f positional"
            ))
            .unwrap();
        rig.drive_until_variable("started", "yes");
        assert_eq!(
            rig.shell
                .state()
                .borrow()
                .variables
                .get("scope")
                .map(String::as_str),
            Some("inside"),
        );
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished(), "peer starved for {word}");
        assert!(!job.is_finished(), "brace work did not remain cancellable");
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert!(rig.output.bytes().is_empty());
        assert_eq!(rig.run(r#"args "$scope" "$#" "$1" "$started" "$peer""#), 0);
        assert_eq!(
            *rig.calls.borrow(),
            &[vec!["outside", "0", "", "yes", "ran"]],
        );
    }
}

#[test]
fn brace_deepest_source_nesting_is_iterative_or_rejected_by_explicit_admission() {
    let shallow = 32;
    let rig = Rig::new(Limits::default());
    let source = format!("args {}a,b{}", "{".repeat(shallow), "}".repeat(shallow));
    assert_eq!(rig.run(&source), 0);
    assert_eq!(
        *rig.calls.borrow(),
        &[vec![
            format!("{}a{}", "{".repeat(shallow - 1), "}".repeat(shallow - 1)),
            format!("{}b{}", "{".repeat(shallow - 1), "}".repeat(shallow - 1)),
        ]],
    );

    // Nearly fills the default 64 KiB source line. This is deliberately shared
    // with WASI: a native-only test would miss a recursive wasm stack overflow.
    // Bounded engines may reject the work/storage before reaching the deepest
    // group; an iterative implementation may instead accept the two results.
    let depth = (Limits::default().line_bytes - 32) / 2;
    let rig = Rig::new(Limits::default());
    let source = format!("args {}a,b{}", "{".repeat(depth), "}".repeat(depth));
    match rig.run(&source) {
        0 => assert_eq!(
            *rig.calls.borrow(),
            &[vec![
                format!("{}a{}", "{".repeat(depth - 1), "}".repeat(depth - 1)),
                format!("{}b{}", "{".repeat(depth - 1), "}".repeat(depth - 1)),
            ]],
        ),
        2 => assert!(
            rig.calls.borrow().is_empty(),
            "admission must not dispatch a partial variant"
        ),
        status => panic!("deep brace nesting must expand or report bounded status 2, got {status}"),
    }
    assert_eq!(rig.run("args recovered"), 0);
    assert_eq!(rig.calls.borrow().last().unwrap(), &["recovered"]);
}

#[test]
fn command_substitution_deepest_nesting_is_rejected_without_stack_overflow() {
    // Shared with WASI: every nesting level re-enters the parser's grammar, so
    // the frames of the deepest admitted level must fit the wasm stack. 120
    // levels exceed the hard AST depth cap of 100, which the parse reaches.
    for template in [
        "echo $(true; BODY)",
        "echo $(true | BODY)",
        "x=$(BODY)",
        "echo $(>out BODY)",
        "a=($(BODY))",
        "declare a=($(BODY))",
        "echo $(echo ${v:-x}; BODY)",
        "echo \"$(BODY)\"",
        "echo $((true); BODY)",
        "if $(BODY); then :; fi",
    ] {
        let mut source = String::from("echo ok");
        for _ in 0..120 {
            source = template.replace("BODY", &source);
        }
        // Work sized so the hard AST cap, not parser fuel, stops the parse.
        let fuel = source.len().saturating_mul(100).saturating_mul(4);
        let error = shell_parser::Parser::with_limits(&source, usize::MAX, fuel)
            .parse()
            .expect_err("120 levels exceed the hard AST cap");
        assert!(
            error.to_string().contains("AST nesting too deep"),
            "{template}: {error}"
        );
        // The engine's own limits may stop it earlier, by depth or by work.
        let rig = Rig::new(Limits::default());
        match rig.shell.start(&source) {
            Err(error) => {
                let message = error.to_string();
                assert!(
                    message.contains("AST nesting too deep") || message.contains("fuel exhausted"),
                    "{template}: {error}"
                );
            }
            Ok(job) => assert_eq!(rig.finish(job), 2, "{template}"),
        }
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(rig.calls.borrow().last().unwrap(), &["recovered"]);
    }
}

#[test]
fn braces_preserve_inactive_command_comments_and_deep_parameter_text() {
    check(
        "v=ok; args ${v:-$(# ) }\necho {a,b}\n)} {a,b}${v:-$(# ) }\necho {x,y}\n)}",
        &[&["ok", "aok", "bok"]],
    );
    for depth in [20, 90] {
        let operand = format!("${{v:-{}x{}", "${u:-".repeat(depth), "}".repeat(depth + 1));
        check(
            &format!("v=ok; args {operand} {{a,b}}{operand}"),
            &[&["ok", "aok", "bok"]],
        );
    }
}

#[test]
fn brace_opacity_distinguishes_arithmetic_shifts_and_shell_keywords() {
    check(
        "args \"$((1 << 2\n)){a,b}\" \"$((case == in)){a,b}\"; v=ok; args \"${v:-$((1 << 2\n))}{a,b}\"",
        &[&["4{a,b}", "1{a,b}"], &["ok{a,b}"]],
    );
    check(
        "args $((1 << 2\n)){a,b}; case=1; in=2; args $((case == in)){a,b}; v=ok; args ${v:-$((1 << 2\n))}{a,b} $(((1+2) << 1)){a,b}",
        &[&["4a", "4b"], &["0a", "0b"], &["oka", "okb", "6a", "6b"]],
    );
}

#[test]
fn brace_opacity_preserves_inactive_subshell_case_and_escaped_dollars() {
    check(
        "v=ok; args ${v:-$((case x in x) :;; esac) )}{a,b} \"${v:-$((case x in x) :;; esac) )}{a,b}\"",
        &[&["oka", "okb", "ok{a,b}"]],
    );
    check(
        r#"v=ok; args ${v:-$(echo "${u:-\${x}")}{a,b} "${v:-$(echo "${u:-\${x}")}{a,b}""#,
        &[&["oka", "okb", "ok{a,b}"]],
    );
}
