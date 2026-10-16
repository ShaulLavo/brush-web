//! Original clock adapter: WASI preview 1 and native Rust both provide a
//! monotonic `std::time::Instant`. No browser JS clock or async runtime is needed.

pub(crate) use std::time::Instant;
