//! WASI-first shell engine. It deliberately has no browser imports: the embedding
//! supplies readiness, terminal queues, filesystem endpoints and process hosting.
mod arithmetic;
mod ast_copy;
mod builtins;
pub mod executor;
mod expand;
pub mod interpreter;
pub mod io;
pub mod process;
pub mod runtime;
pub mod state;
pub use interpreter::{Limits, Session};
