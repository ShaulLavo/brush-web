//! Native/WASI embedding smoke and size harness, NOT the browser process adapter.
//! Host stdio is touched only between nonblocking executor turns; a bounded
//! terminal endpoint applies backpressure to tasks. No stage calls WASI fd_read.
mod compat;
use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::Executor,
    io::{Endpoint, FdTable, MemoryFs, pipe},
    process::InProcessHost,
};
use std::{io::Write, rc::Rc};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "-c" {
        eprintln!("usage: shell-engine -c 'builtins-only script' (process host not installed)");
        std::process::exit(2);
    }
    let executor = Executor::new();
    let host = InProcessHost::new(executor.clone());
    compat::register(&host);
    let session = Session::new(
        executor.clone(),
        Rc::new(host),
        Rc::new(MemoryFs::new(16 * 1024 * 1024)),
        Limits::default(),
    );
    {
        let state = session.state();
        let mut state = state.borrow_mut();
        state.variables = std::env::vars().collect();
        state.exported = state.variables.keys().cloned().collect();
        if let Ok(cwd) = std::env::var("PWD") {
            state.cwd = cwd;
        }
    }
    let (terminal, writer) = pipe();
    let (diagnostics, error_writer) = pipe();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, writer);
    fds.insert(2, error_writer);
    let job = match {
        session.set_descriptors(fds).unwrap();
        session.start(&args[2])
    } {
        Ok(job) => job,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let mut output = std::io::stdout().lock();
    let mut errors = std::io::stderr().lock();
    let code = loop {
        executor.drive(256);
        drain(&terminal, &mut output, &session);
        drain(&diagnostics, &mut errors, &session);
        if job.is_finished() {
            break job.now_or_never().unwrap();
        }
        if !executor.drive(0).runnable {
            // This stand-alone embedding has no external readiness provider.
            // Browser integration supplies one rather than adding a polling loop.
            session.interrupt();
        }
    };
    let shutdown = session.shutdown();
    futures::pin_mut!(shutdown);
    while shutdown.as_mut().now_or_never().is_none() {
        executor.drive(256);
    }
    executor.drive(256);
    std::process::exit(code);
}

fn drain(endpoint: &Endpoint, output: &mut impl Write, session: &Session) {
    let mut buffer = [0; 8192];
    loop {
        let Some(result) = endpoint.read(&mut buffer).now_or_never() else {
            return;
        };
        let count = match result {
            Ok(0) => return,
            Ok(count) => count,
            Err(_) => {
                session.interrupt();
                return;
            }
        };
        if output
            .write_all(&buffer[..count])
            .and_then(|_| output.flush())
            .is_err()
        {
            session.interrupt();
            return;
        }
    }
}
