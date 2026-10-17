//! Reference-counted open descriptions and exact-byte, bounded asynchronous I/O.
use crate::executor::{Cancel, Event, yield_now};
use futures::future::LocalBoxFuture;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};

/// Runtime-backed open descriptions implement notification-driven operations.
/// Neither operation may block the executor; dropped futures must unregister
/// readiness waits. The host endpoint's last Rc drop closes its runtime handle.
pub trait HostEndpoint {
    fn read<'a>(&'a self, output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>>;
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>>;
}
/// Live runtime filesystems may await service readiness but must never block an
/// executor task. Callers race opens with their job's cancellation token.
pub trait FileSystem {
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>>;
}

pub const PIPE_CAPACITY: usize = 32 * 1024;
pub const MAX_MEMORY_FILES: usize = 1024;
pub const MAX_PATH_BYTES: usize = 4096;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoError {
    BadDescriptor,
    BrokenPipe,
    Cancelled,
    LimitExceeded,
    NotFound,
    InvalidPath,
    WriteZero,
}
impl IoError {
    pub fn status(&self) -> i32 {
        match self {
            Self::BrokenPipe => 141,
            Self::Cancelled => 130,
            _ => 1,
        }
    }
}
impl std::fmt::Display for IoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::BadDescriptor => "bad descriptor",
            Self::BrokenPipe => "broken pipe",
            Self::Cancelled => "cancelled",
            Self::LimitExceeded => "I/O memory limit exceeded",
            Self::NotFound => "file not found",
            Self::InvalidPath => "invalid path",
            Self::WriteZero => "write made no progress",
        })
    }
}
impl std::error::Error for IoError {}
struct PipeState {
    bytes: VecDeque<u8>,
    readers: usize,
    writers: usize,
}
struct Pipe {
    state: RefCell<PipeState>,
    readable: Event,
    writable: Event,
}
struct File {
    data: RefCell<Vec<u8>>,
}
struct FsState {
    files: BTreeMap<String, Rc<File>>,
    used: usize,
    limit: usize,
}
struct FileOpen {
    file: Rc<File>,
    fs: Rc<RefCell<FsState>>,
    offset: Cell<usize>,
    options: OpenOptions,
}
enum Open {
    PipeRead(Rc<Pipe>),
    PipeWrite(Rc<Pipe>),
    File(FileOpen),
    Capture(Rc<CaptureState>),
    /// Read-only bytes (here-documents and here-strings), shared offset.
    Bytes {
        data: Vec<u8>,
        offset: Cell<usize>,
    },
    Host(Rc<dyn HostEndpoint>),
    Null,
}
impl Drop for Open {
    fn drop(&mut self) {
        match self {
            Self::PipeRead(pipe) => {
                pipe.state.borrow_mut().readers -= 1;
                pipe.writable.notify();
            }
            Self::PipeWrite(pipe) => {
                pipe.state.borrow_mut().writers -= 1;
                pipe.readable.notify();
            }
            _ => {}
        }
    }
}
/// Clones are dup-style references to the SAME open description, including file
/// offsets. A separate filesystem open creates an independent offset.
#[derive(Clone)]
pub struct Endpoint(Rc<Open>);
pub fn pipe() -> (Endpoint, Endpoint) {
    let pipe = Rc::new(Pipe {
        state: RefCell::new(PipeState {
            bytes: VecDeque::with_capacity(PIPE_CAPACITY),
            readers: 1,
            writers: 1,
        }),
        readable: Event::default(),
        writable: Event::default(),
    });
    (
        Endpoint(Rc::new(Open::PipeRead(pipe.clone()))),
        Endpoint(Rc::new(Open::PipeWrite(pipe))),
    )
}
impl Endpoint {
    pub fn null() -> Self {
        Self(Rc::new(Open::Null))
    }
    pub fn host(endpoint: Rc<dyn HostEndpoint>) -> Self {
        Self(Rc::new(Open::Host(endpoint)))
    }
    /// A read-only endpoint over owned bytes, like bash's here-document
    /// files. Duplicates share the read offset.
    pub fn bytes(data: Vec<u8>) -> Self {
        Self(Rc::new(Open::Bytes {
            data,
            offset: Cell::new(0),
        }))
    }
    pub async fn read(&self, output: &mut [u8]) -> Result<usize, IoError> {
        if output.is_empty() {
            return Ok(0);
        }
        match self.0.as_ref() {
            Open::PipeRead(pipe) => loop {
                let ready = pipe.readable.listen();
                let result = {
                    let mut state = pipe.state.borrow_mut();
                    let count = output.len().min(state.bytes.len());
                    if count != 0 {
                        for byte in &mut output[..count] {
                            *byte = state.bytes.pop_front().unwrap();
                        }
                        Some(count)
                    } else if state.writers == 0 {
                        Some(0)
                    } else {
                        None
                    }
                };
                if let Some(count) = result {
                    if count != 0 {
                        pipe.writable.notify();
                    }
                    return Ok(count);
                }
                ready.await;
            },
            Open::File(file) if file.options.read => {
                let data = file.file.data.borrow();
                let offset = file.offset.get();
                let count = output
                    .len()
                    .min(PIPE_CAPACITY)
                    .min(data.len().saturating_sub(offset));
                if count != 0 {
                    output[..count].copy_from_slice(&data[offset..offset + count]);
                    file.offset.set(offset + count);
                }
                Ok(count)
            }
            Open::Host(endpoint) => endpoint.read(output).await,
            Open::Bytes { data, offset } => {
                let start = offset.get();
                let count = output
                    .len()
                    .min(PIPE_CAPACITY)
                    .min(data.len().saturating_sub(start));
                output[..count].copy_from_slice(&data[start..start + count]);
                offset.set(start + count);
                Ok(count)
            }
            Open::Null => Ok(0),
            _ => Err(IoError::BadDescriptor),
        }
    }
    pub async fn write(&self, input: &[u8]) -> Result<usize, IoError> {
        if input.is_empty() {
            return Ok(0);
        }
        match self.0.as_ref() {
            Open::PipeWrite(pipe) => loop {
                let ready = pipe.writable.listen();
                let result = {
                    let mut state = pipe.state.borrow_mut();
                    if state.readers == 0 {
                        return Err(IoError::BrokenPipe);
                    }
                    let count = input.len().min(PIPE_CAPACITY - state.bytes.len());
                    if count != 0 {
                        state.bytes.extend(&input[..count]);
                        Some(count)
                    } else {
                        None
                    }
                };
                if let Some(count) = result {
                    pipe.readable.notify();
                    return Ok(count);
                }
                ready.await;
            },
            Open::File(file) if file.options.write => {
                let input = &input[..input.len().min(PIPE_CAPACITY)];
                let mut fs = file.fs.borrow_mut();
                let mut data = file.file.data.borrow_mut();
                let offset = if file.options.append {
                    data.len()
                } else {
                    file.offset.get()
                };
                let end = offset
                    .checked_add(input.len())
                    .ok_or(IoError::LimitExceeded)?;
                let growth = end.saturating_sub(data.len());
                if growth > fs.limit - fs.used {
                    return Err(IoError::LimitExceeded);
                }
                if growth > 0 {
                    data.try_reserve_exact(growth)
                        .map_err(|_| IoError::LimitExceeded)?;
                    data.resize(end, 0);
                    fs.used += growth;
                }
                data[offset..end].copy_from_slice(input);
                file.offset.set(end);
                Ok(input.len())
            }
            Open::Capture(capture) => {
                let mut data = capture.bytes.borrow_mut();
                if input.len() > capture.limit - data.len() {
                    return Err(IoError::LimitExceeded);
                }
                let input = &input[..input.len().min(PIPE_CAPACITY)];
                data.try_reserve_exact(input.len())
                    .map_err(|_| IoError::LimitExceeded)?;
                data.extend_from_slice(input);
                Ok(input.len())
            }
            Open::Host(endpoint) => endpoint.write(input).await,
            Open::Null => Ok(input.len()),
            _ => Err(IoError::BadDescriptor),
        }
    }
    pub async fn read_cancelled(
        &self,
        output: &mut [u8],
        cancel: &Cancel,
    ) -> Result<usize, IoError> {
        cancel
            .run(self.read(output))
            .await
            .map_err(|_| IoError::Cancelled)?
    }
    pub async fn write_cancelled(&self, input: &[u8], cancel: &Cancel) -> Result<usize, IoError> {
        cancel
            .run(self.write(input))
            .await
            .map_err(|_| IoError::Cancelled)?
    }
    /// Bounded chunks and explicit yields prevent always-ready sinks from starving
    /// sibling stages. Cancellation never rolls back already-written bytes.
    pub async fn write_all(&self, mut input: &[u8], cancel: &Cancel) -> Result<(), IoError> {
        while !input.is_empty() {
            let chunk = &input[..input.len().min(PIPE_CAPACITY)];
            let count = self.write_cancelled(chunk, cancel).await?;
            if count == 0 || count > chunk.len() {
                return Err(IoError::WriteZero);
            }
            input = &input[count..];
            yield_now().await;
        }
        if cancel.is_cancelled() {
            Err(IoError::Cancelled)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Default)]
pub struct FdTable(BTreeMap<u32, Endpoint>);
impl FdTable {
    pub fn get(&self, fd: u32) -> Option<Endpoint> {
        self.0.get(&fd).cloned()
    }
    pub fn insert(&mut self, fd: u32, endpoint: Endpoint) -> Option<Endpoint> {
        self.0.insert(fd, endpoint)
    }
    pub fn remove(&mut self, fd: u32) -> Option<Endpoint> {
        self.0.remove(&fd)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&u32, &Endpoint)> {
        self.0.iter()
    }
}
struct CaptureState {
    bytes: RefCell<Vec<u8>>,
    limit: usize,
}
#[derive(Clone)]
pub struct Capture(Rc<CaptureState>);
impl Capture {
    pub fn bytes(&self) -> Vec<u8> {
        self.0.bytes.borrow().clone()
    }
    pub fn len(&self) -> usize {
        self.0.bytes.borrow().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
pub fn capture(limit: usize) -> (Endpoint, Capture) {
    let state = Rc::new(CaptureState {
        bytes: RefCell::new(Vec::new()),
        limit,
    });
    (
        Endpoint(Rc::new(Open::Capture(state.clone()))),
        Capture(state),
    )
}
#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    pub truncate: bool,
    pub append: bool,
}
impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            read: true,
            write: false,
            create: false,
            truncate: false,
            append: false,
        }
    }
}
/// A shared, byte-limited filesystem for simple redirects. File payload bytes are
/// limited by `total_limit`; metadata is additionally capped at MAX_MEMORY_FILES
/// names of MAX_PATH_BYTES each. Paths must already be resolved against the shell's
/// cwd; directory policy belongs to the interpreter.
#[derive(Clone)]
pub struct MemoryFs(Rc<RefCell<FsState>>);
impl MemoryFs {
    pub fn new(total_limit: usize) -> Self {
        Self(Rc::new(RefCell::new(FsState {
            files: BTreeMap::new(),
            used: 0,
            limit: total_limit,
        })))
    }
    pub fn used_bytes(&self) -> usize {
        self.0.borrow().used
    }
    pub fn open(&self, path: &str, options: &OpenOptions) -> Result<Endpoint, IoError> {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        if (!options.read && !options.write)
            || ((options.truncate || options.append) && !options.write)
        {
            return Err(IoError::BadDescriptor);
        }
        let mut fs = self.0.borrow_mut();
        let file = match fs.files.get(path) {
            Some(file) => file.clone(),
            None if options.create => {
                if fs.files.len() >= MAX_MEMORY_FILES {
                    return Err(IoError::LimitExceeded);
                }
                let file = Rc::new(File {
                    data: RefCell::new(Vec::new()),
                });
                fs.files.insert(path.to_owned(), file.clone());
                file
            }
            None => return Err(IoError::NotFound),
        };
        if options.truncate {
            let mut data = file.data.borrow_mut();
            fs.used -= data.len();
            *data = Vec::new();
        }
        Ok(Endpoint(Rc::new(Open::File(FileOpen {
            file,
            fs: self.0.clone(),
            offset: Cell::new(0),
            options: *options,
        }))))
    }
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>, IoError> {
        let fs = self.0.borrow();
        let file = fs.files.get(path).ok_or(IoError::NotFound)?;
        let bytes = file.data.borrow().clone();
        Ok(bytes)
    }
    pub fn write_file(&self, path: &str, input: &[u8]) -> Result<(), IoError> {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        let mut fs = self.0.borrow_mut();
        let old = fs
            .files
            .get(path)
            .map(|file| file.data.borrow().len())
            .unwrap_or(0);
        if !fs.files.contains_key(path) && fs.files.len() >= MAX_MEMORY_FILES {
            return Err(IoError::LimitExceeded);
        }
        if input.len() > fs.limit - (fs.used - old) {
            return Err(IoError::LimitExceeded);
        }
        let mut data = Vec::new();
        data.try_reserve_exact(input.len())
            .map_err(|_| IoError::LimitExceeded)?;
        data.extend_from_slice(input);
        let file = fs
            .files
            .entry(path.to_owned())
            .or_insert_with(|| {
                Rc::new(File {
                    data: RefCell::new(Vec::new()),
                })
            })
            .clone();
        *file.data.borrow_mut() = data;
        fs.used = fs.used - old + input.len();
        Ok(())
    }
}

impl FileSystem for MemoryFs {
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        Box::pin(async move { MemoryFs::open(self, path, options) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::Executor;
    use futures::{FutureExt, task::noop_waker};
    use std::{
        future::Future,
        task::{Context, Poll},
    };
    #[test]
    fn exact_capacity_partial_io_and_last_close() {
        let (read, write) = pipe();
        let duplicate = write.clone();
        assert_eq!(
            write.write(&vec![7; PIPE_CAPACITY + 9]).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        assert!(write.write(&[1]).now_or_never().is_none());
        let mut buf = [0; 3];
        assert_eq!(read.read(&mut buf).now_or_never(), Some(Ok(3)));
        assert_eq!(buf, [7; 3]);
        assert_eq!(write.write(&[1; 8]).now_or_never(), Some(Ok(3)));
        drop(write);
        let mut all = vec![0; PIPE_CAPACITY];
        assert_eq!(read.read(&mut all).now_or_never(), Some(Ok(PIPE_CAPACITY)));
        assert!(read.read(&mut buf).now_or_never().is_none());
        drop(duplicate);
        assert_eq!(read.read(&mut buf).now_or_never(), Some(Ok(0)));
    }
    #[test]
    fn empty_io_and_epipe_last_reader() {
        let (read, write) = pipe();
        let dup = read.clone();
        drop(read);
        assert_eq!(write.write(b"x").now_or_never(), Some(Ok(1)));
        drop(dup);
        assert_eq!(write.write(b"").now_or_never(), Some(Ok(0)));
        assert_eq!(
            write.write(b"x").now_or_never(),
            Some(Err(IoError::BrokenPipe))
        );
    }
    #[test]
    fn cancelled_io_removes_all_waiters_and_wakes_peers() {
        let (read, write) = pipe();
        let cancel = Cancel::new();
        let mut output = [0; 1];
        let mut operation = Box::pin(read.read_cancelled(&mut output, &cancel));
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..100 {
            assert!(operation.as_mut().poll(&mut cx).is_pending());
        }
        let Open::PipeRead(state) = read.0.as_ref() else {
            unreachable!()
        };
        assert_eq!(state.readable.waiter_count(), 1);
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(IoError::Cancelled))
        );
        drop(operation);
        assert_eq!(state.readable.waiter_count(), 0);
        assert_eq!(
            write.write(&vec![0; PIPE_CAPACITY]).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        let cancel = Cancel::new();
        let mut operation = Box::pin(write.write_cancelled(b"x", &cancel));
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        assert_eq!(state.writable.waiter_count(), 1);
        drop(operation);
        assert_eq!(state.writable.waiter_count(), 0);
        let ex = Executor::new();
        let writer = ex.spawn(async move { write.write(b"x").await });
        ex.drive(10);
        assert!(!writer.is_finished());
        drop(read);
        ex.drive(10);
        assert_eq!(writer.now_or_never(), Some(Err(IoError::BrokenPipe)));
    }
    #[test]
    fn capture_limit_and_file_open_description_offsets() {
        let (sink, capture) = capture(3);
        assert_eq!(sink.write(b"abc").now_or_never(), Some(Ok(3)));
        assert_eq!(
            sink.write(b"d").now_or_never(),
            Some(Err(IoError::LimitExceeded))
        );
        assert_eq!(capture.bytes(), b"abc");
        let fs = MemoryFs::new(6);
        fs.write_file("/f", b"abcdef").unwrap();
        let file = fs.open("/f", &OpenOptions::default()).unwrap();
        let duplicate = file.clone();
        let other = fs.open("/f", &OpenOptions::default()).unwrap();
        let mut a = [0; 2];
        let mut b = [0; 2];
        let mut c = [0; 2];
        assert_eq!(file.read(&mut a).now_or_never(), Some(Ok(2)));
        assert_eq!(duplicate.read(&mut b).now_or_never(), Some(Ok(2)));
        assert_eq!(other.read(&mut c).now_or_never(), Some(Ok(2)));
        assert_eq!((a, b, c), (*b"ab", *b"cd", *b"ab"));
        assert_eq!(fs.write_file("/g", b"x"), Err(IoError::LimitExceeded));
        let truncate = OpenOptions {
            write: true,
            truncate: true,
            ..OpenOptions::default()
        };
        fs.open("/f", &truncate).unwrap();
        assert_eq!(fs.used_bytes(), 0);
        fs.write_file("/g", b"123456").unwrap();
        assert_eq!(fs.used_bytes(), 6);
    }
    #[test]
    fn runtime_endpoint_is_cancellable_and_closes_on_last_reference() {
        struct RuntimeRead {
            endpoint: Endpoint,
            closed: Rc<Cell<bool>>,
        }
        impl HostEndpoint for RuntimeRead {
            fn read<'a>(
                &'a self,
                output: &'a mut [u8],
            ) -> LocalBoxFuture<'a, Result<usize, IoError>> {
                Box::pin(self.endpoint.read(output))
            }
            fn write<'a>(&'a self, _: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
                Box::pin(async { Ok(0) })
            }
        }
        impl Drop for RuntimeRead {
            fn drop(&mut self) {
                self.closed.set(true);
            }
        }
        let (read, write) = pipe();
        let closed = Rc::new(Cell::new(false));
        let endpoint = Endpoint::host(Rc::new(RuntimeRead {
            endpoint: read,
            closed: closed.clone(),
        }));
        let duplicate = endpoint.clone();
        let cancel = Cancel::new();
        let mut output = [0; 1];
        let mut operation = Box::pin(endpoint.read_cancelled(&mut output, &cancel));
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(IoError::Cancelled))
        );
        drop(operation);
        assert_eq!(endpoint.read(&mut []).now_or_never(), Some(Ok(0)));
        assert_eq!(endpoint.write(b"").now_or_never(), Some(Ok(0)));
        assert_eq!(
            endpoint.write_all(b"x", &Cancel::new()).now_or_never(),
            Some(Err(IoError::WriteZero))
        );
        drop(endpoint);
        assert!(!closed.get());
        drop(duplicate);
        assert!(closed.get());
        assert_eq!(
            write.write(b"x").now_or_never(),
            Some(Err(IoError::BrokenPipe))
        );
    }
    #[test]
    fn file_append_truncation_and_allocation_bounds() {
        let fs = MemoryFs::new(8);
        fs.write_file("/f", b"abcd").unwrap();
        let original = fs
            .open(
                "/f",
                &OpenOptions {
                    write: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        let mut bytes = [0; 4];
        assert_eq!(original.read(&mut bytes).now_or_never(), Some(Ok(4)));
        let append = fs
            .open(
                "/f",
                &OpenOptions {
                    write: true,
                    append: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        assert_eq!(append.write(b"ef").now_or_never(), Some(Ok(2)));
        fs.open(
            "/f",
            &OpenOptions {
                write: true,
                truncate: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        assert_eq!(original.read(&mut bytes).now_or_never(), Some(Ok(0))); // EOF must not move offset backwards
        assert_eq!(original.write(b"z").now_or_never(), Some(Ok(1)));
        assert_eq!(fs.read_file("/f").unwrap(), b"\0\0\0\0z");
        assert_eq!(append.write(b"xy").now_or_never(), Some(Ok(2)));
        assert_eq!(fs.read_file("/f").unwrap(), b"\0\0\0\0zxy");
        assert_eq!(
            append.write(b"too much").now_or_never(),
            Some(Err(IoError::LimitExceeded))
        );
        assert_eq!(fs.used_bytes(), 7);
        assert_eq!(
            fs.write_file(&"x".repeat(MAX_PATH_BYTES + 1), b""),
            Err(IoError::InvalidPath)
        );
        for index in 1..MAX_MEMORY_FILES {
            fs.write_file(&format!("/{index}"), b"").unwrap();
        }
        assert_eq!(fs.write_file("/overflow", b""), Err(IoError::LimitExceeded));
    }
    #[test]
    fn arbitrary_fds_share_open_endpoints() {
        let (read, write) = pipe();
        let mut fds = FdTable::default();
        fds.insert(99, write);
        let mut child = fds.clone();
        drop(fds);
        let inherited = child.remove(99).unwrap();
        assert_eq!(inherited.write(b"bytes").now_or_never(), Some(Ok(5)));
        drop(inherited);
        let mut bytes = [0; 6];
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(5)));
        assert_eq!(&bytes[..5], b"bytes");
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(0)));
    }
}
