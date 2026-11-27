//! JSON-RPC 2.0 messages and the MCP service both transports call.
//!
//! Adapted from the message checks of `@modelcontextprotocol/sdk` (`JSONRPCMessageSchema`,
//! `isInitializeRequest`) as used by `src/hoi4_agent_tools/mcp/transports/bounded-stdio.ts` and
//! `http.ts`, and from the server identity of `src/hoi4_agent_tools/mcp/server/create.ts`,
//! commit 9b7dc80d. Tool wiring comes with step 8 of ADR 0089; until then [`CoreService`]
//! answers the protocol methods and lists the tools it is given.

use serde_json::{Map, Value, json};

use crate::protocol::negotiate;

pub const PARSE_ERROR: i64 = -32_700;
pub const INVALID_REQUEST: i64 = -32_600;
pub const METHOD_NOT_FOUND: i64 = -32_601;
pub const INVALID_PARAMS: i64 = -32_602;

/// What one message is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    Request,
    Notification,
    Response,
}

fn valid_id(id: &Value) -> bool {
    id.is_string() || id.is_i64() || id.is_u64()
}

/// Classifies a JSON-RPC 2.0 message; `None` for anything else, a batch included.
pub fn classify(message: &Value) -> Option<MessageKind> {
    let object = message.as_object()?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    if let Some(method) = object.get("method") {
        if !method.is_string() || object.get("params").is_some_and(|params| !params.is_object()) {
            return None;
        }
        return match object.get("id") {
            None => Some(MessageKind::Notification),
            Some(id) if valid_id(id) => Some(MessageKind::Request),
            Some(_) => None,
        };
    }
    let id_ok = object.get("id").is_some_and(valid_id);
    let result = object.contains_key("result");
    let error =
        object.get("error").is_some_and(|error| error.get("code").is_some_and(|code| code.is_i64()) && error.get("message").is_some_and(Value::is_string));
    (id_ok && (result != error)).then_some(MessageKind::Response)
}

/// True for an `initialize` request.
pub fn is_initialize_request(message: &Value) -> bool {
    classify(message) == Some(MessageKind::Request)
        && message.get("method").and_then(Value::as_str) == Some("initialize")
        && message.get("params").and_then(|params| params.get("protocolVersion")).is_some_and(Value::is_string)
}

/// A JSON-RPC error response.
pub fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Who is calling. Over HTTP it comes only from the authenticated session, never from the body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallerContext {
    pub principal: Option<String>,
    pub scopes: Vec<String>,
}

/// The MCP server behind a transport.
pub trait McpService: Send + Sync {
    /// Answers one request or notification. Notifications and responses return `None`.
    fn handle(&self, message: &Value, caller: &CallerContext) -> Option<Value>;
}

/// The server's identity in the `initialize` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub website_url: Option<String>,
    pub instructions: Option<String>,
}

/// The protocol methods of an MCP server and a fixed tool list.
#[derive(Debug, Clone)]
pub struct CoreService {
    info: ServerInfo,
    tools: Vec<Value>,
}

impl CoreService {
    pub fn new(info: ServerInfo, tools: Vec<Value>) -> Self {
        Self { info, tools }
    }

    fn initialize(&self, params: &Map<String, Value>) -> Value {
        let requested = params.get("protocolVersion").and_then(Value::as_str);
        let mut server_info = json!({ "name": self.info.name, "version": self.info.version });
        if let Some(url) = &self.info.website_url {
            server_info["websiteUrl"] = json!(url);
        }
        let mut result = json!({
            "protocolVersion": negotiate(requested),
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": server_info,
        });
        if let Some(instructions) = &self.info.instructions {
            result["instructions"] = json!(instructions);
        }
        result
    }
}

impl McpService for CoreService {
    fn handle(&self, message: &Value, _caller: &CallerContext) -> Option<Value> {
        if classify(message) != Some(MessageKind::Request) {
            return None;
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let empty = Map::new();
        let params = message.get("params").and_then(Value::as_object).unwrap_or(&empty);
        let result = match method {
            "initialize" => {
                if !params.get("protocolVersion").is_some_and(Value::is_string) {
                    return Some(error_response(id, INVALID_PARAMS, "Invalid initialize parameters"));
                }
                self.initialize(params)
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": self.tools }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
                return Some(error_response(id, INVALID_PARAMS, &format!("Tool {name} not found")));
            }
            _ => return Some(error_response(id, METHOD_NOT_FOUND, "Method not found")),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_requests_notifications_responses_and_refuses_the_rest() {
        assert_eq!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })), Some(MessageKind::Request));
        assert_eq!(classify(&json!({ "jsonrpc": "2.0", "id": "a", "method": "ping", "params": {} })), Some(MessageKind::Request));
        assert_eq!(classify(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), Some(MessageKind::Notification));
        assert_eq!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} })), Some(MessageKind::Response));
        assert_eq!(classify(&json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -1, "message": "x" } })), Some(MessageKind::Response));
        for invalid in [
            json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }]),
            json!({ "jsonrpc": "1.0", "id": 1, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 1.5, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 1, "method": 7 }),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1] }),
            json!({ "jsonrpc": "2.0", "id": 1, "result": {}, "error": { "code": 1, "message": "x" } }),
            json!({ "jsonrpc": "2.0", "id": 1 }),
            json!("text"),
        ] {
            assert_eq!(classify(&invalid), None, "{invalid}");
        }
    }

    fn service() -> CoreService {
        CoreService::new(
            ServerInfo { name: "test".into(), version: "0.0.0".into(), website_url: None, instructions: Some("hi".into()) },
            vec![json!({ "name": "hoi4.example" })],
        )
    }

    #[test]
    fn initialize_negotiates_and_answers_identity() {
        let answer = service().handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2099-01-01", "capabilities": {}, "clientInfo": { "name": "c", "version": "1" } } }), &CallerContext::default()).unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(answer["result"]["serverInfo"]["name"], "test");
        assert_eq!(answer["result"]["instructions"], "hi");
    }

    #[test]
    fn lists_tools_and_refuses_unknown_methods_and_tools() {
        let caller = CallerContext::default();
        let listed = service().handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &caller).unwrap();
        assert_eq!(listed["result"]["tools"][0]["name"], "hoi4.example");
        let unknown = service().handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" }), &caller).unwrap();
        assert_eq!(unknown["error"]["code"], METHOD_NOT_FOUND);
        let call = service().handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "hoi4.example" } }), &caller).unwrap();
        assert_eq!(call["error"]["code"], INVALID_PARAMS);
        assert!(service().handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &caller).is_none());
    }
}
