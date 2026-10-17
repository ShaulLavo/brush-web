//! Original case-pattern positional adapter. GNU Bash expands without pathname
//! or IFS field splitting here, but selects the first field produced by quoted
//! multi-value `$@` when IFS is nonempty/unset. No upstream implementation copied.
use super::{Error, Expansion, Protection};
use crate::state::SharedState;

impl Expansion<'_> {
    pub(super) async fn case_positionals(
        &mut self,
        state: &SharedState,
        at: bool,
        quoted: bool,
    ) -> Result<(), Error> {
        let count = state.borrow().positional.len();
        if count > self.elements_remaining {
            return Err(2.into());
        }
        self.elements_remaining -= count;
        let ifs_separator = self.ifs_separator(state).await?;
        // Scalar @ joins with spaces. Scalar * uses the first IFS character;
        // empty IFS concatenates, while unset IFS defaults to a space.
        let separator = if at {
            Some(' ')
        } else {
            self.positional_star_separator(state).await?
        };
        let first_field = at && quoted && ifs_separator.is_some() && count > 1;
        let protection = Protection::expansion(quoted, state);
        for index in 0..count {
            self.work.checkpoint(self.cancel).await?;
            if index != 0 {
                if first_field {
                    self.pattern.as_mut().ok_or(2)?.finish_first_field();
                }
                self.separator(separator, quoted).await?;
            }
            let value = {
                let state = state.borrow();
                let value = &state.positional[index];
                if value.len() > self.snapshot_max() {
                    return Err(2.into());
                }
                self.work.admit_storage(value.len())?;
                value.clone()
            };
            self.admit_pattern_snapshot(&value).await?;
            self.segment(&value, protection, quoted).await?;
        }
        // Discarded later fields do not stop scanning: suffix substitutions,
        // assignments, errors and shared work/storage limits still take effect.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Work, operand, pattern};
    use super::*;
    use crate::{
        Limits, Session,
        executor::{Cancel, Executor},
        io::MemoryFs,
        process::InProcessHost,
        state::State,
    };
    use futures::FutureExt;
    use shell_parser::parser::{Word, WordPart};
    use std::{future::Future, rc::Rc, task::Poll};

    fn finish<T>(future: impl Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let mut context = std::task::Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..4096 {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
        panic!("bounded case-pattern future did not finish");
    }

    fn matches(source: &str, values: &[&str], ifs: Option<&str>, value: &str) -> bool {
        let mut state = State::default();
        state.positional = values.iter().map(|value| (*value).to_owned()).collect();
        if let Some(ifs) = ifs {
            state.variables.insert("IFS".into(), ifs.into());
        }
        let state = state.shared();
        let word = Word {
            raw: Some(source.into()),
            ..Word::literal("")
        };
        let cancel = Cancel::new();
        let mut work = Work::new(16384, 16384, 16);
        let mut pattern = finish(pattern(&word, &state, &cancel, 1024, &mut work))
            .unwrap_or_else(|_| panic!("case pattern must expand: {source}"));
        finish(pattern.matches_full(value, &mut work, &cancel))
            .unwrap_or_else(|_| panic!("case pattern must match within its budget"))
    }

    #[test]
    fn positional_case_patterns_keep_quotes_and_bash_first_field_rules() {
        for source in ["$@", "${@}"] {
            for ifs in [None, Some(":"), Some("")] {
                assert!(matches(source, &["a*", "b"], ifs, "ax b"));
                assert!(!matches(source, &["a*", "b"], ifs, "ax:b"));
            }
        }
        for source in ["\"$@\"", "\"${@}\""] {
            for ifs in [None, Some(":")] {
                assert!(matches(source, &["a*", "b"], ifs, "a*"));
                assert!(!matches(source, &["a*", "b"], ifs, "ax"));
                assert!(!matches(source, &["a*", "b"], ifs, "a* b"));
            }
            assert!(matches(source, &["a*", "b"], Some(""), "a* b"));
            assert!(!matches(source, &["a*", "b"], Some(""), "ax b"));
        }
        for source in ["$*", "${*}"] {
            assert!(matches(source, &["a*", "b"], None, "ax b"));
            assert!(matches(source, &["a*", "b"], Some(":"), "ax:b"));
            assert!(matches(source, &["a*", "b"], Some(""), "axb"));
        }
        for source in ["\"$*\"", "\"${*}\""] {
            assert!(matches(source, &["a*", "b"], None, "a* b"));
            assert!(matches(source, &["a*", "b"], Some(":"), "a*:b"));
            assert!(matches(source, &["a*", "b"], Some(""), "a*b"));
            assert!(!matches(source, &["a*", "b"], Some(""), "axb"));
        }
        assert!(matches("pre\"$@\"post", &["a", "b"], None, "prea"));
        assert!(matches(
            "pre\"$@\"post",
            &["a", "b"],
            Some(""),
            "prea bpost"
        ));
        assert!(matches("pre\"$@\"post", &["a"], None, "preapost"));
        for source in ["$@", "$*", "\"$@\"", "\"$*\""] {
            assert!(matches(source, &[], None, ""));
        }
    }

    #[test]
    fn first_field_selection_still_evaluates_suffix_assignments() {
        let mut state = State::default();
        state.positional = vec!["a".into(), "b".into()];
        let state = state.shared();
        let word = Word {
            raw: Some("\"$@\"${side:=written}".into()),
            ..Word::literal("")
        };
        let cancel = Cancel::new();
        let mut work = Work::new(16384, 16384, 16);
        let mut pattern = finish(pattern(&word, &state, &cancel, 1024, &mut work))
            .unwrap_or_else(|_| panic!("suffix assignment must expand"));
        assert_eq!(
            state.borrow().variables.get("side").map(String::as_str),
            Some("written")
        );
        assert!(
            finish(pattern.matches_full("a", &mut work, &cancel))
                .unwrap_or_else(|_| panic!("first field must remain matchable"))
        );
    }

    #[test]
    fn raw_patterns_are_borrowed_and_synthetic_words_fail_explicitly() {
        let word = Word {
            raw: Some("'".repeat(1024)),
            ..Word::literal("")
        };
        let state = State::default().shared();
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(16384, 0, 1);
        assert!(matches!(
            pattern(&word, &state, &cancel, 1024, &mut work).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(work.storage_remaining, 0);
        let cancel = Cancel::new();
        let word = Word {
            raw: Some("\"\"".into()),
            ..Word::literal("")
        };
        let mut work = Work::new(32, 0, 1);
        assert!(finish(pattern(&word, &state, &cancel, 1024, &mut work)).is_ok());
        assert_eq!(work.storage_remaining, 0);
        let mut work = Work::new(32, 0, 1);
        assert!(matches!(
            finish(pattern(
                &Word::literal("x"),
                &state,
                &cancel,
                1024,
                &mut work
            )),
            Err(Error::Status(2))
        ));
    }

    #[test]
    fn case_positionals_do_not_widen_general_scalar_operands() {
        for source in ["$@", "$*", "${@}", "${*}"] {
            let mut scanner = operand::Scanner::new(source, false, true, true);
            let mut work = Work::new(1024, 1024, 1);
            assert!(matches!(
                finish(scanner.next(&mut work, &Cancel::new())),
                Err(Error::Status(2))
            ));
        }
    }

    #[test]
    fn case_matcher_exhaustion_is_an_error_not_a_miss() {
        for steps in [0, 1] {
            let mut pattern = pattern::Pattern::default();
            let mut work = Work::new(32, 1024, 1);
            pattern
                .push('*', super::super::Protection::None, &mut work)
                .unwrap_or_else(|_| panic!("one pattern character must fit"));
            let mut work = Work::new(steps, 1024, 1);
            assert!(matches!(
                finish(pattern.matches_full("x", &mut work, &Cancel::new())),
                Err(Error::Status(2))
            ));
        }
        let mut pattern = pattern::Pattern::default();
        let mut work = Work::new(32, 0, 1);
        assert!(matches!(
            finish(pattern.matches_full("x", &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
    }

    #[test]
    fn case_resource_exhaustion_never_dispatches_a_body() {
        // The first case exhausts storage during expansion. The second fits
        // pattern storage, but the matcher exceeds the command's work budget.
        let costly = format!(
            "case {} in {}) touched=yes;; esac",
            "x".repeat(256),
            "*?".repeat(32)
        );
        for (source, expansion_bytes) in [
            ("case x in x) touched=yes;; esac", 1),
            (costly.as_str(), 4096),
        ] {
            let executor = Executor::new();
            let host = InProcessHost::new(executor.clone());
            let session = Session::new(
                executor.clone(),
                Rc::new(host),
                Rc::new(MemoryFs::new(1024)),
                Limits {
                    source_bytes: source.len(),
                    expansion_bytes,
                    arguments: 1,
                    ..Limits::default()
                },
            );
            let job = session
                .start(source)
                .unwrap_or_else(|_| panic!("small case must parse"));
            for _ in 0..4096 {
                if job.is_finished() {
                    break;
                }
                executor.drive(64);
            }
            assert!(job.is_finished(), "bounded case session did not finish");
            assert_eq!(job.now_or_never(), Some(2));
            assert!(!session.state().borrow().variables.contains_key("touched"));
        }
    }

    #[test]
    fn no_raw_pattern_does_not_fall_back_to_display() {
        // Display of this command substitution would walk an unrelated AST.
        // Missing raw text must reject it without visiting/printing its parts.
        let word = Word {
            parts: vec![WordPart::CommandSubstitution(Vec::new())],
            ..Word::literal("")
        };
        let mut work = Work::new(32, 0, 1);
        assert!(matches!(
            finish(pattern(
                &word,
                &State::default().shared(),
                &Cancel::new(),
                1024,
                &mut work
            )),
            Err(Error::Status(2))
        ));
    }
}
