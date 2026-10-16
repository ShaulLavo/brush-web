fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("wasi") {
        // This bridge symbol belongs to Brush, not every WASI workspace binary.
        println!("cargo:rustc-link-arg=--export=browser_scalar_width");
    }
}
