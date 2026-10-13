use std::io;
use std::time::Duration;

#[link(wasm_import_module = "browser")]
unsafe extern "C" {
    fn read(ptr: *mut u8, len: usize) -> i32;
    fn wait(timeout_ms: u32) -> i32;
    fn columns() -> u32;
    fn rows() -> u32;
    fn raw_mode(enabled: u32);
    fn sleep(ms: u32) -> i32;
    fn event(kind: u32, value: u32);
}

pub struct BrowserTerminal;

impl brush_interactive::vt::Terminal for BrowserTerminal {
    fn enable_raw_mode(&mut self) -> io::Result<()> {
        set_raw(true);
        Ok(())
    }

    fn disable_raw_mode(&mut self) -> io::Result<()> {
        set_raw(false);
        Ok(())
    }

    fn columns(&self) -> Option<usize> {
        Some(size().0)
    }

    fn is_terminal(&self) -> bool {
        true
    }

    fn interrupted_read_is_ctrl_c(&self) -> bool {
        true
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        read_bytes(buf)
    }

    fn wait_for_input(&mut self, timeout: Duration) -> io::Result<bool> {
        let result = unsafe { wait(timeout.as_millis().min(u128::from(u32::MAX)) as u32) };
        Ok(result != 0)
    }
}

pub fn set_raw(enabled: bool) {
    unsafe { raw_mode(u32::from(enabled)) };
}

pub fn read_bytes(buf: &mut [u8]) -> io::Result<usize> {
    let result = unsafe { read(buf.as_mut_ptr(), buf.len()) };
    match result {
        -1 => Err(io::Error::from(io::ErrorKind::Interrupted)),
        -2 => Ok(0),
        n if n >= 0 => Ok(n as usize),
        _ => Err(io::Error::other("browser input bridge failed")),
    }
}

pub fn size() -> (usize, usize) {
    unsafe { (columns().max(1) as usize, rows().max(1) as usize) }
}

pub fn sleep_ms(ms: u32) -> Result<(), brush_core::Error> {
    if unsafe { sleep(ms) } != 0 {
        return Err(brush_core::ErrorKind::Interrupted.into());
    }
    Ok(())
}

pub fn announce_exit(status: u8) {
    unsafe { event(3, u32::from(status)) };
}

pub struct RawGuard;

impl RawGuard {
    pub fn new() -> Self {
        set_raw(true);
        Self
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        set_raw(false);
    }
}
