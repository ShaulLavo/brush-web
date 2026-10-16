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
        let shell = Session::new(
            ex.clone(),
            Rc::new(host.clone()),
            Rc::new(MemoryFs::new(1024)),
            limits,
        );
        let (out, output) = capture(64 * 1024);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out);
        fds.insert(2, Endpoint::null());
        shell.set_descriptors(fds).unwrap();
        Self {
            ex,
            shell,
            host,
            calls,
            output,
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
