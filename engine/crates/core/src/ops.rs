//! The operation registry of `hoi4-engine serve` (ADR 0091).
//!
//! New in the parallel port; adapted from no TypeScript file. An operation answers one framed
//! request of the resident engine protocol (ADR 0077): a JSON header and an optional raw payload
//! in, a JSON result or error and an optional raw payload out. Each crate adds its operations in
//! its `register` function, and `serve` calls every crate's `register` once at start, so a packet
//! adds an operation without editing the dispatcher.

use std::collections::BTreeMap;

use serde_json::{Value, json};

/// The answer to one request: a JSON result or a JSON error, and a raw payload sent after a result.
#[derive(Debug)]
pub struct OpResponse {
    pub result: Result<Value, Value>,
    pub payload: Vec<u8>,
}

impl OpResponse {
    pub fn ok(result: Value) -> Self {
        Self { result: Ok(result), payload: Vec::new() }
    }

    pub fn ok_with_payload(result: Value, payload: Vec<u8>) -> Self {
        Self { result: Ok(result), payload }
    }

    /// An error with a stable `code` and a message for the caller.
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Self { result: Err(json!({ "code": code, "message": message.into() })), payload: Vec::new() }
    }
}

/// What an operation may know about the request beyond its body. Fields are added here, by the
/// integrator, as the core services move (workspace grants, cancellation, limits).
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct OpContext {}

/// One engine operation, named like `event.graph` (domain, dot, action).
pub trait Operation: Send + Sync {
    fn name(&self) -> &'static str;
    fn run(&self, context: &OpContext, request: &Value, payload: &[u8]) -> OpResponse;
}

type Handler = dyn Fn(&OpContext, &Value, &[u8]) -> OpResponse + Send + Sync;

struct FnOperation {
    name: &'static str,
    handler: Box<Handler>,
}

impl Operation for FnOperation {
    fn name(&self) -> &'static str {
        self.name
    }

    fn run(&self, context: &OpContext, request: &Value, payload: &[u8]) -> OpResponse {
        (self.handler)(context, request, payload)
    }
}

/// A name was registered twice: a programming error the server refuses to start with.
#[derive(Debug, PartialEq, Eq)]
pub struct DuplicateOperation(pub &'static str);

impl std::fmt::Display for DuplicateOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the engine operation {} is registered twice", self.0)
    }
}

impl std::error::Error for DuplicateOperation {}

/// The operations of one server process, by name.
#[derive(Default)]
pub struct Registry {
    operations: BTreeMap<&'static str, Box<dyn Operation>>,
    duplicates: Vec<&'static str>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an operation. A second operation of the same name is recorded and reported by
    /// [`Registry::check`]; the first one stays.
    pub fn add(&mut self, operation: Box<dyn Operation>) {
        let name = operation.name();
        if self.operations.contains_key(name) {
            self.duplicates.push(name);
        } else {
            self.operations.insert(name, operation);
        }
    }

    /// Adds an operation from a function.
    pub fn add_fn(&mut self, name: &'static str, handler: impl Fn(&OpContext, &Value, &[u8]) -> OpResponse + Send + Sync + 'static) {
        self.add(Box::new(FnOperation { name, handler: Box::new(handler) }));
    }

    /// Fails when any name was registered twice.
    pub fn check(&self) -> Result<(), DuplicateOperation> {
        match self.duplicates.first() {
            Some(name) => Err(DuplicateOperation(name)),
            None => Ok(()),
        }
    }

    /// The registered names in sorted order.
    pub fn names(&self) -> Vec<&'static str> {
        self.operations.keys().copied().collect()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.operations.contains_key(name)
    }

    /// Runs the named operation, or `None` when no operation has that name.
    pub fn dispatch(&self, name: &str, context: &OpContext, request: &Value, payload: &[u8]) -> Option<OpResponse> {
        self.operations.get(name).map(|operation| operation.run(context, request, payload))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_by_name_and_lists_sorted_names() {
        let mut registry = Registry::new();
        registry.add_fn("b.echo", |_, request, payload| OpResponse::ok_with_payload(request.clone(), payload.to_vec()));
        registry.add_fn("a.fail", |_, _, _| OpResponse::error("invalid_request", "no"));
        assert_eq!(registry.names(), vec!["a.fail", "b.echo"]);
        let answer = registry.dispatch("b.echo", &OpContext::default(), &json!({ "x": 1 }), b"raw").unwrap();
        assert_eq!(answer.result.unwrap(), json!({ "x": 1 }));
        assert_eq!(answer.payload, b"raw");
        let error = registry.dispatch("a.fail", &OpContext::default(), &json!({}), &[]).unwrap();
        assert_eq!(error.result.unwrap_err()["code"], "invalid_request");
        assert!(registry.dispatch("c.missing", &OpContext::default(), &json!({}), &[]).is_none());
        assert_eq!(registry.check(), Ok(()));
    }

    #[test]
    fn refuses_a_name_registered_twice_and_keeps_the_first() {
        let mut registry = Registry::new();
        registry.add_fn("x.op", |_, _, _| OpResponse::ok(json!(1)));
        registry.add_fn("x.op", |_, _, _| OpResponse::ok(json!(2)));
        assert_eq!(registry.check(), Err(DuplicateOperation("x.op")));
        let answer = registry.dispatch("x.op", &OpContext::default(), &json!({}), &[]).unwrap();
        assert_eq!(answer.result.unwrap(), json!(1));
    }
}
