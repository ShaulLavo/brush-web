//! Original fixture commands matching the compatibility harness's Python helpers.
//! Output goes through bounded descriptors, including for a long argument list.
use futures::FutureExt;
use shell_engine::{
    executor::{Budget, Cancel},
    io::Endpoint,
    process::{InProcessHost, SpawnRequest},
};

pub fn register(host: &InProcessHost) {
    host.register("argv.py", |request, cancel| {
        argv(request, cancel).boxed_local()
    });
    host.register("printenv.py", |request, cancel| {
        printenv(request, cancel).boxed_local()
    });
}

async fn argv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    if output.write_all(b"[", &cancel).await.is_err() {
        return 1;
    }
    for (index, arg) in request.argv.iter().skip(1).enumerate() {
        if index > 0 && output.write_all(b", ", &cancel).await.is_err() {
            return 1;
        }
        if repr(&output, arg.as_bytes(), &cancel).await.is_err() {
            return 1;
        }
    }
    if output.write_all(b"]\n", &cancel).await.is_err() {
        return 1;
    }
    0
}

async fn printenv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    let mut budget = Budget::default();
    for name in request.argv.iter().skip(1) {
        if budget.checkpoint(&cancel).await.is_err() {
            return 130;
        }
        let value = request.env.get(name).map(String::as_str).unwrap_or("None");
        if output.write_all(value.as_bytes(), &cancel).await.is_err()
            || output.write_all(b"\n", &cancel).await.is_err()
        {
            return 1;
        }
    }
    0
}

async fn repr(output: &Endpoint, bytes: &[u8], cancel: &Cancel) -> Result<(), ()> {
    let quote = if bytes.contains(&b'\'') && !bytes.contains(&b'"') {
        b'"'
    } else {
        b'\''
    };
    let mut buffer = vec![quote];
    let mut budget = Budget::default();
    for byte in bytes {
        budget.checkpoint(cancel).await.map_err(|_| ())?;
        escape(*byte, quote, &mut buffer);
        if buffer.len() >= 8192 {
            output.write_all(&buffer, cancel).await.map_err(|_| ())?;
            buffer.clear();
        }
    }
    buffer.push(quote);
    output.write_all(&buffer, cancel).await.map_err(|_| ())
}

fn escape(byte: u8, quote: u8, buffer: &mut Vec<u8>) {
    match byte {
        b'\\' => buffer.extend_from_slice(b"\\\\"),
        b'\n' => buffer.extend_from_slice(b"\\n"),
        b'\r' => buffer.extend_from_slice(b"\\r"),
        b'\t' => buffer.extend_from_slice(b"\\t"),
        b'\'' if quote == b'\'' => buffer.extend_from_slice(b"\\'"),
        0x20..=0x7e => buffer.push(byte),
        _ => {
            let hex = b"0123456789abcdef";
            buffer.extend_from_slice(&[
                b'\\',
                b'x',
                hex[(byte >> 4) as usize],
                hex[(byte & 15) as usize],
            ]);
        }
    }
}
