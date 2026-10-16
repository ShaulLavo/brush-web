//! Native/WASI embedding smoke and size harness, NOT the browser process adapter.
//! Host stdio is touched only between nonblocking executor turns; a bounded
//! terminal endpoint applies backpressure to tasks. No stage calls WASI fd_read.
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
    let session = Session::new(
        executor.clone(),
        Rc::new(host),
        Rc::new(MemoryFs::new(16 * 1024 * 1024)),
        Limits::default(),
    );
    let (terminal, writer) = pipe();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, writer.clone());
    fds.insert(2, writer);
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
    let mut buffer = [0; 8192];
    let code = loop {
        executor.drive(256);
        loop {
            match terminal.read(&mut buffer).now_or_never() {
                Some(Ok(0)) | None => break,
                Some(Ok(n)) => {
                    if output
                        .write_all(&buffer[..n])
                        .and_then(|_| output.flush())
                        .is_err()
                    {
                        session.interrupt();
                    }
                }
                Some(Err(_)) => {
                    session.interrupt();
                    break;
                }
            }
        }
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
