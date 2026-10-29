//! Domain types, fee math and the recovery strategy engine.
//!
//! This crate is pure (no I/O) so every rule can be unit-tested without a node.

pub mod fees;
pub mod snapshot;
pub mod strategy;
pub mod types;

pub use snapshot::*;
pub use strategy::{recommend, StrategyInput, DEFAULT_CHILD_VSIZE};
pub use types::*;
