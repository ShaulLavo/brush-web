//! `case` cases checked against GNU Bash 5.3.15 (`/usr/bin/bash -c`).
use super::*;

fn check_case(source: &str, expected: &str, status: i32) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), status, "{source}");
    assert_eq!(rig.output.bytes(), expected.as_bytes(), "{source}");
}

#[test]
fn case_generator_seed_substitution_with_case_runs_matches_bash() {
    check_case(
        r#"$(case x in (x) :;; esac); status=$?; printf 'status=%s\n' "$status"; exit "$status""#,
        "status=0\n",
        0,
    );
}

#[test]
fn case_fallthrough_and_continue_patterns_matches_bash() {
    check_case(
        r#"x=foo; case "$x" in "f"*) echo first;;& *o) echo second;;& foo) echo third;; esac"#,
        "first\nsecond\nthird\n",
        0,
    );
}

#[test]
fn case_quoted_pattern_characters_are_literal_matches_bash() {
    check_case(
        r#"x=bar; case "$x" in "b*") echo quoted;;& b*) echo unquoted;; esac"#,
        "unquoted\n",
        0,
    );
}

#[test]
fn case_semicolon_ampersand_runs_bodies_unconditionally_matches_bash() {
    check_case(
        r#"case a in a) echo one;& b) echo two;& c) echo three;; d) echo no;; esac"#,
        "one\ntwo\nthree\n",
        0,
    );
}

#[test]
fn case_no_match_status_is_zero_matches_bash() {
    check_case(
        r#"case zzz in a) echo a;; esac; echo status:$?"#,
        "status:0\n",
        0,
    );
}

#[test]
fn case_last_body_status_is_the_case_status_matches_bash() {
    check_case(
        r#"case a in a) false;; esac; echo status:$?"#,
        "status:1\n",
        0,
    );
}

#[test]
fn case_last_body_status_with_default_arm_matches_bash() {
    check_case(
        r#"case a in a) true;; *) false;; esac; echo status:$?"#,
        "status:0\n",
        0,
    );
}

#[test]
fn case_alternatives_matches_bash() {
    check_case(r#"case abc in a|abc|c) echo alt;; esac"#, "alt\n", 0);
}

#[test]
fn case_unquoted_variable_pattern_globs_matches_bash() {
    check_case(
        r#"x='a*'; case abc in $x) echo unq;; esac; case abc in "$x") echo q;; *) echo none;; esac"#,
        "unq\nnone\n",
        0,
    );
}

#[test]
fn case_escaped_space_pattern_matches_bash() {
    check_case(r#"case "a b" in a\ b) echo esc;; esac"#, "esc\n", 0);
}

#[test]
fn case_empty_word_and_pattern_matches_bash() {
    check_case(r#"case "" in "") echo empty;; esac"#, "empty\n", 0);
}

#[test]
fn case_substitutions_in_word_and_pattern_matches_bash() {
    check_case(
        r#"case x in $(echo x)) echo sub;; esac; case $(echo x) in x) echo word;; esac"#,
        "sub\nword\n",
        0,
    );
}

#[test]
fn case_bracket_ranges_matches_bash() {
    check_case(r#"case ab in a[a-c]) echo br;; esac"#, "br\n", 0);
}

#[test]
fn case_negated_bracket_matches_bash() {
    check_case(r#"case a in [!b]) echo neg;; esac"#, "neg\n", 0);
}

#[test]
fn case_single_quoted_pattern_is_literal_matches_bash() {
    check_case(
        r#"case 'a*' in 'a*') echo lit;; esac; case ab in 'a*') echo bad;; *) echo nomatch;; esac"#,
        "lit\nnomatch\n",
        0,
    );
}

#[test]
fn case_parameter_trim_in_pattern_matches_bash() {
    check_case(r#"x=xy; case $x in ${x%y}?) echo trim;; esac"#, "trim\n", 0);
}

#[test]
fn case_return_status_from_case_in_function_matches_bash() {
    check_case(
        r#"f(){ case $1 in a) return 3;; esac; }; f a; echo $?"#,
        "3\n",
        0,
    );
}

#[test]
fn case_empty_body_status_matches_bash() {
    check_case(r#"case a in a) ;; esac; echo status:$?"#, "status:0\n", 0);
}

#[test]
fn case_continue_pattern_chain_matches_bash() {
    check_case(
        r#"case a in a) echo a;;& a) echo again;;& *) echo star;; esac"#,
        "a\nagain\nstar\n",
        0,
    );
}

#[test]
fn case_continue_pattern_status_matches_bash() {
    check_case(
        r#"case a in a) false;;& a) true;;& b) :;; esac; echo status:$?"#,
        "status:0\n",
        0,
    );
}

#[test]
fn case_arithmetic_word_matches_bash() {
    check_case(r#"case $((1+1)) in 2) echo arith;; esac"#, "arith\n", 0);
}

#[test]
fn case_nested_case_matches_bash() {
    check_case(
        r#"v=1; case a in a) case b in b) echo nested;; esac;; esac"#,
        "nested\n",
        0,
    );
}
