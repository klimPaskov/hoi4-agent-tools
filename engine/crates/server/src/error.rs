//! A refusal with a stable upper-case code, as `ServiceError` in `src/hoi4_agent_tools/core/result.ts`.
//!
//! Adapted from `src/hoi4_agent_tools/core/result.ts` (`ServiceError`), commit 9b7dc80d.

use std::fmt;

/// A refusal the server reports with a stable code and a message for the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}
