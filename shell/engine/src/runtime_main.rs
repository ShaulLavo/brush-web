//! Persistent interactive WASI shell. Host stdin/stdout are runtime_proc endpoints;
//! blocking preview1 fd_read/fd_write are never used by the shell's reactor.
#[cfg(any(target_os = "wasi", test))]
mod terminal;
#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("shell-runtime requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
fn main() {
    guest::main();
}

#[cfg(target_os = "wasi")]
mod guest {
    use super::terminal::{Action, Editor};
    use futures::FutureExt;
    use shell_engine::{
        Limits, Session,
        executor::{Cancel, Executor},
        io::{Endpoint, IoError},
        runtime::{Runtime, WasiAbi},
    };
    use std::{cell::RefCell, rc::Rc};
    #[link(wasm_import_module = "shell_terminal")]
    unsafe extern "C" {
        fn phase(value: i32);
        fn columns() -> i32;
    }
    fn set_phase(value: i32) {
        unsafe {
            phase(value);
        }
    }
    fn report(error: impl std::fmt::Display) -> ! {
        eprintln!("shell-runtime: {error}");
        std::process::exit(2);
    }
    pub fn main() {
        let args: Vec<_> = std::env::args().collect();
        let command = match args.as_slice() {
            [_] => None,
            [_, flag] if flag == "-i" => None,
            [_, flag, source] if flag == "-c" => Some(source.clone()),
            _ => report("usage: shell-runtime [-i | -c SCRIPT]"),
        };
        let abi = Rc::new(
            WasiAbi::new()
                .unwrap_or_else(|errno| report(format!("missing root preopen (errno {errno})"))),
        );
        abi.handle_interrupts()
            .unwrap_or_else(|errno| report(format!("signal setup errno {errno}")));
        let executor = Executor::new();
        let runtime = Runtime::new(abi, executor.clone());
        let session = Rc::new(Session::new(
            executor.clone(),
            Rc::new(runtime.clone()),
            Rc::new(runtime.clone()),
            Limits::default(),
        ));
        {
            let state = session.state();
            let mut state = state.borrow_mut();
            state.variables.extend(std::env::vars());
            state.exported = state.variables.keys().cloned().collect();
            if let Ok(cwd) = std::env::var("PWD") {
                state.cwd = cwd;
            }
        }
        let fds = runtime.stdio().unwrap_or_else(|error| report(error));
        let input = fds.get(0);
        let output = fds.get(1);
        let errors = fds.get(2);
        session
            .set_descriptors(fds)
            .unwrap_or_else(|error| report(error));
        let editor_cancel = Rc::new(RefCell::new(Cancel::new()));
        let shell = session.clone();
        let input_cancel = editor_cancel.clone();
        let root = executor.spawn(async move {
            let result = run(shell.clone(), input, output, errors, command, input_cancel).await;
            set_phase(0);
            shell.shutdown().await;
            result
        });
        loop {
            if runtime.take_interrupt() {
                session.interrupt();
                editor_cancel.borrow().cancel();
            }
            let turn = executor.drive(64);
            if root.is_finished() {
                break;
            }
            // A zero-time reactor scan between busy turns prevents a yielding
            // builtin from starving ready process/pipe events. Idle poll is the
            // ONLY blocking operation; interruption is also checked in budgets.
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .unwrap_or_else(|errno| report(format!("poll errno {errno}")));
        }
        let status = root.now_or_never().unwrap();
        // Session shutdown awaited every owned job. Finish host-owned cleanup
        // tasks created by dropped ProcessGroup guards before ending this guest.
        loop {
            let turn = executor.drive(64);
            if turn.pending == 0 {
                break;
            }
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .unwrap_or_else(|errno| report(format!("cleanup poll errno {errno}")));
        }
        std::process::exit(status);
    }
    async fn write(endpoint: &Endpoint, bytes: &[u8]) -> Result<(), IoError> {
        endpoint.write_all(bytes, &Cancel::new()).await
    }
    async fn diagnostic(endpoint: &Option<Endpoint>, bytes: &[u8]) {
        if let Some(endpoint) = endpoint {
            let _ = write(endpoint, bytes).await;
        }
    }
    async fn run(
        session: Rc<Session>,
        input: Option<Endpoint>,
        output: Option<Endpoint>,
        errors: Option<Endpoint>,
        command: Option<String>,
        input_cancel: Rc<RefCell<Cancel>>,
    ) -> i32 {
        if let Some(source) = command {
            set_phase(2);
            return match session.start(&source) {
                Ok(job) => job.await,
                Err(error) => {
                    diagnostic(&errors, format!("shell: {error}\n").as_bytes()).await;
                    error.status()
                }
            };
        }
        // A -c script needs only the descriptors it actually uses. The interactive
        // editor, unlike a script, cannot operate without both input and output.
        let (Some(input), Some(output)) = (input, output) else {
            return 1;
        };
        let mut editor = Editor::default();
        let mut skip_lf = false;
        loop {
            *input_cancel.borrow_mut() = Cancel::new();
            let prompt = session
                .state()
                .borrow()
                .variables
                .get("PS1")
                .cloned()
                .unwrap_or_else(|| "$ ".into());
            editor.begin(&prompt, unsafe { columns() }.max(2) as usize);
            if write(&output, prompt.as_bytes()).await.is_err() {
                return 1;
            }
            set_phase(1);
            let source = loop {
                let mut byte = [0];
                let cancel = input_cancel.borrow().clone();
                match input.read_cancelled(&mut byte, &cancel).await {
                    Ok(0) => {
                        let _ = write(&output, b"\r\n").await;
                        return session.state().borrow().status;
                    }
                    Err(IoError::Cancelled) => {
                        editor.clear();
                        *input_cancel.borrow_mut() = Cancel::new();
                        if write(&output, b"^C\r\n").await.is_err() {
                            return 1;
                        }
                        break None;
                    }
                    Err(_) => return 1,
                    Ok(_) => {}
                }
                if skip_lf && byte[0] == b'\n' {
                    skip_lf = false;
                    continue;
                }
                skip_lf = false;
                editor.resize(&prompt, unsafe { columns() }.max(2) as usize);
                match editor.feed(byte[0]) {
                    Action::Echo(byte) => {
                        if write(&output, &[byte]).await.is_err() {
                            return 1;
                        }
                        editor.echoed(byte);
                    }
                    Action::Submit(source) => {
                        skip_lf = byte[0] == b'\r';
                        if write(&output, b"\r\n").await.is_err() {
                            return 1;
                        }
                        break Some(source);
                    }
                    Action::Interrupt => {
                        let _ = write(&output, b"^C\r\n").await;
                        break None;
                    }
                    Action::Eof => {
                        let _ = write(&output, b"\r\n").await;
                        return session.state().borrow().status;
                    }
                    Action::Redraw => {
                        if write(&output, &editor.redraw(&prompt)).await.is_err() {
                            return 1;
                        }
                    }
                    Action::None => {}
                }
            };
            let Some(source) = source else { continue };
            let source = match String::from_utf8(source) {
                Ok(source) => source,
                Err(_) => {
                    diagnostic(&errors, b"shell: command is not UTF-8\n").await;
                    continue;
                }
            };
            if source.trim().is_empty() {
                continue;
            }
            set_phase(2);
            match session.start(&source) {
                Ok(job) => {
                    let code = job.await;
                    if session.exit_requested() {
                        return code;
                    }
                }
                Err(error) => {
                    diagnostic(&errors, format!("shell: {error}\n").as_bytes()).await;
                    session.state().borrow_mut().status = error.status();
                }
            }
        }
    }
}
