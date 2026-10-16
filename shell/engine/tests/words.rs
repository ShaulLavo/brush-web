//! Word cases adapted from the pinned Bashkit sources in sources.lock.json.
//! The fixture observes argv directly, without relying on printf's format rules.
use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::{Executor, JoinHandle},
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
};
use std::{cell::RefCell, rc::Rc};

struct Rig {
    ex: Executor,
    shell: Session,
    host: InProcessHost,
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    output: Capture,
    errors: Capture,
    fs: MemoryFs,
}
impl Rig {
    fn new(limits: Limits) -> Self {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let calls = Rc::new(RefCell::new(Vec::new()));
        let observed = calls.clone();
        host.register("args", move |req, _| {
            let observed = observed.clone();
            async move {
                observed.borrow_mut().push(req.argv[1..].to_vec());
                0
            }
            .boxed_local()
        });
        let fs = MemoryFs::new(64 * 1024);
        let shell = Session::new(
            ex.clone(),
            Rc::new(host.clone()),
            Rc::new(fs.clone()),
            limits,
        );
        let (out, output) = capture(64 * 1024);
        let (err, errors) = capture(64 * 1024);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out);
        fds.insert(2, err);
        shell.set_descriptors(fds).unwrap();
        Self {
            ex,
            shell,
            host,
            calls,
            output,
            errors,
            fs,
        }
    }
    fn finish(&self, job: JoinHandle<i32>) -> i32 {
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            let turn = self.ex.drive(64);
            assert!(turn.runnable || job.is_finished(), "unexpected parked job");
        }
        panic!("expansion did not finish within bounded turns");
    }
    fn run(&self, source: &str) -> i32 {
        self.finish(self.shell.start(source).unwrap())
    }
    fn variable(&self, name: &str, value: &str) {
        self.shell
            .state()
            .borrow_mut()
            .variables
            .insert(name.into(), value.into());
    }
    fn drive_until_variable(&self, name: &str, value: &str) {
        for _ in 0..200 {
            self.ex.drive(1);
            if self
                .shell
                .state()
                .borrow()
                .variables
                .get(name)
                .map(String::as_str)
                == Some(value)
            {
                return;
            }
        }
        panic!("variable {name} did not become {value}");
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let shutdown = self.shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..1000 {
            self.ex.drive(64);
            if shutdown.as_mut().now_or_never().is_some() {
                assert_eq!(self.ex.drive(64).pending, 0);
                assert_eq!(self.host.active_count(), 0);
                assert_eq!(self.host.retained_count(), 0);
                return;
            }
        }
        panic!("fixture shutdown did not finish");
    }
}
fn check(source: &str, expected: &[&[&str]]) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
    assert_eq!(*rig.calls.borrow(), expected, "{source}");
}

fn check_output(source: &str, expected: &str) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
    assert_eq!(rig.output.bytes(), expected.as_bytes(), "{source}");
}

// Scalar cases adapted from Bashkit 491c3281's remove-pattern-glob,
// param-operand-quotes and variables specs. Other cases use focused GNU Bash
// probes under LC_ALL=C.UTF-8, with engine-specific limit/cancellation checks.
#[test]
fn adapted_scalar_trim_examples() {
    check_output(
        r#"x=abc; e=; echo "${x#*}|${x%*}|${x##*}|${x%%*}|[${e#*}]"; echo "${x#?}|${x%?}|${x#*?}|${x%?*}|${x##?}|${x#??}"; p=/a/b.c/d.tar.gz; echo "${p#*/*/}|${p##*.*.}|${p%/*/*}|${p#/?/}|${p%%.*}|${p##*/}"; y='a*b'; q='*'; echo "${y#$q}|${y#"$q"}|${y%$q}""#,
        "abc|abc|||[]\nbc|ab|bc|ab|bc|c\nb.c/d.tar.gz|gz|/a|b.c/d.tar.gz|/a/b|d.tar.gz\na*b|a*b|a*b\n",
    );
    check_output(
        r#"x=a.b.c; echo "${x#'a.'}" "${x%'.c'}" ${x##'a.'} "${x%%'.'*}"; X=hello.world.txt; echo ${X#*.} ${X##*.}; X=file.tar.gz; echo ${X%.*} ${X%%.*}"#,
        "b.c a.b b.c a\nworld.txt txt\nfile.tar file\n",
    );
}

#[test]
fn trim_source_spaces_preserve_escape_boundaries() {
    check(
        r#"p='\'; s=' '; v=' abc '; args "${v#${p} }" "${v##${p} }" "${v%${p} }" "${v%%${p} }"; args "${v#${p}$s}" "${v##${p}$s}" "${v%${p}$s}" "${v%%${p}$s}"; IFS=; args "${v#${p} }" "${v#${p}$s}"; args "${v#${p}${u:- }}" "${v#${p}${u:-$s}}""#,
        &[
            &[" abc ", " abc ", " abc ", " abc "],
            &["abc ", "abc ", " abc", " abc"],
            &[" abc ", " abc "],
            &[" abc ", " abc "],
        ],
    );
    check(
        r#"p='\'; s=' '; v=' abc '; IFS=:; args "${v#${p} }" "${v##${p}$s}" "${v%${p} }" "${v%%${p}$s}"; args "${v#${p}${u:- }}" "${v#${p}${u:-$s}}""#,
        &[&[" abc ", "abc ", " abc ", " abc"], &["abc ", "abc "]],
    );
    check(
        r#"p='\'; s=' '; v=' abc '; args "${v#${p}${u:- }}" "${v#${p}${u:-' '}}" "${v#${p}${u:=$s}}" "$u""#,
        &[&["abc ", " abc ", "abc ", " "]],
    );
}

#[test]
fn trim_source_space_controls_reach_scalars_and_lazy_operands() {
    check(
        r#"p='\'; s=' '; v=' abc '; a=${v#${p} }; b=${v##${p} }; c=${v%${p} }; d=${v%%${p} }; args "$a" "$b" "$c" "$d"; args "${u:-${v#${p} }}" "${u:-${v##${p} }}" "${u:-${v%${p} }}" "${u:-${v%%${p} }}"; a=${u:=${v#${p} }}; args "$a" "$u"; set=yes; args "${set:-${v#$(args forbidden)}}" "${missing+${v#${bad:?forbidden}}}""#,
        &[
            &[" abc ", " abc ", " abc ", " abc "],
            &[" abc ", " abc ", " abc ", " abc "],
            &[" abc ", " abc "],
            &["yes", ""],
        ],
    );
}

#[test]
fn trim_source_tabs_and_newlines_remain_distinct_from_source_spaces() {
    for whitespace in ["\t", "\n"] {
        let source = r#"p='\'; s='WS'; v='WSabcWS'; args "${v#${p}WS}" "${v##${p}WS}" "${v%${p}WS}" "${v%%${p}WS}"; IFS=; args "${v#${p}$s}""#.replace("WS", whitespace);
        let prefix = format!("abc{whitespace}");
        let suffix = format!("{whitespace}abc");
        check(
            &source,
            &[
                &[
                    prefix.as_str(),
                    prefix.as_str(),
                    suffix.as_str(),
                    suffix.as_str(),
                ],
                &[prefix.as_str()],
            ],
        );
    }
}

#[test]
fn trim_bracket_braces_keep_quote_boundaries_and_partial_protection() {
    check(
        r#"v='}ab}'; args ${v#['}']} ${v##['}']} ${v%['}']} ${v%%['}']}; v='{ab{'; args ${v#['{']} ${v##['{']} ${v%['{']} ${v%%['{']}; v='-ab-'; args ${v#['}'"-"a]} ${v##['}'"-"a]} ${v%['}'"-"a]} ${v%%['}'"-"a]}; v='}ab}'; a=${v#['}']*}; b=${v##['}']*}; c=${v%*['}']}; d=${v%%*['}']}; args "$a" "$b" "$c" "$d"; args "${v#['}']}" "${v##['}']}" "${v%['}']}" "${v%%['}']}""#,
        &[
            &["ab}", "ab}", "}ab", "}ab"],
            &["ab{", "ab{", "{ab", "{ab"],
            &["ab-", "ab-", "-ab", "-ab"],
            &["ab}", "", "}ab", ""],
            &["ab}", "ab}", "}ab", "}ab"],
        ],
    );
}

#[test]
fn trim_bracket_braces_reach_lazy_operands_and_literal_malformed_classes() {
    check(
        r#"v='}ab}'; a=${u:-${v#['}']}}; b=${u:-${v##['}']}}; c=${u:-${v%['}']}}; d=${u:-${v%%['}']}}; args "$a" "$b" "$c" "$d"; a=${saved:=${v#['}']}}; args "$a" "$saved"; v='[}ab[}'; args ${v#['}'} ${v##['}'} ${v%['}'} ${v%%['}'}; v='[{ab[{'; args ${v#['{'} ${v##['{'} ${v%['{'} ${v%%['{'}"#,
        &[
            &["ab}", "ab}", "}ab", "}ab"],
            &["ab}", "ab}"],
            &["ab[}", "ab[}", "[}ab", "[}ab"],
            &["ab[{", "ab[{", "[{ab", "[{ab"],
        ],
    );
}

#[test]
fn trim_review_controls_preserve_selected_error_messages() {
    for (source, expected) in [
        (
            r#"p='\'; v=' abc '; args ${bad:?"${v#${p} }"}; args forbidden"#,
            "/usr/bin/bash: line 1: bad:  abc \n",
        ),
        (
            r#"v='}abc'; args ${bad:?${v#['}']}}; args forbidden"#,
            "/usr/bin/bash: line 1: bad: abc\n",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 127);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.errors.bytes(), expected.as_bytes());
    }
}

#[test]
fn trim_nested_length_input_cannot_bypass_shared_snapshot_storage() {
    for operand in ["${v#${#p}}", "${u:-${v#${#p}}}"] {
        let rig = Rig::new(Limits {
            expansion_bytes: 256,
            ..Limits::default()
        });
        rig.variable("v", "abc");
        rig.variable("p", &"x".repeat(256));
        assert_eq!(rig.run(&format!("args \"{operand}\"")), 2);
        assert!(rig.calls.borrow().is_empty());
        // Ordinary length retains PR20's input bound and counting behavior.
        assert_eq!(rig.run("args ${#p}"), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["256"]]);
    }
}

#[test]
fn scalar_trims_distinguish_empty_unset_no_match_and_zero_length_matches() {
    check(
        r#"v=abc; e=; args "${u#*}" "${u##?}" "${u%a}" "${u%%*}" "${e#?}" "${e%%}"; args "${v#}" "${v##}" "${v%}" "${v%%}" "${v#z*}" "${v%%z}"; args ${u#*} ${e%%?} ${v##*}; args "${v#*}" "${v%*}" "${v##*}" "${v%%*}" "$v" "${u+set}"; args "${u#${side:=bad}}" "${e%%$(args forbidden)}" "${side-unset}""#,
        &[
            &["", "", "", "", "", ""],
            &["abc", "abc", "abc", "abc", "abc", "abc"],
            &[],
            &["abc", "abc", "", "", "abc", ""],
            &["", "", "unset"],
        ],
    );
}

#[test]
fn scalar_trim_pattern_quotes_and_escapes_do_not_protect_the_result() {
    check(
        r#"p='\'; q='?'; v='?abc'; args "${v#$p"$q"}" "${v#$p$q}" "${v#[$p"$q"]}"; q=a; v=aabc; args "${v#$p"$q"}" "${v#$p$q}""#,
        &[&["?abc", "abc", "abc"], &["aabc", "abc"]],
    );
    check(
        r#"v='a*b?c'; p='*'; args "${v#a\*}" "${v##$p}" "${v##"$p"}" "${v#'a*'}" "${v#a\?}"; v='a b c'; args ${v#'a '} "${v#'a '}"; v='a?b'; p='a\?'; args "${v#$p}" "${v#"$p"}"; v='a*b'; args "${v#${u:-'a*'}}" "${v#"${u:-'a*'}"}""#,
        &[
            &["b?c", "", "a*b?c", "b?c", "a*b?c"],
            &["b", "c", "b c"],
            &["b", "a?b"],
            &["b", "a*b"],
        ],
    );
    check(
        r#"v='}x'; args "${v#'}'}" "${v#\}}"; v='a*b'; args "${v#"a*"}" "${v#'a*'}"; v='$q tail'; args "${v#'$q '}""#,
        &[&["x", "x"], &["b", "b"], &["tail"]],
    );
}

#[test]
fn scalar_trims_match_basic_brackets_and_unicode_scalars() {
    check(
        r#"LC_ALL=C.UTF-8; v=abc; args "${v#[a-c]}" "${v#[!b]}" "${v#[^b]}" "${v#[z-a]}" "${v#[a\-c]}" "${v%[bc]}" "${v%%[bc]*}"; v=']-x'; args "${v#[]-]}"; v='[x'; args "${v#[}" "${v#[[]}"; v='é🙂abc'; args "${v#?}" "${v%???}" "${v#[é]}"; v='é🙂'; args "${v#?}" "${v%?}" "${v##??}""#,
        &[
            &["bc", "bc", "bc", "abc", "bc", "ab", "a"],
            &["-x"],
            &["x", "x"],
            &["🙂abc", "é🙂", "🙂abc"],
            &["́🙂", "é", "🙂"],
        ],
    );
}

#[test]
fn scalar_trims_select_nested_default_assignment_and_error_operands_lazily() {
    check(
        r#"v=abc; set=yes; args ${u:-${v#a}} ${set:+${v%c}} ${assigned:=${v#?}} "$assigned"; args ${set:-${1#*}} ${u+${v#$(args forbidden)}} ${set:=${v#~}} ${set:?${v#[[:alpha:]]}}; args "${v#${pattern:=a*}}" "$pattern"; args "${absent#${absent:=abc}}" "$absent"; args "${v#${u:-${v%c}}}""#,
        &[
            &["bc", "ab", "bc", "bc"],
            &["yes", "yes", "yes"],
            &["bc", "a*"],
            &["", ""],
            &["c"],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=abc; args ${u:?${v#a}}; args forbidden"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: u: bc\n");
}

#[test]
fn scalar_trim_effects_use_final_ifs_and_scalar_contexts() {
    check(
        r#"IFS=; v='a:x:y'; args ${v#a}${IFS:=:}; IFS=; args ${v#${IFS:=:}}; IFS=; args "${v#${IFS:=:}}"; v='a b c'; x=${v#'a '}; export y=${v#'a '}; f() { local z=${v#'a '}; args "$z" "$1"; }; f argument; args "$x" "$y""#,
        &[
            &["", "x", "y"],
            &["a", "x", "y"],
            &["a:x:y"],
            &["b c", "argument"],
            &["b c", "b c"],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v='prefix-file name'; args >${v#prefix-}"), 0);
    assert!(
        rig.fs
            .read_file("/home/guest/file name")
            .unwrap()
            .is_empty()
    );
    assert_eq!(rig.run(r#"v=outside; f() { local v=inside; args "${v#in}" "$1"; }; f arg; args "$v" "$#" "$1"; TEMP=${v#out} RESULT=${saved:=${TEMP#s}} args; args "${TEMP-unset}" "${RESULT-unset}" "$saved""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        &[
            vec![],
            vec!["side", "arg"],
            vec!["outside", "0", ""],
            vec![],
            vec!["unset", "unset", "ide"]
        ]
    );
}

#[test]
fn unsupported_trim_targets_and_selected_patterns_fail_without_dispatch() {
    for form in [
        "${1#x}",
        "${@#x}",
        "${*%x}",
        "${?#x}",
        "${##x}",
        "${a[0]#x}",
        "${PIPESTATUS[@]%%x}",
        "${!v#x}",
        "${v#$(args forbidden)}",
        "${v#`args forbidden`}",
        "${v#$((1+2))}",
        "${v#~}",
        "${v#@(a)}",
        "${v#?(a)}",
        "${v#*(a)}",
        "${v#!(a)}",
        "${v#[[:alpha:]]}",
        "${v#[[.a.]]}",
        "${v#[[=a=]]}",
        "${v#${v/a/b}}",
        "${v#${v:1}}",
        "${v#$@}",
    ] {
        for source in [
            format!("args {form}"),
            format!("args ${{u:-{form}}}"),
            format!("args ${{u:={form}}}"),
            format!("args ${{u:?{form}}}"),
        ] {
            let rig = Rig::new(Limits::default());
            rig.variable("v", "abc");
            assert_eq!(rig.run(&source), 2, "{source}");
            assert!(rig.calls.borrow().is_empty(), "{source}");
            assert!(!rig.shell.state().borrow().variables.contains_key("u"));
        }
    }
    for pattern in ["@(a)", "[[:alpha:]]", "[[.a.]]", "[[=a=]]"] {
        let rig = Rig::new(Limits::default());
        rig.variable("p", pattern);
        rig.variable("v", &format!("{pattern}tail"));
        assert_eq!(rig.run("args ${v#$p}"), 2);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "${v#"$p"}""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["tail"]]);
    }
    for source in [
        "f() { args forbidden; }; X=${v#a} f",
        "X=${v#a} echo forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2);
        assert!(rig.calls.borrow().is_empty());
        assert!(rig.output.bytes().is_empty());
    }
}

#[test]
fn trim_snapshots_patterns_results_and_fields_share_bounds() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    rig.variable("v", &"a".repeat(129));
    assert_eq!(rig.run("args ${v##*}"), 2);
    rig.variable("v", "abc");
    rig.variable("p", &"*".repeat(129));
    assert_eq!(rig.run("args ${v##$p}"), 2);
    rig.variable("p", "aaaaaaaa");
    assert_eq!(rig.run("args ${v#$p}"), 2, "compiled pattern storage");
    assert!(rig.calls.borrow().is_empty());
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    rig.variable("v", &"a".repeat(80));
    rig.variable("n", &"x".repeat(200));
    assert_eq!(
        rig.run("args ${v#${#n}}"),
        2,
        "nested length snapshot storage"
    );
    assert_eq!(rig.run("args ${v##*}"), 0);
    assert_eq!(
        rig.run("args ${v##*} ${v##*} ${v##*}"),
        2,
        "even vanished results share snapshot storage"
    );
    assert_eq!(rig.calls.borrow().len(), 1);
    let source = format!("args {}${{v#x}}", "p".repeat(250));
    assert_eq!(rig.run(&source), 2, "aggregate output bytes");
    let rig = Rig::new(Limits {
        arguments: 3,
        ..Limits::default()
    });
    rig.variable("v", "xa b c");
    assert_eq!(rig.run("args ${v#x}"), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn trim_matching_and_operand_reparsing_share_command_work() {
    let rig = Rig::new(Limits {
        source_bytes: 256,
        expansion_bytes: 512,
        arguments: 16,
        ..Limits::default()
    });
    rig.variable("v", "ab");
    assert_eq!(rig.run(&format!("args {}", "${u:-${v#a}} ".repeat(11))), 2);
    assert!(rig.calls.borrow().is_empty(), "cumulative token admission");
    let rig = Rig::new(Limits {
        source_bytes: 256,
        expansion_bytes: 8192,
        arguments: 16,
        ..Limits::default()
    });
    rig.variable("v", &"a".repeat(1000));
    assert_eq!(rig.run("args ${v##*} ${v##*}"), 0);
    assert_eq!(rig.run("args ${v##*} ${v##*} ${v##*}"), 2);
    assert_eq!(
        rig.run("args ${v##*} ${v##*} >${v##*}sink"),
        2,
        "redirects share matching work"
    );
    assert_eq!(rig.calls.borrow().len(), 1);
    let rig = Rig::new(Limits::default());
    let oversized = format!("args ${{u:-${{v#{}}}}}", "x".repeat(4096));
    assert_eq!(rig.run(&oversized), 2);
    let deep = format!("args {}${{v#x}}{}", "${u:-".repeat(34), "}".repeat(34));
    assert_eq!(rig.run(&deep), 2);
    assert!(rig.calls.borrow().is_empty());
    // More than upstream's 10,000 candidate cap, with no partial result.
    rig.variable("v", &"a".repeat(12_000));
    assert_eq!(rig.run(r#"args "${v##*?}" "${v%%?*}""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["", ""]]);
}

#[test]
fn trim_pattern_scanning_and_token_admission_yield_and_cancel() {
    for (pattern, polls) in [
        ("$pattern".to_owned(), 4),
        (format!("${{{}}}", "x".repeat(3000)), 80),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("v", "abc");
        rig.variable("scope", "outside");
        rig.variable("pattern", &"[a-z]".repeat(20_000));
        let job = rig
            .shell
            .start(&format!(
                "f() {{ local scope=inside; args ${{v#{pattern}}}; }}; f argument"
            ))
            .unwrap();
        rig.drive_until_variable("scope", "inside");
        rig.ex.drive(polls);
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished());
        assert!(!job.is_finished());
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "$scope" "$#" "$1""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["outside", "0", ""]]);
    }
}

#[test]
fn trim_matching_yields_cancels_and_restores_local_and_positional_frames() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", &"a".repeat(6000));
    rig.variable("scope", "outside");
    let job = rig
        .shell
        .start(
            "f() { local scope=inside; args ${v%%${started:=a}*?*?*?*?*?*?*?*?*?*?}; }; f argument",
        )
        .unwrap();
    rig.drive_until_variable("started", "a");
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(!job.is_finished(), "matching remains cooperative");
    rig.variable("peer", "ran");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run(r#"args "$scope" "$#" "$1" "$started""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["outside", "0", "", "a"]]);
}

#[test]
fn trim_rhs_cancellation_restores_valid_external_prefix_frames() {
    for operand in ["${v##*?}", "${u:-${v%%?*}}"] {
        let rig = Rig::new(Limits::default());
        rig.variable("v", &"é".repeat(150_000));
        rig.variable("result", "outside");
        let job = rig
            .shell
            .start(&format!("TEMP=value result={operand} args"))
            .unwrap();
        rig.drive_until_variable("TEMP", "value");
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished());
        assert!(!job.is_finished());
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "${TEMP-unset}" "$result" "$#""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["unset", "outside", "0"]]);
    }
}

// Scalar length cases adapted from Bashkit 491c3281's variables, string-ops,
// unicode, bashbox-utf8 and c-locale-length specs. Bounds are engine-specific.
#[test]
fn adapted_scalar_length_examples() {
    check_output(
        "LC_ALL=C.UTF-8; X=hello; echo ${#X}; x=café; echo ${#x}; x='héllo wörld'; echo ${#x}; y=日本語; echo ${#y}",
        "5\n4\n11\n3\n",
    );
}

#[test]
fn scalar_lengths_preserve_values_and_dynamic_local_scope() {
    check(
        r#"args ${#missing}; empty=; v='a b*'; args ${#empty} ${#v} "$v"; v=outer; g() { args ${#v}; }; f() { local v=é; g; args ${#v}; }; LC_ALL=C.UTF-8; f; args ${#v} "${missing+changed}" ${#PWD}"#,
        &[
            &["0"],
            &["0", "4", "a b*"],
            &["1"],
            &["1"],
            &["5", "", "11"],
        ],
    );
}

#[test]
fn scalar_length_locale_precedence_and_changes() {
    check(
        r#"s=ação; LC_ALL=C; LC_CTYPE=C.UTF-8; LANG=C.UTF-8; args ${#s}; LC_ALL=POSIX; args ${#s}; LC_ALL=C.UTF-8; args ${#s}; LC_ALL=; LC_CTYPE=POSIX; args ${#s}; LC_CTYPE=C.UTF-8; args ${#s}; LC_CTYPE=; LANG=C; args ${#s}; LANG=C.UTF-8; args ${#s}; LANG=; args ${#s}; f() { local LC_ALL=C.UTF-8; args in=${#s}; }; f; args out=${#s}"#,
        &[
            &["6"],
            &["6"],
            &["4"],
            &["6"],
            &["4"],
            &["6"],
            &["4"],
            &["6"],
            &["in=4"],
            &["out=6"],
        ],
    );
    check(
        "LC_ALL=C.utf8; s='é🙂'; args ${#s}; LC_ALL=C; args ${#s}; LC_ALL=C.UTF-8; x='héllo wörld'; y=日本語; args ${#x} ${#y}",
        &[&["3"], &["7"], &["11", "3"]],
    );
    let rig = Rig::new(Limits::default());
    rig.variable("s", "é");
    assert_eq!(rig.run("args ${#s}"), 0, "no locale defaults to C");
    rig.variable("LC_ALL", "unsupported-locale");
    assert_eq!(rig.run("args ${#s}"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["2"], vec!["2"]]);
}

#[test]
fn scalar_lengths_include_positive_positionals_status_and_argument_count() {
    check(
        r#"LC_ALL=C.UTF-8; f() { args ${#1} ${#10} ${#11} ${#?} ${##} ${#}; args "${u:-${#1}}" "${u:-${#10}}" "${u:-${#?}}" "${u:-${##}}"; }; f é b c d e f g h i tenth; args ${#1} ${##}"#,
        &[
            &["1", "5", "0", "1", "2", "10"],
            &["1", "5", "1", "2"],
            &["0", "1"],
        ],
    );
}

#[test]
fn scalar_lengths_accept_positive_decimal_targets_beyond_machine_indices() {
    check(
        "args ${#18446744073709551616} ${u:-${#18446744073709551616}}",
        &[&["0", "0"]],
    );
    let zeros = "0".repeat(2048);
    let source = format!(
        "f() {{ args ${{#{zeros}1}} ${{u:-${{#{zeros}1}}}} ${{#{zeros}18446744073709551616}} ${{u:-${{#{zeros}18446744073709551616}}}}; }}; f abc"
    );
    check(&source, &[&["3", "3", "0", "0"]]);
    let rig = Rig::new(Limits::default());
    let oversized = format!("args ${{u:-${{#{}1}}}}", "0".repeat(4096));
    assert_eq!(
        rig.run(&oversized),
        2,
        "length tokens retain their byte cap"
    );
    assert!(rig.calls.borrow().is_empty());
    // All-zero spellings remain excluded, as do numeric assignment targets.
    for target in ["0".to_owned(), zeros] {
        for source in [
            format!("args ${{#{target}}}"),
            format!("args ${{u:-${{#{target}}}}}"),
        ] {
            let rig = Rig::new(Limits::default());
            assert_eq!(rig.run(&source), 2, "{source}");
            assert!(rig.calls.borrow().is_empty());
        }
    }
    for source in [
        "args ${18446744073709551616:=bad}",
        "args ${u:-${18446744073709551616:=bad}}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn lazy_lengths_keep_quote_ifs_and_scalar_context_rules() {
    check(
        r#"LC_ALL=C.UTF-8; s=ação; args "${u:-${v:-${#s}}}"; LC_ALL=C; args ${u:-${#s}}; v=set; args ${v:-${#arr[0]}} ${u+${#arr[0]}}; IFS=3; x=abc; args ${#x} "${#x}" pre${#x}post; y=${#x}; args "$y"; args ${u:-${#x}} ${u:-"${#x}"} "${u:-${#x}}"; export z=${#x}; args "$z""#,
        &[
            &["4"],
            &["6"],
            &["set"],
            &["", "3", "pre", "post"],
            &["3"],
            &["", "3", "3"],
            &["3"],
        ],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"v=abc; path=${#v}; echo result >"${#v}"; cat "$path"; ${u:-echo} ${#v}"#),
        0
    );
    assert_eq!(rig.output.bytes(), b"result\n3\n");
    check(
        r#"LC_ALL=C.UTF-8; s=ação; args ${u:=${#s}} "$u" ${u:+${#s}}; LC_ALL=C; args ${missing:-${u:+${#s}}}"#,
        &[&["4", "4", "4"], &["6"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("LC_ALL=C.UTF-8; s=é; args ${u:?${#s}}"), 127);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: u: 1\n");
}

#[test]
fn unsupported_length_targets_fail_closed_even_in_selected_operands() {
    for token in [
        "${#0}",
        "${#@}",
        "${#*}",
        "${#arr[0]}",
        "${#arr[@]}",
        "${#arr[*]}",
        "${#x-default}",
        "${#x/foo/bar}",
        "${#x:1}",
        "${#!x}",
    ] {
        for source in [format!("args {token}"), format!("args ${{u:-{token}}}")] {
            let rig = Rig::new(Limits::default());
            assert_eq!(rig.run(&source), 2, "{source}");
            assert!(rig.calls.borrow().is_empty(), "{source}");
        }
    }
}

#[test]
fn length_input_snapshots_decimal_output_and_fields_are_bounded() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16,
        ..Limits::default()
    });
    rig.variable("v", &"x".repeat(17));
    assert_eq!(rig.run("args ${#v}"), 2);
    rig.variable("v", &"x".repeat(10));
    assert_eq!(rig.run("args ${#v}"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["10"]]);
    assert_eq!(rig.run("args prefix12345${#v}"), 2);
    assert_eq!(rig.run("args ${#v} ${#v} ${#v} ${#v} ${#v} ${#v} ${#v}"), 2);
    assert_eq!(rig.calls.borrow().len(), 1);
    let rig = Rig::new(Limits {
        arguments: 2,
        ..Limits::default()
    });
    assert_eq!(rig.run("args ${#u} ${#v}"), 2);
    assert!(rig.calls.borrow().is_empty());
    let rig = Rig::new(Limits {
        expansion_bytes: 16,
        ..Limits::default()
    });
    rig.variable("v", &"x".repeat(17));
    assert_eq!(rig.run("args ${v+ok} ${u+${#v}}"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["ok"]]);
}

#[test]
fn repeated_lengths_share_command_work_even_for_tiny_results() {
    let rig = Rig::new(Limits {
        source_bytes: 1024,
        expansion_bytes: 512,
        arguments: 128,
        ..Limits::default()
    });
    rig.variable("v", &"é".repeat(100));
    rig.variable("LC_ALL", "C.UTF-8");
    assert_eq!(rig.run(&format!("args {}", "${#v} ".repeat(50))), 2);
    assert!(rig.calls.borrow().is_empty());
    let argv = format!("args {}", "${#v} ".repeat(7));
    assert_eq!(rig.run(&argv), 0);
    assert_eq!(rig.calls.borrow().len(), 1);
    assert_eq!(rig.run(&format!("{argv} >${{u:-${{#v}}}}")), 2);
    assert_eq!(
        rig.calls.borrow().len(),
        1,
        "redirect work must share argv's allowance"
    );
}

#[test]
fn length_tokens_retain_lazy_operand_token_and_depth_limits() {
    let rig = Rig::new(Limits::default());
    let token = format!("${{#{}}}", "v".repeat(4096));
    assert_eq!(rig.run(&format!("args ${{u:-{token}}}")), 2);
    let deep = format!("args {}${{#v}}{}", "${u:-".repeat(34), "}".repeat(34));
    assert_eq!(rig.run(&deep), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn length_counting_yields_and_cancellation_restores_function_frames() {
    for (operand, locale) in [
        ("${#s}", "C"),
        ("${#s}", "C.UTF-8"),
        ("${u:-${#s}}", "C.UTF-8"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("s", &"é".repeat(150_000));
        rig.variable("LC_ALL", "POSIX");
        let job = rig
            .shell
            .start(&format!(
                "f() {{ local LC_ALL={locale}; args {operand}; }}; f inner"
            ))
            .unwrap();
        rig.drive_until_variable("LC_ALL", locale);
        assert_eq!(
            rig.shell.state().borrow().variables.get("LC_ALL").unwrap(),
            locale
        );
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished(), "counting must yield");
        assert!(!job.is_finished());
        // A mutable borrow while suspended also proves counting holds no RefCell borrow.
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "$LC_ALL" "$#" "$1" "${TEMP-unset}""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["POSIX", "0", "", "unset"]]);
    }
}

#[test]
fn length_rhs_yields_and_cancellation_restores_prefix_frames() {
    for (operand, locale) in [
        ("${#s}", "C"),
        ("${#s}", "C.UTF-8"),
        ("${u:-${#s}}", "C.UTF-8"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("s", &"é".repeat(150_000));
        rig.variable("LC_ALL", "POSIX");
        rig.variable("length", "outer");
        // External-command prefixes expose earlier values while a later RHS yields.
        let job = rig
            .shell
            .start(&format!("TEMP=value LC_ALL={locale} length={operand} args"))
            .unwrap();
        rig.drive_until_variable("LC_ALL", locale);
        assert_eq!(
            rig.shell.state().borrow().variables.get("TEMP").unwrap(),
            "value"
        );
        let peer = rig.ex.spawn(async { 42 });
        rig.ex.drive(4);
        assert!(peer.is_finished(), "counting must yield");
        assert!(!job.is_finished());
        rig.variable("peer", "ran");
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run(r#"args "$LC_ALL" "${TEMP-unset}" "$length""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["POSIX", "unset", "outer"]]);
    }
}

#[test]
fn whole_word_quotes_override_unmarked_part_flags() {
    // Standalone QuotedWord tokens have whole-word quoting, while mixed words
    // carry explicit true/false part flags. Exercise both through the parser.
    check(
        r#"v=' a  b '; args "$v" "${v}" "" "$missing"; args $v"$v" "$v"$v"#,
        &[
            &[" a  b ", " a  b ", "", ""],
            &["a", "b", " a  b ", " a  b ", "a", "b"],
        ],
    );
    check(
        r#"f() { args "$1" "$2" "$3" "$4"; }; f '' non-empty '' last"#,
        &[&["", "non-empty", "", "last"]],
    );
}

#[test]
fn frozen_parent_losses_preserve_whole_word_quoting() {
    // Every loss from the first replay is kept verbatim here. Expected stdout
    // comes from docs/evidence/own-shell-oracle.json, not the old scalar engine.
    for (source, expected) in [
        (
            "f() {\n  echo f\n  return \"\"\n}\n\nf\necho status=$?\n",
            "f\nstatus=2\n",
        ),
        ("zz=$'one\\ntwo'\nset -x\necho \"$zz\"\n", "one\ntwo\n"),
        ("printf \"\"\n", ""),
        (
            "myfunc() {\n    echo \"count: $#\"\n    echo \"1: '$1'\"\n    echo \"2: '$2'\"\n    echo \"3: '$3'\"\n    echo \"4: '$4'\"\n}\n\nmyfunc \"\" \"non-empty\" \"\" \"last\"\n",
            "count: 4\n1: ''\n2: 'non-empty'\n3: ''\n4: 'last'\n",
        ),
        (
            "echo \"  a  b  \" | { read; echo \"[$REPLY]\"; }\n",
            "[  a  b  ]\n",
        ),
        (
            "x=\"hello   world   foo\"; echo \"$x\"\n",
            "hello   world   foo\n",
        ),
        ("x=\"hello   world\"; echo \"$x\"\n", "hello   world\n"),
        ("x=$'hello\\nworld'; echo \"$x\"\n", "hello\nworld\n"),
        (
            "c=\"echo hi\"\n\"$c\" 2>/dev/null\necho \"rc=$?\"\n",
            "rc=127\n",
        ),
    ] {
        check_output(source, expected);
    }
}

#[test]
fn pipestatus_star_is_scalar_and_at_preserves_each_status() {
    check_output(
        r#"false | true; printf 'STATUS:%s:%s\n' "$?" "${PIPESTATUS[*]}""#,
        "STATUS:0:1 0\n",
    );
    check(
        r#"false | true; args "$?" "${PIPESTATUS[*]}" "${PIPESTATUS[@]}"; IFS=:; false | true; args "${PIPESTATUS[*]}" "${PIPESTATUS[@]}""#,
        &[&["0", "1 0", "1", "0"], &["1:0", "1", "0"]],
    );
}

#[test]
fn missing_empty_and_literal_fields() {
    check(
        r#"e=; args $missing "$missing" $e "$e" "" '' a\ b '$missing'"#,
        &[&["", "", "", "", "a b", "$missing"]],
    );
}

#[test]
fn mixed_segments_split_only_unquoted_expansions() {
    check(
        r#"a='1 2'; b='3 4'; c='5 6'; d='7 8'; args $a"$b"; args "$a"$b; args $a"$b"$c"$d""#,
        &[&["1", "23 4"], &["1 23", "4"], &["1", "23 45", "67 8"]],
    );
    check(
        r#"a=' '; b=q; args p$a"$b"; args $a""; args ""$a"""#,
        &[&["p", "q"], &[""], &["", ""]],
    );
}

#[test]
fn default_empty_and_custom_ifs() {
    check(
        "v=' \ta\n b  '; args $v; IFS=; args $v $missing",
        &[&["a", "b"], &[" \ta\n b  "]],
    );
    check(
        r#"IFS=_; v='_a__b_'; args $v; args 'a_b'; v=' '; args $v; v=_; args $v"#,
        &[&["", "a", "", "b"], &["a_b"], &[" "], &[""]],
    );
    check(
        r#"IFS='_ '; v='_ a  b _ '; args $v; v='a_b _ _ _ c  _d e'; args $v"#,
        &[&["", "a", "b"], &["a", "b", "", "", "c", "d", "e"]],
    );
    check(
        r#"IFS=:; v=a:; args ${v}:b ${v}:; IFS=z; v=az; args ${v}zb"#,
        &[&["a", ":b", "a", ":"], &["a", "zb"]],
    );
    check("IFS=ç; v='çxççyç'; args $v", &[&["", "x", "", "y"]]);
}

#[test]
fn protected_empty_segments_preserve_split_boundaries() {
    check(
        r#"v='  abc  def  '; args ""$v""; IFS=:; v=:; args ""$v"""#,
        &[&["", "abc", "def", ""], &["", ""]],
    );
}

#[test]
fn quoted_and_unquoted_positional_fields() {
    check(
        r#"f() { args "$@"; args "x$@y"; args "$*"; args $@; args $*; }; f 'a b' '' c"#,
        &[
            &["a b", "", "c"],
            &["xa b", "", "cy"],
            &["a b  c"],
            &["a", "b", "c"],
            &["a", "b", "c"],
        ],
    );
    check(
        r#"f() { args "$@"; args "x$@y"; args "$*"; args $@; args ""$@; args "$@"""; }; f"#,
        &[&[], &["xy"], &[""], &[], &[""], &[""]],
    );
    check(r#"f() { args "x$@y$@z"; }; f a b"#, &[&["xa", "bya", "bz"]]);
}

#[test]
fn positional_ifs_joins_and_null_ifs_groups() {
    check(
        r#"f() { IFS=:; args "$*"; args $@; args =$*=; IFS=; args "$*"; args $@; args =$*=; }; f 'a b' '' c"#,
        &[
            &["a b::c"],
            &["a b", "", "c"],
            &["=a b", "", "c="],
            &["a bc"],
            &["a b", "c"],
            &["=a b", "c="],
        ],
    );
}

#[test]
fn pipestatus_at_star_and_index_fields() {
    check(
        r#"false | true; args "${PIPESTATUS[@]}"; false | true; IFS=:; false | true; args "x${PIPESTATUS[@]}y"; false | true; args "${PIPESTATUS[*]}"; false | true; args ${PIPESTATUS[@]}; false | true; args "${PIPESTATUS[0]}" ${PIPESTATUS[99]}"#,
        &[&["1", "0"], &["x1", "0y"], &["1:0"], &["1", "0"], &["1"]],
    );
}

#[test]
fn command_name_fields_promote_and_preserve_quoted_empty() {
    check(
        r#"c='args hi there'; $c tail; $missing $missing args promoted; f() { "$@" tail; }; f args a b"#,
        &[&["hi", "there", "tail"], &["promoted"], &["a", "b", "tail"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("$missing"), 0);
    assert_eq!(rig.run(r#""$missing""#), 127);
    assert_eq!(rig.run(r#""" args no"#), 127);
    assert_eq!(rig.run(r#"f() { "$@"; }; f '' args"#), 127);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn scalar_assignments_and_declaration_operands() {
    check(
        r#"v='a b'; x=$v; export y=$v; args "$x" "$y"; f() { local z=$v; args "$z"; }; f; args z=$v; key='k=a b'; export $key; args "$k"; args "$b""#,
        &[&["a b", "a b"], &["a b"], &["z=a", "b"], &["a"], &[""]],
    );
    check(
        r#"f() { IFS=:; x="$@"; y=$*; export z="$*"; args "$x" "$y" "$z"; }; f a 'b c'"#,
        &[&["a b c", "a:b c", "a:b c"]],
    );
    check(
        r#"v='a b'; n=export; $n x=$v; args "$x"; $missing export y=$v; args "$y""#,
        &[&["a"], &["a"]],
    );
}

#[test]
fn declaration_syntax_requires_an_unquoted_literal_command_and_prefix() {
    check_output(r#"v="a b"; n=export; $n x=$v; echo "<$x>""#, "<a>\n");
    check_output(r#"v="a b"; export "x="$v; echo "<$x>""#, "<a>\n");
    check(
        r#"v='a b'; 'export' x=$v; args "$x"; export "y"=$v; args "$y"; export z\=$v; args "$z"; export plain=$v; args "$plain"; export quoted="$v"; args "$quoted"; export mixed="p q"$v; args "$mixed""#,
        &[&["a"], &["a"], &["a"], &["a b"], &["a b"], &["p qa b"]],
    );
    check(
        r#"v='a b'; f() { n=local; $n x=$v; local "y="$v; local plain=$v; args "$x" "$y" "$plain"; }; f"#,
        &[&["a", "a", "a b"]],
    );
}

#[test]
fn escaped_assignment_equals_does_not_enable_declaration_syntax() {
    check_output(r#"v='a b'; export z\=$v; echo "<$z>""#, "<a>\n");
}

#[test]
fn escaped_command_spelling_does_not_enable_declaration_syntax() {
    check_output(r#"v='a b'; e\xport z=$v; echo "<$z>""#, "<a>\n");
}

#[test]
fn declaration_source_spelling_survives_functions_and_redirects() {
    check(
        r#"v='a b'; f() { export z\=$v; args "$z"; e\xport z=$v; args "$z"; }; f; export 2>/dev/null r\=$v; args "$r"; 2>/dev/null e\xport s=$v; args "$s"; export 2>&1 t\=$v; args "$t""#,
        &[&["a"], &["a"], &["a"], &["a"], &["a"]],
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"v='a b'; f() { e\xport z=$v; args "$z"; }"#), 0);
    assert_eq!(rig.run("f"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["a"]]);
}

#[test]
fn declaration_line_continuations_and_mixed_values_stay_scalar() {
    check(
        "v='a b'; ex\\\nport z=$v; args \"$z\"; export y\\\n=$v; args \"$y\"; export x=\\\n\"p q\"$v; args \"$x\"; f() { lo\\\ncal w\\\n=\"p q\"$v; args \"$w\"; }; f",
        &[&["a b"], &["a b"], &["p qa b"], &["p qa b"]],
    );
}

#[test]
fn declaration_raw_capture_yields_and_can_be_cancelled_before_dispatch() {
    let rig = Rig::new(Limits::default());
    let source = format!("export {}", "v= ".repeat(4000));
    let job = rig.shell.start(&source).unwrap();
    rig.ex.drive(2);
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(!rig.shell.state().borrow().variables.contains_key("v"));
}

#[test]
fn quoted_at_word_trims_a_leading_mixed_ifs_delimiter() {
    check_output(r#"IFS=" :"; v=" :"; f(){ echo $v"$@"; }; f a b"#, "a b\n");
    check(
        r#"IFS=' :'; v=' :'; f() { args $v"$@"; }; f a b; f; f '' b; v=':'; f a b; v=' ::'; f a b; v=' :abc'; f a b; v='a :'; f a b"#,
        &[
            &["a", "b"],
            &[],
            &["", "b"],
            &["", "a", "b"],
            &["", "a", "b"],
            &["abca", "b"],
            &["a", "a", "b"],
        ],
    );
    check(
        r#"IFS=' :'; v=' :'; f() { args ""$v"$@"; args x$v"$@"; args $v"$*"; }; f a b"#,
        &[&["", "a", "b"], &["x", "a", "b"], &["", "a b"]],
    );
    let rig = Rig::new(Limits {
        arguments: 3,
        ..Limits::default()
    });
    rig.variable("IFS", " :");
    rig.variable("v", " :");
    assert_eq!(rig.run(r#"f() { args $v"$@"; }; f a b"#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["a", "b"]]);
    rig.variable("v", ":");
    assert_eq!(rig.run("f a b"), 2);
    assert_eq!(rig.calls.borrow().len(), 1, "overflow must not dispatch");
}

#[test]
fn split_limits_reject_all_fields_without_dispatch_or_truncation() {
    for source in [
        "args $v",
        "$cmd",
        "A=x args $v",
        "f() { args \"$@\" extra; }; f a b",
    ] {
        let rig = Rig::new(Limits {
            arguments: 3,
            ..Limits::default()
        });
        rig.variable("v", "a b c");
        rig.variable("cmd", "args a b c");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
    let rig = Rig::new(Limits {
        arguments: 3,
        ..Limits::default()
    });
    rig.variable("v", ":");
    rig.variable("IFS", ":");
    assert_eq!(rig.run("args $v $v $v"), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn aggregate_expansion_bytes_include_all_fields_and_scalar_operands() {
    for source in ["args $v", "args $v $v", "export x=$v", "A=$v args"] {
        let rig = Rig::new(Limits {
            expansion_bytes: 8,
            ..Limits::default()
        });
        rig.variable("v", "abc def");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
    let rig = Rig::new(Limits {
        expansion_bytes: 8,
        ..Limits::default()
    });
    rig.variable("v", "ab cd");
    assert_eq!(rig.run("args $v"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["ab", "cd"]]);
}

#[test]
fn initial_ifs_is_set_for_scalar_parameter_operators_and_local_restoration() {
    // Clean GNU Bash 5.3.15 starts with nonexported IFS bytes 20 09 0a.
    check(
        r#"args "$IFS" "${IFS+x}" "${IFS-bad}" "${IFS=bad}" "${IFS:=bad}" "${IFS:?bad}"; f() { local IFS=:; args "$IFS"; }; f; args "$IFS""#,
        &[
            &[" \t\n", "x", " \t\n", " \t\n", " \t\n", " \t\n"],
            &[":"],
            &[" \t\n"],
        ],
    );
}

#[test]
fn long_splitting_yields_and_cancellation_restores_frames() {
    let rig = Rig::new(Limits::default());
    rig.variable("IFS", ":");
    rig.variable("v", &" ".repeat(300_000));
    let job = rig
        .shell
        .start("f() { local IFS=' '; args $v; }; f inner")
        .unwrap();
    for _ in 0..200 {
        rig.ex.drive(1);
        if rig
            .shell
            .state()
            .borrow()
            .variables
            .get("IFS")
            .map(String::as_str)
            == Some(" ")
        {
            break;
        }
    }
    assert_eq!(
        rig.shell.state().borrow().variables.get("IFS").unwrap(),
        " "
    );
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(
        peer.is_finished(),
        "splitting must yield to another ready task"
    );
    assert!(!job.is_finished(), "long split must remain interruptible");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.run(r#"args "$#" "$IFS"; f() { args "$@"; }; f restored"#),
        0
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["0", ":"], vec!["restored"]]);
}

#[test]
fn quote_protection_accepts_marker_characters_as_data() {
    let rig = Rig::new(Limits::default());
    let data = (0..=0x1f)
        .chain(0xe000..=0xe0ff)
        .chain(0xfdd0..=0xfdef)
        .chain(0xf0000..=0xf00ff)
        .filter_map(char::from_u32)
        .collect::<String>();
    rig.variable("v", &data);
    rig.variable("space", " ");
    assert_eq!(rig.run(r#"args "$v"$space"""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec![data, String::new()]]);
}

#[test]
fn vanished_words_do_not_consume_argument_capacity() {
    let rig = Rig::new(Limits {
        arguments: 1,
        ..Limits::default()
    });
    assert_eq!(rig.run("args $missing $missing $missing"), 0);
    assert_eq!(*rig.calls.borrow(), &[Vec::<String>::new()]);
    let rig = Rig::new(Limits {
        arguments: 0,
        expansion_bytes: 0,
        ..Limits::default()
    });
    assert_eq!(rig.run("$missing"), 0);
    assert_eq!(rig.run(r#""""#), 2);
}

#[test]
fn aggregate_work_is_bounded_even_when_every_expansion_disappears() {
    let rig = Rig::new(Limits {
        source_bytes: 256,
        expansion_bytes: 128,
        ..Limits::default()
    });
    rig.variable("v", &" ".repeat(128));
    let source = format!("args {}", "$v ".repeat(40));
    assert_eq!(rig.run(&source), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn intermediate_expansion_overflow_rejects_before_dispatch() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16,
        ..Limits::default()
    });
    rig.variable("v", &" ".repeat(17));
    assert_eq!(rig.run("args $v"), 2);
    assert!(rig.calls.borrow().is_empty());
}

// Scalar +/- cases adapted from var-op-test, variables, string-ops,
// param-operand-quotes and word-split at the pinned Bashkit revision.
#[test]
fn scalar_defaults_and_alternatives_distinguish_unset_empty_and_value() {
    check(
        r#"e=; v=value; args "${u-word}" "${u:-word}" "${u+word}" "${u:+word}"; args "${e-word}" "${e:-word}" "${e+word}" "${e:+word}"; args "${v-word}" "${v:-word}" "${v+word}" "${v:+word}"; args "$u" "$e" "$v""#,
        &[
            &["word", "word", "", ""],
            &["", "word", "word", ""],
            &["value", "value", "word", "word"],
            &["", "", "value"],
        ],
    );
    check(
        r#"e=; v=value; args ${u-} ${u:-} ${e-word} ${v+} ${u+word} ${e:+word}; args "${u-}" "${u:-}" "${v+}""#,
        &[&[], &["", "", ""]],
    );
}

#[test]
fn selected_operands_split_and_join_surrounding_text() {
    check(
        r#"args 1${u:-"2 3" "4 5"}6; IFS=_; args 1${u:-"2_3"x_x"4_5"}6; IFS=x; v=; args ${v:-AxBxC}x ${v:-"AxBxC"}x"#,
        &[
            &["12 3", "4 56"],
            &["12_3x", "x4_56"],
            &["A", "B", "Cx", "AxBxCx"],
        ],
    );
    check(
        r#"v=' a b '; args p${u:-$v}s "p${u:-$v}s"; IFS=:; args p${u:-:a::b:}s; IFS=; args p${u:- a b }s"#,
        &[
            &["p", "a", "b", "s", "p a b s"],
            &["p", "a", "", "b", "s"],
            &["p a b s"],
        ],
    );
    check(
        r#"v=' a b '; args p${v-fallback}s p${v+ a b }s; args ${u:-""} ${u:-''} ${u:-$missing} ${u:-"$missing"}"#,
        &[&["p", "a", "b", "s", "p", "a", "b", "s"], &["", "", ""]],
    );
}

#[test]
fn operand_inner_quotes_escapes_and_outer_single_quote_rules() {
    check(
        r#"y=Y; args ${x:-'d'} ${x-'d e'} ${x:-a'b c'd}; args "${x:-'d'}" "${x:+'s'}"; args ${x:-'$y'} "${x:-'$y'}" ${x:-"$y"}; args ${x:-'}'} "${x:-'}'}" ${x:-'a}b'} ${x:-"}"} ${x:-a\}b}"#,
        &[
            &["d", "d e", "ab cd"],
            &["'d'", ""],
            &["$y", "'Y'", "Y"],
            &["}", "'}'", "a}b", "}", "a}b"],
        ],
    );
    check(
        r#"args ${u:-a\ b} ${u:-\$v} ${u:-\"q\"} "${u:-a\qb}" ${u:-'*?[]~{}'}"#,
        &[&["a b", "$v", "\"q\"", "a\\qb", "*?[]~{}"]],
    );
}

#[test]
fn nested_operators_keep_quote_protection_and_lazy_selection() {
    check(
        r#"v=set; e=; args ${u:-${v:+"a b"} c} "${u:-${e:-two words}}" ${u:-${v:+}}; args ${v:-$(args forbidden)} ${u+$(args forbidden)} ${e:+${bad:=write}} ${v:-${bad:?fail}}; args ${u:-${other+$(args forbidden)}} ${v+${v:-$(args forbidden)}}; args "$bad""#,
        &[&["a b", "c", "two words"], &["set", "set"], &["set"], &[""]],
    );
    check(
        r#"v=set; args ${v:-~} ${u+*} ${v:-${a[@]}} ${u+${!v}} ${v:-${v/p/q}}; args "${u+${bad:=x}}""#,
        &[&["set", "set", "set"], &[""]],
    );
}

#[test]
fn scalar_operators_work_in_assignments_declarations_command_names_and_redirects() {
    check(
        r#"v='a b'; x=${u:-$v}; export y=${u:-c d}; f() { local z=${u:-e f}; args "$z"; }; f; args "$x" "$y"; ${cmd:-args promoted} tail; args file >"${path:-a b}"; args "$u""#,
        &[
            &["e f"],
            &["a b", "c d"],
            &["promoted", "tail"],
            &["file"],
            &[""],
        ],
    );
    check(
        r#"f() { local v=inner; args "${v:-fallback}" "${u:-$1}"; }; v=outer; f 'a b'; args "${v:+$v}""#,
        &[&["inner", "a b"], &["outer"]],
    );
}

#[test]
fn selected_unsupported_operands_and_operator_targets_fail_without_dispatch() {
    for source in [
        "args ${u:-$(args forbidden)}",
        "args ${u:-`args forbidden`}",
        "args ${u:-$((1+2))}",
        "args ${u:-$@}",
        "args ${u:-${PIPESTATUS[@]}}",
        "args ${u:-${!v}}",
        "args ${u:-${v/p/q}}",
        "args ${a[0]-x}",
        "args ${1-x}",
        "args ${u:-~}",
        "args ${u:-*}",
        "args ${u:-{a,b}}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert!(!rig.shell.state().borrow().variables.contains_key("u"));
    }
}

#[test]
fn operand_fields_bytes_and_parsing_share_command_limits() {
    for source in [
        "args ${u:-a b c}",
        "A=x args ${u:-a b}",
        "args ${u:-${v}} extra",
    ] {
        let rig = Rig::new(Limits {
            arguments: 3,
            ..Limits::default()
        });
        rig.variable("v", "a b");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
    for source in [
        "args ${u:-abc def}",
        "args ${u:-ab} ${u:-cde}",
        "export x=${u:-a b}",
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 8,
            ..Limits::default()
        });
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
    let rig = Rig::new(Limits {
        source_bytes: 512,
        expansion_bytes: 32,
        arguments: 4,
        ..Limits::default()
    });
    // All selected operands disappear. Repeated small reparses must still spend
    // the same command work allowance instead of resetting parser fuel per call.
    assert_eq!(
        rig.run(&format!("args {}", "${u:-$missing} ".repeat(25))),
        2
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn operand_reparse_admission_rejects_oversize_and_depth_without_literal_fallback() {
    let rig = Rig::new(Limits::default());
    let oversized = format!("args ${{u:-${{v:-{}}}}}", "x".repeat(4096));
    assert_eq!(rig.run(&oversized), 2);
    let deep = format!("args {}x{}", "${u:-".repeat(34), "}".repeat(34));
    assert_eq!(rig.run(&deep), 2);
    assert!(rig.calls.borrow().is_empty());
    // Literal operands do not enter the synchronous parser token path.
    assert_eq!(rig.run(&format!("args ${{u:-{}}}", "x".repeat(5000))), 0);
    assert_eq!(rig.calls.borrow()[0][0].len(), 5000);
}

#[test]
fn selected_operand_scanning_yields_and_cancellation_restores_local_frames() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", "outer");
    let source = format!(
        "f() {{ local v=inner; args ${{u:-{}}}; }}; f arg",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..200 {
        rig.ex.drive(1);
        if rig
            .shell
            .state()
            .borrow()
            .variables
            .get("v")
            .map(String::as_str)
            == Some("inner")
        {
            break;
        }
    }
    assert_eq!(
        rig.shell.state().borrow().variables.get("v").unwrap(),
        "inner"
    );
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run(r#"args "${v:-bad}" "$#" "${u:-recovered}""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["outer", "0", "recovered"]]);
}

#[test]
fn lexer_normalized_backslashes_are_not_decoded_twice() {
    check(
        r#"v=V; args "${u:-\\}" "${u:-\\$v}" "${u:-\\\$v}" "${u:-${z:-\\$v}}" ${u:-"\\$v"} "${u:-${z:-\\}}""#,
        &[&["\\", "\\V", "\\$v", "\\V", "\\V", "\\"]],
    );
}

#[test]
fn unselected_nested_substitutions_own_their_literal_braces() {
    check(
        r#"v=set; args ${u:-${v:-$(echo })}} ${u:-${v:-$(echo '{') }}; args "${u:-${v:-$(echo ') }')}}""#,
        &[&["set", "set"], &["set"]],
    );
}

#[test]
fn alternative_selection_does_not_copy_unused_large_values() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16,
        ..Limits::default()
    });
    rig.variable("v", &"x".repeat(100_000));
    rig.variable("huge", &"x".repeat(100_000));
    assert_eq!(rig.run("args ${v+ok} ${u+$huge}"), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["ok"]]);
    assert_eq!(rig.run("args ${v:-unused}"), 2);
    assert_eq!(rig.calls.borrow().len(), 1);
}

#[test]
fn cancellation_during_nested_token_admission_never_dispatches() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", "outer");
    let source = format!(
        "f() {{ local v=inner; args ${{u:-${{w:-{}}}}}; }}; f arg",
        "x".repeat(3000)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..100 {
        rig.ex.drive(1);
        if rig
            .shell
            .state()
            .borrow()
            .variables
            .get("v")
            .map(String::as_str)
            == Some("inner")
        {
            break;
        }
    }
    // More than the 3,006 scanner steps, less than the reserved reparse work.
    // One executor poll advances at most the 64-step cooperative quantum.
    rig.ex.drive(80);
    assert!(!job.is_finished());
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.shell.state().borrow().variables.get("v").unwrap(),
        "outer"
    );
    assert_eq!(rig.run(r#"args "$#" "${u:-ok}""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["0", "ok"]]);
}

#[test]
fn redirects_and_argv_share_operand_reparse_work() {
    let rig = Rig::new(Limits {
        source_bytes: 80,
        expansion_bytes: 16,
        arguments: 4,
        ..Limits::default()
    });
    rig.variable("p", "q");
    assert_eq!(rig.run("args ${u:-$p} ${u:-$p} ${u:-$p}"), 0);
    assert_eq!(rig.run("args ${u:-$p} ${u:-$p} ${u:-$p} >${u:-$p}"), 2);
    assert_eq!(*rig.calls.borrow(), &[vec!["q", "q", "q"]]);
}

#[test]
fn basic_special_and_positional_operands_remain_scalar() {
    check(
        r#"false; args "${u:-$?}" "${u:-${?}}"; args "${u:-${#}}"; f() { args "${u:-${1}}" ${u:-$2}; }; f 'a b' 'c d'"#,
        &[&["1", "1"], &["0"], &["a b", "c", "d"]],
    );
}

#[test]
fn literal_apostrophe_spans_and_substitution_lookalikes_keep_operand_meaning() {
    check(
        r#"u=; v=VALUE; args "${u:-'\$v'}" "${u:-'${v}'}" ${u:-"<("} "${u:-\`}""#,
        &[&["'$v'", "'VALUE'", "<(", "`"]],
    );
}

#[test]
fn escaped_dollars_in_literal_apostrophe_spans_stay_literal() {
    check(
        r#"u=; v=VALUE; args "${u:-'\$v'}" "${u:-'\${v}'}" "${u:-'\\$v'}" ${u:-'\$v'}"#,
        &[&["'$v'", "'${v}'", "'\\VALUE'", "\\$v"]],
    );
    check(
        r#"u=; v=VALUE; x="${u:-'\$v'}"; export y="${u:-'\${v}'}"; args "$x" "$y" "${u:-${other:-'\$v'}}""#,
        &[&["'$v'", "'${v}'", "'$v'"]],
    );
}

#[test]
fn braced_variables_in_literal_apostrophe_spans_expand() {
    check(
        r#"u=; v=VALUE; args "${u:-'${v}'}" "${u:-'${v:-fallback}'}" "${u:-${other:-'${v}'}}""#,
        &[&["'VALUE'", "'VALUE'", "'VALUE'"]],
    );
    check(
        r#"u=; IFS=:; v='a:b'; args "${u:-'${v}'}" ${u:-"'${v}'"}; x="${u:-'${v}'}"; args "$x""#,
        &[&["'a:b'", "'a:b'"], &["'a:b'"]],
    );
}

#[test]
fn quoted_process_substitution_lookalikes_are_text() {
    check(
        r#"u=; args ${u:-"<("} ${u:-">("} "${u:-<(printf X)}" ${u:-${other:-"<("}}"#,
        &[&["<(", ">(", "<(printf X)", "<("]],
    );
    for source in [
        "args ${u:-<(args forbidden)}",
        "args ${u:->(args forbidden)}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}

#[test]
fn escaped_backticks_and_operand_delimiters_stay_literal() {
    check(
        r#"u=; args "${u:-\`}" ${u:-\`} ${u:-"\`"} ${u:-'`'} "${u:-${other:-\`}}""#,
        &[&["`", "`", "`", "`", "`"]],
    );
    check(
        r#"u=; args "${u:-\\}" "${u:-a\}b}" "${u:-\"q\"}" "${u:-a\{b}" p"${u:-a\}b}"s"#,
        &[&["\\", "a}b", "\"q\"", "a\\{b", "pa}bs"]],
    );
    check(r#"u=; args "${u:-'a\'}""#, &[&["'a\\'"]]);
}

#[test]
fn inner_quoted_backslashes_and_nested_apostrophe_spans_keep_context() {
    check(
        r#"u=; args ${u:-"a\}b"} "${u:-"a\}b"}""#,
        &[&["a\\}b", "a}b"]],
    );
    check(r#"u=; v=; args "${u:-'${v:-'a'}'}""#, &[&["''a''"]]);
}

// Assignment/error cases adapt the scalar Bashkit var-op-test, variables and
// string-ops cases. Status and diagnostic expectations come from GNU Bash 5.3
// and the unchanged frozen oracle, including its top-level status 127.
#[test]
fn scalar_assignment_preserves_unset_null_and_stores_unsplit_values() {
    check(
        r#"e=; v=value; args "${u=one}" "${u=bad}" "${e=bad}" "${e:=two}" "${v:=bad}"; args "$u" "$e" "$v"; args ${space:=a" b "c} "$space"; IFS=:; args p${split:=a:"b:c":d}s "$split""#,
        &[
            &["one", "one", "", "two", "value"],
            &["one", "two", "value"],
            &["a", "b", "c", "a b c"],
            &["pa", "b", "c", "ds", "a:b:c:d"],
        ],
    );
    check(
        r#"args ${u=} "${u?bad}" "${u:=}"; args "${u+set}"; args ${nested:=${inner:=two words}} "$inner" "$nested""#,
        &[
            &["", ""],
            &["set"],
            &["two", "words", "two words", "two words"],
        ],
    );
}

#[test]
fn assignment_quote_removal_keeps_surrounding_word_boundaries() {
    check(
        r#"args p${u:="a b"}s "${u}"; args p${other:-"${inner:=c d}"}s "$inner"; args ${last:=a\ b} "$last""#,
        &[&["pa", "bs", "a b"], &["pc ds", "c d"], &["a", "b", "a b"]],
    );
}

#[test]
fn ifs_assignment_splits_the_entire_expanded_word_with_the_new_value() {
    // Independent GNU Bash observations, including text emitted before the write.
    for (source, expected) in [
        (r#"IFS=; args ${IFS:=:}a:b"#, vec!["", "a:b"]),
        (r#"IFS=; args a:b${IFS:=:}"#, vec!["a", "b"]),
        (r#"IFS=; args a:b"${IFS:=:}""#, vec!["a:b:"]),
        (r#"IFS=; args a:b"${IFS:=:}"${empty}"#, vec!["a", "b:"]),
        (r#"IFS=; args a:b${u:-""}"${IFS:=:}""#, vec!["a", "b:"]),
        (
            r#"IFS=; args a:b${u:-"a:b"}"${IFS:=:}""#,
            vec!["a", "ba:b:"],
        ),
        (r#"IFS=; args a:b${u:=${IFS:=:}}a:b"#, vec!["a", "b", "a:b"]),
        (r#"IFS=; args 'a:b'${IFS:=:}"#, vec!["a:b"]),
        (r#"IFS=; args a\:b${IFS:=:}"#, vec!["a:b"]),
        (r#"IFS=; x=a:b; args ${x}${IFS:=:}"#, vec!["a", "b"]),
        (r#"IFS=; x=a:b; args "${x}"${IFS:=:}"#, vec!["a:b"]),
        (r#"IFS=; x=a:b; args ${x}"${IFS:=:}""#, vec!["a", "b:"]),
        (r#"IFS=; x=a:b; args ${x}${IFS:=:}"""#, vec!["a", "b", ""]),
        (r#"IFS=; args ${u:-a:b}${IFS:=:}"#, vec!["a", "b"]),
        (r#"IFS=; args ${u:-"a:b"}${IFS:=:}"#, vec!["a:b"]),
        (
            r#"IFS=; x=a:b; args ${x}${u:=${IFS:=:}} "$u""#,
            vec!["a", "b", ":"],
        ),
        (
            r#"IFS=; x=a:b; out=${x}${IFS:=:}; args "$out" "$IFS""#,
            vec!["a:b:", ":"],
        ),
    ] {
        check(source, &[&expected]);
    }
}

#[test]
fn ifs_assignment_preserves_quote_and_list_boundaries() {
    for (source, expected) in [
        (
            r#"f() { IFS=; args ${IFS:=:}"$@"; }; f a:b '' c:d"#,
            vec!["", "a:b", "", "c:d"],
        ),
        (
            r#"f() { IFS=; args ${IFS:=:}$@; }; f a:b '' c:d"#,
            vec!["", "a", "b", "", "c", "d"],
        ),
        (
            r#"f() { IFS=; args ${IFS:=:}"$*"; }; f a:b '' c:d"#,
            vec!["", "a:b::c:d"],
        ),
        (
            r#"f() { IFS=; args ${IFS:=:}$*; }; f a:b '' c:d"#,
            vec!["", "a", "b", "", "c", "d"],
        ),
        (
            r#"f() { IFS=; x=a:b; args ${x}${IFS:=:}"$@"; }; f one '' two"#,
            vec!["a", "b", "one", "", "two"],
        ),
        (r#"f() { IFS=; args ${IFS:=:}"$@"; }; f"#, vec![""]),
    ] {
        check(source, &[&expected]);
    }
}

#[test]
fn later_ifs_assignment_resolves_list_separators_without_unquoting_elements() {
    // Independent GNU Bash observations. Generated separators and element
    // spaces have different protection, even within the same list expansion.
    check(
        r#"f() { IFS=; args "$@"${IFS:=:}; }; f one two"#,
        &[&["one two"]],
    );
    check(
        r#"f() { IFS=; args a:b"${IFS:=:}""$@"; }; f"#,
        &[&["a", "b:"]],
    );
    check(r#"f() { IFS=; args a:b"${IFS:=:}""$*"; }; f"#, &[&["a:b:"]]);
    for (word, expected) in [
        (r#""$@"${IFS:=:}"#, vec!["a:b  c:d"]),
        (r#""$@""${IFS:=:}""#, vec!["a:b  c:d:"]),
        (r#"$@${IFS:=:}"#, vec!["a", "b  c", "d"]),
        (r#"$*${IFS:=:}"#, vec!["a:b", "c:d:"]),
        (r#""$*"${IFS:=:}"#, vec!["a:bc:d"]),
        (r#""${@}"${IFS:=:}"#, vec!["a:b  c:d"]),
        (r#"${@}${IFS:=:}"#, vec!["a", "b  c", "d"]),
        (r#"${*}${IFS:=:}"#, vec!["a:b", "c:d:"]),
        (r#""${*}"${IFS:=:}"#, vec!["a:bc:d"]),
        (r#""$@"${IFS:=}"#, vec!["a:b", "", "c:d"]),
        (r#""$@"${empty}"#, vec!["a:b", "", "c:d"]),
        (r#"$@${IFS:=}"#, vec!["a:b", "c:d"]),
        (r#"$*${IFS:=}"#, vec!["a:b", "c:d"]),
        (r#""$@"${IFS:= }"#, vec!["a:b", "", "c:d"]),
        (r#"$@${IFS:= :}"#, vec!["a", "b", "c", "d"]),
        (r#""$@"${IFS:=x }"#, vec!["a:b", "", "c:d"]),
        (r#""$@"${IFS:=ç}"#, vec!["a:b  c:d"]),
        (r#""$@"${IFS:=:}"$@""#, vec!["a:b  c:d", "a:b", "", "c:d"]),
        (
            r#"$@${IFS:=:}$@"#,
            vec!["a", "b  c", "d", "a", "b", "", "c", "d"],
        ),
        (r#"$*${IFS:=:}"$@""#, vec!["a:b", "c:d:a:b::c:d"]),
        (r#"p:"$@"${IFS:=:}":s""#, vec!["p", "a:b  c:d", ":s"]),
        (r#""p:""$@"${IFS:=:}":s""#, vec!["p:a:b  c:d", ":s"]),
        (r#"p:"$@""${IFS:=:}""#, vec!["p", "a:b  c:d:"]),
    ] {
        check(
            &format!("f() {{ IFS=; args {word}; }}; f a:b '' c:d"),
            &[&expected],
        );
    }
}

#[test]
fn ifs_assignment_handles_zero_and_empty_list_elements_in_both_orders() {
    let cases: &[(&str, &[&[&str]])] = &[
        (
            r#""$@"${IFS:=:}"#,
            &[&[""], &[""], &[" "], &["a:b"], &[" a:b "]],
        ),
        (
            r#"$@${IFS:=:}"#,
            &[&[""], &[""], &[" "], &["a", "b"], &[" a", "b "]],
        ),
        (
            r#"$*${IFS:=:}"#,
            &[&[":"], &[":"], &[":"], &["a:b:"], &["a:b", ":"]],
        ),
        (
            r#""$*"${IFS:=:}"#,
            &[&[""], &[""], &[""], &["a:b"], &["a:b"]],
        ),
        (
            r#"${IFS:=:}"$@""#,
            &[
                &[""],
                &["", ""],
                &["", "", ""],
                &["", "a:b"],
                &["", "", "a:b", ""],
            ],
        ),
        (
            r#"${IFS:=:}$@"#,
            &[
                &[""],
                &[""],
                &["", ""],
                &["", "a", "b"],
                &["", "", "a", "b"],
            ],
        ),
        (
            r#"${IFS:=:}$*"#,
            &[
                &[""],
                &[""],
                &["", ""],
                &["", "a", "b"],
                &["", "", "a", "b"],
            ],
        ),
        (
            r#"${IFS:=:}"$*""#,
            &[
                &["", ""],
                &["", ""],
                &["", ":"],
                &["", "a:b"],
                &["", ":a:b:"],
            ],
        ),
        (
            r#""$@"${IFS:=}"#,
            &[&[], &[""], &["", ""], &["a:b"], &["", "a:b", ""]],
        ),
        (
            r#""$@"${empty}"#,
            &[&[], &[""], &["", ""], &["a:b"], &["", "a:b", ""]],
        ),
        (r#"$@${IFS:=}"#, &[&[], &[], &[], &["a:b"], &["a:b"]]),
        (r#"$*${IFS:=}"#, &[&[], &[], &[], &["a:b"], &["a:b"]]),
    ];
    for (word, expected) in cases {
        check(
            &format!("f() {{ IFS=; args {word}; }}; f; f ''; f '' ''; f a:b; f '' a:b ''"),
            expected,
        );
    }
}

#[test]
fn deferred_list_splitting_distinguishes_element_spaces_and_word_split_mode() {
    for (word, expected) in [
        (r#""$@"${IFS:=: }"#, vec!["a:b x", "", "y c:d"]),
        (r#"$@${IFS:=: }"#, vec!["a", "b x", "y c", "d"]),
        (r#"$*${IFS:=: }"#, vec!["a:b x", "y c:d:"]),
        (r#"$*$v${IFS:=:}"#, vec!["a:b x", "y c:dp:q r:"]),
        (r#"$*${IFS:=:}$v"#, vec!["a:b x", "y c:d:p:q", "r"]),
        (r#""$@"${IFS:=:}$v"#, vec!["a:b x  y c:d", "p", "q r"]),
    ] {
        check(
            &format!("f() {{ IFS=; v='p:q r'; args {word}; }}; f 'a:b x' '' 'y c:d'"),
            &[&expected],
        );
    }
    for (word, expected) in [
        ("$v${IFS:= \t\n:}", vec!["a b", "c", "d", "e"]),
        ("${u:-$v}${IFS:= \t\n:}", vec!["a b", "c", "d", "e"]),
        ("${u:=$v}${IFS:= \t\n:}", vec!["a b", "c", "d", "e"]),
    ] {
        check(&format!("IFS=; v='a b\tc\nd:e'; args {word}"), &[&expected]);
    }
    // These observations use native `unset IFS`, not Bash's startup value.
    for (source, expected) in [
        (
            r#"f() { args "$@"${IFS:=:}; }; f a:b '' c:d"#,
            vec!["a:b  c:d"],
        ),
        (
            r#"f() { args $*${IFS:=:}; }; f a:b '' c:d"#,
            vec!["a", "b  c", "d"],
        ),
        (
            r#"f() { v='a b'; args $v"$@"${IFS:=}; }; f"#,
            vec!["a", "b"],
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.shell.state().borrow_mut().variables.remove("IFS"),
            Some(" \t\n".to_owned()),
            "explicitly unset the startup IFS before this observation"
        );
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), &[expected], "{source}");
    }
    check(
        r#"f() { args "$@"${IFS:=:}; }; f a:b '' c:d"#,
        &[&["a:b", "", "c:d"]],
    );
    check(
        r#"f() { args $*${IFS:=:}; }; f a:b '' c:d"#,
        &[&["a:b", "c:d"]],
    );
}

#[test]
fn lexical_escapes_keep_only_the_escaped_character_protected_after_ifs_writes() {
    for (source, expected) in [
        (r#"IFS=; args a:\:b${IFS:=:}"#, vec!["a", ":b"]),
        // Keep neighboring letters splittable, not just neighboring colons.
        (r#"IFS=; args a\:b${IFS:=ab}"#, vec!["", ":", "", ""]),
        (r#"IFS=; args a\:b${IFS:=a}"#, vec!["", ":b"]),
        (r#"IFS=; args a\:b${IFS:=b}"#, vec!["a:", ""]),
        (r#"IFS=; args a\:b${IFS:=:ab}"#, vec!["", ":", "", "", ""]),
        (r#"IFS=; args a"x"b${IFS:=axb}"#, vec!["", "x", "", "", ""]),
        (r#"IFS=; args a\ b${IFS:=ab}"#, vec!["", " ", "", ""]),
        (r#"IFS=; args a\:b:c${IFS:=:}"#, vec!["a:b", "c"]),
        (r#"IFS=; args a""\:b:c${IFS:=:}"#, vec!["a:b", "c"]),
        (r#"IFS=; args "a"\:b:c${IFS:=:}"#, vec!["a:b", "c"]),
        (r#"IFS=; x=ok; xy=wrong; args $x\y${IFS:=y}"#, vec!["oky"]),
        (r#"IFS=; args \$x${IFS:='$'}"#, vec!["$x"]),
        (r#"IFS=; args \${x}${IFS:='$'}"#, vec!["${x}"]),
        (r#"IFS=; args a\"b${IFS:='"'}"#, vec!["a\"b"]),
        (r#"IFS=; args a\'b${IFS:="'"}"#, vec!["a'b"]),
        (r#"IFS=; args a\`b${IFS:='`'}"#, vec!["a`b"]),
        (r#"IFS=; args \~${IFS:='~'}"#, vec!["~"]),
        (r#"IFS=; args a\\b${IFS:='\'}"#, vec!["a\\b"]),
        (r#"IFS=; args a\éb:c${IFS:=é}"#, vec!["aéb:c"]),
        (r#"IFS=; args a\ b${IFS:= }"#, vec!["a b"]),
        (r#"IFS=; args a\*b${IFS:='*'}"#, vec!["a*b"]),
        (r#"IFS=; args "a"\*b${IFS:='*'}"#, vec!["a*b"]),
        (r#"IFS=; args ]a\:b${IFS:=:}"#, vec!["]a:b"]),
        (r#"IFS=; args }a\:b${IFS:=:}"#, vec!["}a:b"]),
        ("IFS=; args a\\\nb${IFS:=a}", vec!["", "b"]),
        ("IFS=; args \"a\\\nb\"${IFS:=a}", vec!["ab"]),
        ("IFS=; args a\\\x1eb${IFS:=:}", vec!["a\x1eb"]),
        ("IFS=; args a\\\x1fb${IFS:=:}", vec!["a\x1fb"]),
        (r#"IFS=; out=a\:b${IFS:=:}; args "$out""#, vec!["a:b:"]),
        (r#"out=\"a:b\"; args "$out""#, vec!["\"a:b\""]),
        (r#"out=\'a:b\'; args "$out""#, vec!["'a:b'"]),
        (
            r#"f() { local IFS=; args a\:b:c${IFS:=:}; }; f"#,
            vec!["a:b", "c"],
        ),
    ] {
        check(source, &[&expected]);
    }
}

#[test]
fn ifs_assignment_keeps_list_word_leading_mixed_delimiter_rules() {
    for word in [
        r#""$@"${IFS:=' :'}"#,
        r#"$@${IFS:=' :'}"#,
        r#"${IFS:=' :'}"$@""#,
        r#"${IFS:=' :'}$@"#,
        r#"${IFS:=' :'}$*"#,
    ] {
        check(&format!("f() {{ IFS=; args {word}; }}; f"), &[&[]]);
    }
    check(r#"IFS=; args ${IFS:=' :'}"#, &[&[""]]);
    check(r#"f() { IFS=; args $*${IFS:=' :'}; }; f"#, &[&[":"]]);
}

#[test]
fn later_ifs_assignment_resolves_pipestatus_list_separators() {
    for (word, expected) in [
        (r#""${PIPESTATUS[@]}"${IFS:=:}"#, vec!["1 0"]),
        (r#"${PIPESTATUS[@]}${IFS:=:}"#, vec!["1 0"]),
        (r#"${PIPESTATUS[*]}${IFS:=:}"#, vec!["1 0"]),
        (r#""${PIPESTATUS[*]}"${IFS:=:}"#, vec!["10"]),
        (r#"${IFS:=:}"${PIPESTATUS[@]}""#, vec!["", "1", "0"]),
        (r#"${IFS:=:}${PIPESTATUS[@]}"#, vec!["", "1", "0"]),
        (r#"${IFS:=:}${PIPESTATUS[*]}"#, vec!["", "1", "0"]),
        (r#"${IFS:=:}"${PIPESTATUS[*]}""#, vec!["", "1:0"]),
    ] {
        check(&format!("IFS=; false | true; args {word}"), &[&expected]);
    }
}

#[test]
fn deferred_list_separators_keep_raw_output_and_field_bounds() {
    let rig = Rig::new(Limits {
        expansion_bytes: 8,
        ..Limits::default()
    });
    // Nine generated separators exceed raw bytes even though splitting drops them.
    assert_eq!(
        rig.run(r#"f() { IFS=; args "$@"${IFS:= }; }; f '' '' '' '' '' '' '' '' '' ''"#),
        2
    );
    assert!(rig.calls.borrow().is_empty());

    for (bytes, status) in [(8, 2), (9, 0)] {
        let rig = Rig::new(Limits {
            expansion_bytes: bytes,
            ..Limits::default()
        });
        assert_eq!(
            rig.run(r#"f() { IFS=; args "$@"${IFS:=:}; }; f aa bb"#),
            status
        );
        if status == 0 {
            assert_eq!(*rig.calls.borrow(), &[vec!["aa bb"]]);
        } else {
            assert!(rig.calls.borrow().is_empty());
        }
    }
    let rig = Rig::new(Limits {
        arguments: 3,
        ..Limits::default()
    });
    assert_eq!(rig.run(r#"f() { IFS=; args $@${IFS:=:}; }; f a:b c:d"#), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn deferred_list_separator_replay_yields_and_cancels_after_the_ifs_write() {
    let rig = Rig::new(Limits::default());
    rig.variable("IFS", "|");
    let source = format!(
        r#"f() {{ local IFS=; args "$@"${{IFS:=:}}; }}; f {}"#,
        "'' ".repeat(2048)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..1000 {
        rig.ex.drive(1);
        if rig
            .shell
            .state()
            .borrow()
            .variables
            .get("IFS")
            .map(String::as_str)
            == Some(":")
        {
            break;
        }
    }
    assert_eq!(
        rig.shell.state().borrow().variables.get("IFS").unwrap(),
        ":"
    );
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(
        !job.is_finished(),
        "separator replay must yield before dispatch"
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.shell.state().borrow().variables.get("IFS").unwrap(),
        "|"
    );
    assert_eq!(rig.run(r#"args "$#""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["0"]]);
}

#[test]
fn deferred_ifs_splitting_keeps_field_byte_and_shared_work_bounds() {
    let rig = Rig::new(Limits {
        arguments: 3,
        ..Limits::default()
    });
    rig.variable("v", "a:b:c");
    assert_eq!(rig.run("IFS=; args ${v}${IFS:=:}"), 2);
    assert!(rig.calls.borrow().is_empty());

    let rig = Rig::new(Limits {
        expansion_bytes: 32,
        ..Limits::default()
    });
    rig.variable("v", &" ".repeat(33));
    assert_eq!(rig.run("IFS=; args ${v}${IFS:= }"), 2);
    assert!(rig.calls.borrow().is_empty());

    let rig = Rig::new(Limits {
        expansion_bytes: 8,
        ..Limits::default()
    });
    rig.variable("v", "abc:def");
    assert_eq!(rig.run("IFS=; args ${v}${IFS:=:}"), 2);
    assert!(rig.calls.borrow().is_empty());

    let rig = Rig::new(Limits {
        source_bytes: 128,
        expansion_bytes: 128,
        arguments: 4,
        ..Limits::default()
    });
    rig.variable("v", &" ".repeat(110));
    assert_eq!(rig.run("IFS=; args ${v}${IFS:= } $v"), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn deferred_ifs_splitting_yields_and_cancels_after_the_parameter_write() {
    let rig = Rig::new(Limits::default());
    rig.variable("IFS", ":");
    rig.variable("v", &" ".repeat(8192));
    let job = rig
        .shell
        .start("f() { local IFS=; args ${v}${IFS:= }; }; f")
        .unwrap();
    for _ in 0..1000 {
        rig.ex.drive(1);
        if rig
            .shell
            .state()
            .borrow()
            .variables
            .get("IFS")
            .map(String::as_str)
            == Some(" ")
        {
            break;
        }
    }
    assert_eq!(
        rig.shell.state().borrow().variables.get("IFS").unwrap(),
        " "
    );
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    assert!(
        !job.is_finished(),
        "the deferred split must remain interruptible"
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.shell.state().borrow().variables.get("IFS").unwrap(),
        ":"
    );
}

#[test]
fn assignment_effects_reach_rhs_argv_declarations_and_redirects() {
    check(
        r#"a=${b:=B} c=${a:=bad}; args "$a" "$b" "$c"; ${cmd:=args} "${arg:=A}" >"${path:=file}"; args "$cmd" "$arg" "$path"; export x=${y:=Y}; f() { local z=${nested:=N}; args "$z"; }; f; args "$x" "$y" "$nested""#,
        &[
            &["B", "B", "B"],
            &["A"],
            &["args", "A", "file"],
            &["N"],
            &["Y", "Y", "N"],
        ],
    );
    check(
        r#"a=outer; a= b=${a:=inner} args "${arg:=A}"; args "$a" "$b" "$arg"; x=${y:=rhs} args "${y:=argv}"; args "$x" "$y""#,
        &[&["A"], &["inner", "", "A"], &["argv"], &["", "argv"]],
    );
    check(
        r#"a=one >"${path:=$a}"; args "$a" "$path"; f() { local v=; args "${v:=inside}" "${global:=outside}"; }; v=before; f; args "$v" "$global""#,
        &[
            &["one", "one"],
            &["inside", "outside"],
            &["before", "outside"],
        ],
    );
}

#[test]
fn assignment_and_error_operands_are_lazy_including_unsupported_syntax() {
    check(
        r#"v=set; e=; args ${v:=$(args forbidden)} ${v=${bad:?fail}} "${e=$(args forbidden)}" ${v?$(args forbidden)} "${e?$(args forbidden)}" ${v:?${bad:=bad}}; args "$bad"; args ${u+${bad:?fail}} ${v:-${bad:=bad}}"#,
        &[&["set", "set", "", "set", "", "set"], &[""], &["set"]],
    );
    for source in [
        "args ${u:=$(args forbidden)}",
        "args ${u:?$((1+2))}",
        "args ${u:=$@}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
        assert!(!rig.shell.state().borrow().variables.contains_key("u"));
    }
}

#[test]
fn fatal_parameter_errors_stop_sequences_functions_and_conditions() {
    for (source, line, message) in [
        (
            "echo before; args ${u?}; args after",
            1,
            "u: parameter not set",
        ),
        (
            "u=;\nargs ${u:?}; args after",
            2,
            "u: parameter null or not set",
        ),
        ("args ${u?two words}; args after", 1, "u: two words"),
        ("args ${u:?\"\"}; args after", 1, "u: "),
        ("args ${u?${missing}}; args after", 1, "u: "),
        (
            "f() {\n local v=inside; args ${u:?bad}; args bad;\n}; f; args after",
            2,
            "u: bad",
        ),
        ("args ${u:?bad} || args after", 1, "u: bad"),
        (
            "while args ${u:?bad}; do args after; done; args after",
            1,
            "u: bad",
        ),
        ("a=${u:?bad}; args after", 1, "u: bad"),
        ("args >${u:?bad}; args after", 1, "u: bad"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("v", "outside");
        assert_eq!(rig.run(source), 127, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line {line}: {message}\n").as_bytes(),
            "{source}"
        );
        assert_eq!(
            rig.shell.state().borrow().variables.get("v").unwrap(),
            "outside"
        );
        assert_eq!(rig.run(r#"args "$#" "$v""#), 0);
        assert_eq!(*rig.calls.borrow(), &[vec!["0", "outside"]]);
    }
}

#[test]
fn fatal_errors_keep_completed_effects_and_route_diagnostics() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"echo before; a=${saved:=yes} b=${u:?${detail:=two words}}; args after"#),
        127
    );
    assert_eq!(rig.output.bytes(), b"before\n");
    assert_eq!(rig.run(r#"args "$saved" "$detail""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["yes", "two words"]]);
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=${u:?bad} 2>errors; args after"), 127);
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: u: bad\n");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=${u:?bad} args 2>errors; args after"), 127);
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: line 1: u: bad\n");
    assert!(rig.fs.read_file("/home/guest/errors").unwrap().is_empty());
}

#[test]
fn fatal_errors_and_writes_are_contained_in_isolated_environments() {
    check(
        r#"(args ${u:?bad}; args bad); args "$?"; args "${u-unset}"; args ${u:?bad} | args stage; args "${PIPESTATUS[@]}"; { args ${u:?bad}; args bad; } | args group; args "${PIPESTATUS[@]}"; args ${u:?bad} & wait 1; args "$?"; (args "${side:=child}"); args "${side-unset}""#,
        &[
            &["1"],
            &["unset"],
            &["stage"],
            &["127", "0"],
            &["group"],
            &["1", "0"],
            &["127"],
            &["child"],
            &["unset"],
        ],
    );
    check(
        r#"(args) >${path:?bad}; args "$?"; args "${path-unset}"; echo "${side:=parent}" | args sink; args "${side-unset}""#,
        &[&["127"], &["unset"], &["sink"], &["unset"]],
    );
}

#[test]
fn assignment_storage_and_error_diagnostics_are_bounded() {
    for source in [
        "args ${u:=$large}",
        "args ${u:?$large}",
        "args ${u:=${v:=$large}}",
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 32,
            ..Limits::default()
        });
        rig.variable("large", &"x".repeat(33));
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
        assert!(rig.errors.bytes().is_empty());
        assert!(!rig.shell.state().borrow().variables.contains_key("u"));
    }
}

#[test]
fn parameter_writes_share_storage_admission_even_when_fields_fit() {
    let rig = Rig::new(Limits {
        expansion_bytes: 32,
        ..Limits::default()
    });
    assert_eq!(
        rig.run("args ${aa:=123456789} ${bb:=123456789} ${cc:=123456789}"),
        2
    );
    assert!(rig.calls.borrow().is_empty());
    let state = rig.shell.state();
    let state = state.borrow();
    assert_eq!(
        state.variables.get("aa").map(String::as_str),
        Some("123456789")
    );
    assert_eq!(
        state.variables.get("bb").map(String::as_str),
        Some("123456789")
    );
    assert!(!state.variables.contains_key("cc"));
}

#[test]
fn cancellation_keeps_completed_rhs_effects_and_restores_local_prefix_frames() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", "outer");
    let source = format!(
        "f() {{ local v=; a=${{saved:=yes}} b=${{v:=inner}} c=${{long:={}}} args; }}; f arg",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..500 {
        rig.ex.drive(1);
        if rig.shell.state().borrow().variables.contains_key("saved") {
            break;
        }
    }
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("saved")
            .map(String::as_str),
        Some("yes")
    );
    rig.ex.drive(4);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run(r#"args "$saved" "$v" "$a" "$b" "$long" "$#""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        &[vec!["yes", "outer", "", "", "", "0"]]
    );
}

#[test]
fn frozen_scalar_error_observations_keep_exact_status_and_output() {
    // Verbatim scripts and observations from the committed oracle. No fixture
    // membership, classifications, identities or expected statuses are changed.
    for (source, error) in [
        (
            "empty=''\necho ${empty:?'is em'pty}  # test eval of error\necho should not get here\n\n",
            "/usr/bin/bash: line 2: empty: is empty\n",
        ),
        (
            "echo ${unset?is empty}\necho should not get here\n\n",
            "/usr/bin/bash: line 1: unset: is empty\n",
        ),
        (
            "echo \"${non_existent_var?error message}\"\necho \"This should never execute\"\n",
            "/usr/bin/bash: line 1: non_existent_var: error message\n",
        ),
        (
            "${UNSET_VAR:?\"variable not set\"}\n",
            "/usr/bin/bash: line 1: UNSET_VAR: variable not set\n",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 127, "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert_eq!(rig.errors.bytes(), error.as_bytes(), "{source}");
    }
}

#[test]
fn cancellation_during_error_operand_keeps_effects_without_partial_diagnostic() {
    let rig = Rig::new(Limits::default());
    let source = format!(
        "f() {{ local v=inside; args ${{u:?${{saved:=yes}}{}}}; }}; f arg",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..500 {
        rig.ex.drive(1);
        if rig.shell.state().borrow().variables.contains_key("saved") {
            break;
        }
    }
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("saved")
            .map(String::as_str),
        Some("yes")
    );
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.run(r#"args "$saved" "$v" "$#""#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["yes", "", "0"]]);
}

#[test]
fn review_assignment_uses_post_expansion_ifs() {
    check(r#"IFS=; args ${IFS:=:}a:b"#, &[&["", "a:b"]]);
}

#[test]
fn review_redirect_error_keeps_completed_stderr_redirect() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("echo ok 2>&1 >${u:?bad}; args after"), 127);
    assert_eq!(rig.output.bytes(), b"/usr/bin/bash: line 1: u: bad\n");
    assert!(rig.errors.bytes().is_empty());
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn review_compound_redirect_errors_keep_pre_body_child_status() {
    check(
        r#"{ args body; } >${u:?bad} | args sink; args "${PIPESTATUS[@]}"; { args body; } >${u:?bad} & wait 1; args "$?""#,
        &[&["sink"], &["127", "0"], &["127"]],
    );
}

#[test]
fn review_multiline_compound_redirect_errors_keep_source_line() {
    for source in [
        "\n\n{ args body; } >${u:?bad}",
        "\n\n(args body) >${u:?bad}",
    ] {
        let rig = Rig::new(Limits::default());
        assert_ne!(rig.run(source), 0, "{source}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 3: u: bad\n",
            "{source}"
        );
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn multiline_parameter_errors_use_bash_parse_time_diagnostic_lines() {
    // Exact expectations from bounded GNU Bash probes, independent of the
    // evaluator's location metadata. These native regressions await CI.
    for (case, source, status, stdout, stderr) in [
        (
            "simple continued target",
            "echo >\\\n${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
        ),
        (
            "simple multiline first word",
            "\"cmd\n\" >${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "simple multiline prefix",
            "a=\"one\ntwo\" echo >${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "simple prefix redirect",
            ">\\\n${u:?bad} echo",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "simple later multiline word",
            "echo \"one\ntwo\" >${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
        ),
        (
            "simple later multiline operand",
            "echo >\"${u:?first\nsecond}\"",
            127,
            "",
            "/usr/bin/bash: line 1: u: first\nsecond\n",
        ),
        (
            "simple first multiline operand",
            "\"${u:?first\nsecond}\"",
            127,
            "",
            "/usr/bin/bash: line 2: u: first\nsecond\n",
        ),
        (
            "assignment multiline operand",
            "a=\"${u:?first\nsecond}\"",
            127,
            "",
            "/usr/bin/bash: line 2: u: first\nsecond\n",
        ),
        (
            "bare continued redirect",
            "\n>\\\n${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "brace redirect",
            "{\n :\n} >${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "brace continued target",
            "{\n :\n} >\\\n${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 4: u: bad\n",
        ),
        (
            "brace multiline operand",
            "{\n :\n} >\"${u:?first\nsecond}\"",
            127,
            "",
            "/usr/bin/bash: line 4: u: first\nsecond\n",
        ),
        (
            "brace nested multiline operand",
            "{ :; } >${x:-${u:?one\ntwo}}",
            127,
            "",
            "/usr/bin/bash: line 2: u: one\ntwo\n",
        ),
        (
            "brace last redirect anchors earlier error",
            "{ :; } >${u:?bad} >\"later\nword\"",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "subshell redirect",
            "(\n :\n) >${u:?bad}; echo status=$?",
            0,
            "status=127\n",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "subshell multiline redirect",
            "(\n :\n) >\"${u:?one\ntwo}\"; echo status=$?",
            0,
            "status=127\n",
            "/usr/bin/bash: line 3: u: one\ntwo\n",
        ),
        (
            "subshell continued target",
            "(\n :\n) >\\\n${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "function body simple redirect",
            "f() {\n : >${u:?bad};\n}\nf",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "function brace redirect",
            "\nf() {\n :\n} >${u:?bad}\nf",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "function brace on next line",
            "f()\n{\n :\n} >${u:?bad}\nf",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "function keyword brace redirect",
            "\nfunction f {\n :\n} >${u:?bad}\nf",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "function multiline brace redirect",
            "\nf() {\n :\n} >\"${u:?one\ntwo}\"\nf",
            127,
            "",
            "/usr/bin/bash: line 2: u: one\ntwo\n",
        ),
        (
            "function invocation redirect",
            "f() { :; }\nf >\\\n${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 2: u: bad\n",
        ),
        (
            "function subshell redirect",
            "f() (\n :\n) >${u:?bad}\nf",
            127,
            "",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "while redirect",
            "while false; do\n :\ndone >${u:?bad}",
            127,
            "",
            "/usr/bin/bash: line 3: u: bad\n",
        ),
        (
            "while multiline redirect",
            "while false; do\n :\ndone >\"${u:?one\ntwo}\"",
            127,
            "",
            "/usr/bin/bash: line 4: u: one\ntwo\n",
        ),
        (
            "while condition redirect",
            "while : >\\\n${u:?bad}; do :; done",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
        ),
        (
            "function while redirect",
            "\nf() while false; do\n :\ndone >${u:?bad}\nf",
            127,
            "",
            "/usr/bin/bash: u: bad\n",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status, "{case}: {source}");
        assert_eq!(rig.output.bytes(), stdout.as_bytes(), "{case}: {source}");
        assert_eq!(rig.errors.bytes(), stderr.as_bytes(), "{case}: {source}");
        assert!(rig.calls.borrow().is_empty(), "{case}: {source}");
    }
}

#[test]
fn redirect_errors_preserve_applied_stderr_and_child_phase_status() {
    // Exact GNU Bash observations. The fixture's wait operand is job ID 1;
    // the Bash probe uses wait $! for the corresponding background process.
    for (case, source, status, stdout, stderr, file) in [
        (
            "simple redirected stdout",
            "echo ok 2>&1 >${u:?bad}; echo after",
            127,
            "/usr/bin/bash: line 1: u: bad\n",
            "",
            None,
        ),
        (
            "simple redirected file",
            "echo ok 2>errors >${u:?bad}; echo after",
            127,
            "",
            "",
            Some("/usr/bin/bash: line 1: u: bad\n"),
        ),
        (
            "simple closed stderr",
            "echo ok 2>&- >${u:?bad}; echo after",
            127,
            "",
            "",
            None,
        ),
        (
            "simple restored stderr",
            "echo ok 3>&2 2>&1 2>&3 >${u:?bad}; echo after",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "prefix RHS original stderr",
            "a=${u:?bad} echo ok 2>&1; echo after",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "prefix RHS original stderr with file",
            "a=${u:?bad} echo ok 2>errors; echo after",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "assignment-only RHS original stderr",
            "a=${u:?bad} 2>&1; echo after",
            127,
            "",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "brace redirected stdout",
            "\n{ echo body; } 2>&1 >${u:?bad}; echo after",
            127,
            "/usr/bin/bash: line 2: u: bad\n",
            "",
            None,
        ),
        (
            "brace redirected file",
            "{ echo body; } 2>errors >${u:?bad}; echo after",
            127,
            "",
            "",
            Some("/usr/bin/bash: line 1: u: bad\n"),
        ),
        (
            "subshell redirected stdout",
            "(echo body) 2>&1 >${u:?bad}; echo status=$?",
            0,
            "/usr/bin/bash: line 1: u: bad\nstatus=127\n",
            "",
            None,
        ),
        (
            "pipeline compound redirect",
            "{ echo body; } >${u:?bad} | cat; echo \"${PIPESTATUS[@]}\"",
            0,
            "127 0\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "pipeline compound body",
            "{ echo ${u:?bad}; } | cat; echo \"${PIPESTATUS[@]}\"",
            0,
            "1 0\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "pipeline compound redirected diagnostic",
            "\n{\n echo body;\n} 2>&1 >${u:?bad} | cat; echo \"${PIPESTATUS[@]}\"",
            0,
            "/usr/bin/bash: line 4: u: bad\n127 0\n",
            "",
            None,
        ),
        (
            "pipeline while redirect",
            "while false; do :; done >${u:?bad} | cat; echo \"${PIPESTATUS[@]}\"",
            0,
            "127 0\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "pipeline while body",
            "while true; do echo ${u:?bad}; done | cat; echo \"${PIPESTATUS[@]}\"",
            0,
            "1 0\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "background compound redirect",
            "{ echo body; } >${u:?bad} & wait 1; echo status=$?",
            0,
            "status=127\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "background compound body",
            "{ echo ${u:?bad}; } & wait 1; echo status=$?",
            0,
            "status=1\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "background compound redirected diagnostic",
            "{ echo body; } 2>&1 >${u:?bad} & wait 1; echo status=$?",
            0,
            "/usr/bin/bash: line 1: u: bad\nstatus=127\n",
            "",
            None,
        ),
        (
            "subshell compound redirect",
            "( { echo body; } >${u:?bad}; echo after ); echo status=$?",
            0,
            "status=1\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "subshell pipeline redirect",
            "( { echo body; } >${u:?bad} | cat; echo \"${PIPESTATUS[@]}\" )",
            0,
            "1 0\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "background AND-OR redirect",
            "{ echo body; } >${u:?bad} && : & wait 1; echo status=$?",
            0,
            "status=1\n",
            "/usr/bin/bash: line 1: u: bad\n",
            None,
        ),
        (
            "function partial redirect restores locals",
            "f() { local v=inner; echo body 2>&1 >${u:?${saved:=bad}}; echo after; }; v=outer; f; echo after",
            127,
            "/usr/bin/bash: line 1: u: bad\n",
            "",
            None,
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status, "{case}: {source}");
        assert_eq!(rig.output.bytes(), stdout.as_bytes(), "{case}: {source}");
        assert_eq!(rig.errors.bytes(), stderr.as_bytes(), "{case}: {source}");
        assert!(rig.calls.borrow().is_empty(), "{case}: {source}");
        if let Some(file) = file {
            assert_eq!(
                rig.fs.read_file("/home/guest/errors").unwrap(),
                file.as_bytes(),
                "{case}: {source}"
            );
        }
    }
}

#[test]
fn partial_redirect_failure_restores_function_state_and_session_descriptors() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("f() { local v=inner; echo body 2>&1 >${u:?${saved:=bad}}; }; v=outer; f"),
        127
    );
    assert_eq!(rig.output.bytes(), b"/usr/bin/bash: line 1: u: bad\n");
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(
        rig.run(r#"args "$v" "$saved" "$#"; echo recovered; echo diagnostic >&2"#),
        0
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["outer", "bad", "0"]]);
    assert_eq!(
        rig.output.bytes(),
        b"/usr/bin/bash: line 1: u: bad\nrecovered\n"
    );
    assert_eq!(rig.errors.bytes(), b"diagnostic\n");
}

#[test]
fn cancellation_during_redirect_target_keeps_effects_and_restores_frames() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", "outer");
    let source = format!(
        "f() {{ local v=inner; echo body 2>&1 >${{u:?${{saved:=yes}}{}}}; }}; f arg",
        "x".repeat(100_000)
    );
    let job = rig.shell.start(&source).unwrap();
    for _ in 0..500 {
        rig.ex.drive(1);
        if rig.shell.state().borrow().variables.contains_key("saved") {
            break;
        }
    }
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .variables
            .get("saved")
            .map(String::as_str),
        Some("yes")
    );
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.run(r#"args "$v" "$saved" "$#"; echo recovered"#), 0);
    assert_eq!(*rig.calls.borrow(), &[vec!["outer", "yes", "0"]]);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}
