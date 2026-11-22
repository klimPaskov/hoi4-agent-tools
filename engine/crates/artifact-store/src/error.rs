//! The error every operation of this crate reports: a stable upper-case code from the TypeScript
//! vocabulary, a message and optional details, so a caller sees what `ServiceError` showed it.
//!
//! New in the port; mirrors `ServiceError` of `src/hoi4_agent_tools/core/result.ts`.

use hoi4_core::ops::OpResponse;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

pub type StoreResult<T> = Result<T, StoreError>;

impl StoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    pub fn with_details(code: &'static str, message: impl Into<String>, details: Value) -> Self {
        Self { code, message: message.into(), details: Some(details) }
    }

    pub fn into_response(self) -> OpResponse {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(details) = self.details {
            error["details"] = details;
        }
        OpResponse { result: Err(error), payload: Vec::new() }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StoreError {}

/// An unexpected I/O failure keeps its text out of the message (no paths reach agents).
pub fn io_error(code: &'static str, message: &str) -> impl FnOnce(std::io::Error) -> StoreError + '_ {
    move |_| StoreError::new(code, message)
}
