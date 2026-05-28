//! rt-carousel-agent — library surface for the binary and examples.
//!
//! `main.rs` is a thin entry point; everything else lives in modules exposed
//! here so integration tests and `cargo run --example …` can reuse them.

pub mod claude_api;
pub mod config;
pub mod generator;
pub mod pipeline;
pub mod pocket;
pub mod render;
pub mod slack;
pub mod socket_mode;
pub mod sources;
pub mod types;
