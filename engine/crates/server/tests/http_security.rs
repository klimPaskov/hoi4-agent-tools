//! Negative tests of the Streamable HTTP transport, driven over TCP as an external client.
//!
//! Ported from `tests/integration/http-security.test.ts`, `http-authorization.test.ts`,
//! `http-limits.test.ts` and `http-streaming.test.ts`, commit 9b7dc80d. Each test fails against a
//! server that drops the rule it names.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use hoi4_server::auth::JwtVerifier;
use hoi4_server::config::HttpConfig;
use hoi4_server::http::{HttpServerHandle, start_http_server};
use hoi4_server::jsonrpc::{CoreService, ServerInfo};
use serde_json::{Map, Value, json};

const TOKEN_A: &str = "alice-static-secret-0123456789abcdef";
const TOKEN_B: &str = "bob-static-secret-0123456789abcdefgh";

fn service() -> Arc<CoreService> {
    Arc::new(CoreService::new(
        ServerInfo { name: "hoi4-agent-tools".into(), version: "0.0.0-test".into(), website_url: None, instructions: None },
        vec![json!({ "name": "hoi4.example", "inputSchema": { "type": "object" } })],
    ))
}

fn static_server(extra: Value) -> HttpServerHandle {
    let mut config = json!({
        "port": 0,
        "allowedOrigins": ["http://allowed.test"],
        "tokens": [
            { "principal": "alice", "tokenEnv": "TOKEN_A", "workspaceIds": [] },
            { "principal": "bob", "tokenEnv": "TOKEN_B", "workspaceIds": [] },
        ],
    });
    if let (Some(target), Some(source)) = (config.as_object_mut(), extra.as_object()) {
        target.extend(source.clone());
    }
    let secrets = BTreeMap::from([("TOKEN_A", TOKEN_A.to_owned()), ("TOKEN_B", TOKEN_B.to_owned())]);
    start_http_server(HttpConfig::from_json(&config).unwrap(), &|name| secrets.get(name).cloned(), None, service()).unwrap()
}

/// Accepts `<subject>/<scopes>/<n>[/<client>]` tokens (scopes contain `:`); the number makes distinct credentials and the
/// optional fourth part names the OAuth client.
struct FakeVerifier;

impl JwtVerifier for FakeVerifier {
    fn verify(&self, token: &str) -> Result<Map<String, Value>, String> {
        let mut parts = token.split('/');
        let (Some(subject), Some(scopes), Some(_)) = (parts.next(), parts.next(), parts.next()) else { return Err("unsigned".into()) };
        let mut claims = json!({ "sub": subject, "exp": 4_000_000_000u64, "scope": scopes.replace('+', " ") });
        if let Some(client) = parts.next() {
            claims["client_id"] = json!(client);
        }
        Ok(claims.as_object().cloned().unwrap_or_default())
    }
}

fn oauth_server() -> HttpServerHandle {
    let config = json!({
        "port": 0,
        "publicUrl": "http://127.0.0.1/",
        "principals": [{ "principal": "alice" }, { "principal": "bob" }],
        "oauth": { "issuer": "https://id.example.test/", "jwksUri": "https://id.example.test/jwks", "audience": "hoi4", "authorizationServers": ["https://id.example.test/"] },
    });
    start_http_server(HttpConfig::from_json(&config).unwrap(), &|_| None, Some(Box::new(FakeVerifier)), service()).unwrap()
}

#[derive(Debug)]
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }

    /// The JSON of the first `data:` line of an event stream.
    fn event(&self) -> Value {
        let data = self.body.lines().find_map(|line| line.strip_prefix("data: ")).unwrap_or("null");
        serde_json::from_str(data).unwrap_or(Value::Null)
    }
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(line_end) = rest.windows(2).position(|window| window == b"\r\n") {
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..line_end]).unwrap_or("0").trim(), 16).unwrap_or(0);
        rest = &rest[line_end + 2..];
        if size == 0 || rest.len() < size {
            break;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[(size + 2).min(rest.len())..];
    }
    out
}

fn send_raw(server: &HttpServerHandle, raw: &[u8]) -> Response {
    let mut stream = TcpStream::connect(server.address()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    stream.write_all(raw).unwrap();
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    parse_response(&bytes)
}

fn parse_response(bytes: &[u8]) -> Response {
    let split = bytes.windows(4).position(|window| window == b"\r\n\r\n").unwrap_or(bytes.len());
    let head = String::from_utf8_lossy(&bytes[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|line| line.split(' ').nth(1)).and_then(|code| code.parse().ok()).unwrap_or(0);
    let headers: Vec<(String, String)> =
        lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.to_owned(), value.trim().to_owned())).collect();
    let raw_body = bytes.get(split + 4..).unwrap_or_default();
    let chunked = headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("transfer-encoding") && value == "chunked");
    let body = if chunked { dechunk(raw_body) } else { raw_body.to_vec() };
    Response { status, headers, body: String::from_utf8_lossy(&body).to_string() }
}

struct Request {
    method: &'static str,
    target: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

impl Request {
    fn post(body: &Value) -> Self {
        Self {
            method: "POST",
            target: "/mcp".into(),
            headers: vec![("Content-Type".into(), "application/json".into()), ("Accept".into(), "application/json, text/event-stream".into())],
            body: Some(body.to_string().into_bytes()),
        }
    }

    fn bare(method: &'static str) -> Self {
        Self { method, target: "/mcp".into(), headers: vec![("Accept".into(), "text/event-stream".into())], body: None }
    }

    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
        self.headers.push((name.into(), value.into()));
        self
    }

    fn extra_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    fn bearer(self, token: &str) -> Self {
        self.header("Authorization", &format!("Bearer {token}"))
    }

    fn session(self, id: &str) -> Self {
        self.header("Mcp-Session-Id", id).header("MCP-Protocol-Version", "2025-11-25")
    }

    fn raw_body(mut self, body: &[u8]) -> Self {
        self.body = Some(body.to_vec());
        self
    }

    fn send(&self, server: &HttpServerHandle) -> Response {
        let host = format!("127.0.0.1:{}", server.address().port());
        let mut raw = format!("{} {} HTTP/1.1\r\n", self.method, self.target);
        if !self.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("host")) {
            raw.push_str(&format!("Host: {host}\r\n"));
        }
        for (name, value) in &self.headers {
            raw.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = &self.body {
            raw.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        raw.push_str("Connection: close\r\n\r\n");
        let mut bytes = raw.into_bytes();
        if let Some(body) = &self.body {
            bytes.extend_from_slice(body);
        }
        send_raw(server, &bytes)
    }
}

fn initialize_body() -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })
}

fn ping(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

fn open_session(server: &HttpServerHandle, token: &str) -> String {
    let response = Request::post(&initialize_body()).bearer(token).send(server);
    assert_eq!(response.status, 200, "{response:?}");
    response.header("mcp-session-id").unwrap().to_owned()
}

#[test]
fn a_session_initializes_lists_tools_and_closes() {
    let server = static_server(json!({}));
    let response = Request::post(&initialize_body()).bearer(TOKEN_A).send(&server);
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream"));
    assert_eq!(response.event()["result"]["protocolVersion"], "2025-11-25");
    let id = response.header("mcp-session-id").unwrap().to_owned();
    let initialized = Request::post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(initialized.status, 202);
    let listed = Request::post(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(listed.event()["result"]["tools"][0]["name"], "hoi4.example");
    let closed = Request::bare("DELETE").bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(closed.status, 200);
    let after = Request::post(&ping(3)).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(after.status, 404);
    assert_eq!(server.session_count(), 0);
}

#[test]
fn every_request_needs_a_valid_bearer_token() {
    let server = static_server(json!({}));
    let missing = Request::post(&initialize_body()).send(&server);
    assert_eq!((missing.status, missing.json()["error"].clone()), (401, json!("AUTH_REQUIRED")));
    assert_eq!(missing.header("www-authenticate"), Some("Bearer scope=\"hoi4:read\""));
    let wrong = Request::post(&initialize_body()).bearer("not-the-secret-not-the-secret-not-it").send(&server);
    assert_eq!(wrong.status, 401);
    assert_eq!(wrong.header("www-authenticate"), Some("Bearer error=\"invalid_token\", scope=\"hoi4:read\""));
    let basic = Request::post(&initialize_body()).header("Authorization", "Basic YWxpY2U6eA==").send(&server);
    assert_eq!(basic.status, 401);
    for method in ["GET", "DELETE"] {
        assert_eq!(Request::bare(method).send(&server).status, 401, "{method}");
    }
    let put = Request::bare("PUT").send(&server);
    assert_eq!(put.status, 401, "an unauthenticated caller learns nothing about methods");
    let put = Request::bare("PUT").bearer(TOKEN_A).send(&server);
    assert_eq!((put.status, put.header("allow")), (405, Some("GET, POST, DELETE")));
}

#[test]
fn host_origin_and_request_target_are_checked() {
    let server = static_server(json!({}));
    let port = server.address().port();
    let evil_host = Request::post(&initialize_body()).bearer(TOKEN_A).header("Host", &format!("evil.test:{port}")).send(&server);
    assert_eq!((evil_host.status, evil_host.json()["error"]["message"].clone()), (403, json!("Invalid Host: evil.test")));
    let origin = Request::post(&initialize_body()).bearer(TOKEN_A).header("Origin", "http://evil.test").send(&server);
    assert_eq!((origin.status, origin.json()), (403, json!({ "error": "origin_not_allowed" })));
    let allowed = Request::post(&initialize_body()).bearer(TOKEN_A).header("Origin", "http://allowed.test").send(&server);
    assert_eq!(allowed.status, 200);
    let mut absolute = Request::post(&initialize_body()).bearer(TOKEN_A);
    absolute.target = format!("http://evil.test:{port}/mcp");
    assert_eq!(absolute.send(&server).status, 400);
    let mut matching = Request::post(&initialize_body()).bearer(TOKEN_A);
    matching.target = format!("http://127.0.0.1:{port}/mcp");
    assert_eq!(matching.send(&server).status, 200);
    let mut asterisk = Request::post(&initialize_body()).bearer(TOKEN_A);
    asterisk.target = "*".into();
    assert_eq!(asterisk.send(&server).status, 400);
}

#[test]
fn security_headers_must_not_repeat() {
    let server = static_server(json!({}));
    for name in ["Authorization", "Origin", "Mcp-Session-Id", "Host", "Content-Type", "X-Forwarded-For"] {
        let value = if name == "Host" { format!("127.0.0.1:{}", server.address().port()) } else { "x".to_owned() };
        let mut request = Request::post(&initialize_body()).bearer(TOKEN_A);
        if name == "Host" {
            request = request.extra_header("Host", &value);
        }
        let response = request.extra_header(name, &value).extra_header(name, &value).send(&server);
        assert_eq!(response.status, 400, "{name}");
        assert_eq!(response.json()["error"]["message"], "Ambiguous or duplicate security-sensitive HTTP header", "{name}");
    }
}

#[test]
fn bodies_are_typed_bounded_and_strict() {
    let server = static_server(json!({ "maxBodyBytes": 1024 }));
    let text = Request::post(&initialize_body()).bearer(TOKEN_A).header("Content-Type", "text/plain").send(&server);
    assert_eq!(text.status, 415);
    let suffixed = Request::post(&initialize_body()).bearer(TOKEN_A).header("Content-Type", "application/vnd.x+json").send(&server);
    assert_eq!(suffixed.status, 415);
    let gzip = Request::post(&initialize_body()).bearer(TOKEN_A).header("Content-Encoding", "gzip").send(&server);
    assert_eq!(gzip.status, 415);
    let large = Request::post(&initialize_body()).bearer(TOKEN_A).raw_body(&vec![b' '; 2048]).send(&server);
    assert_eq!(large.status, 413);
    let invalid = Request::post(&initialize_body()).bearer(TOKEN_A).raw_body(b"{not json").send(&server);
    assert_eq!((invalid.status, invalid.json()["error"]["code"].clone()), (400, json!(-32_700)));
    let scalar = Request::post(&initialize_body()).bearer(TOKEN_A).raw_body(b"\"text\"").send(&server);
    assert_eq!(scalar.status, 400, "strict JSON admits only objects and arrays");
    let bad_utf8 = Request::post(&initialize_body()).bearer(TOKEN_A).raw_body(b"{\"a\":\"\xff\"}").send(&server);
    assert_eq!(bad_utf8.json()["error"]["message"], "Parse error: Invalid UTF-8 JSON");
    let batch = Request::post(&json!([initialize_body()])).bearer(TOKEN_A).send(&server);
    assert_eq!(batch.json()["error"]["message"], "JSON-RPC batching is not supported");
    // An unauthenticated caller is refused before its body is read.
    let unauthenticated = Request::post(&initialize_body()).raw_body(&vec![b' '; 900]).send(&server);
    assert_eq!(unauthenticated.status, 401);
}

#[test]
fn body_framing_cannot_be_smuggled() {
    let server = static_server(json!({}));
    let host = format!("127.0.0.1:{}", server.address().port());
    let both = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
    );
    assert_eq!(send_raw(&server, both.as_bytes()).status, 400);
    let twice = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{{}}"
    );
    assert_eq!(send_raw(&server, twice.as_bytes()).status, 400);
    let body = initialize_body().to_string();
    let chunked = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
        body.len()
    );
    assert_eq!(send_raw(&server, chunked.as_bytes()).status, 200, "a plain chunked body is accepted");
    let huge_head = format!("GET /mcp HTTP/1.1\r\nHost: {host}\r\nX-Pad: {}\r\n\r\n", "a".repeat(20_000));
    assert_eq!(send_raw(&server, huge_head.as_bytes()).status, 431);
}

#[test]
fn a_slow_head_times_out() {
    let server = static_server(json!({ "headersTimeoutMs": 2000, "keepAliveTimeoutMs": 1000 }));
    let mut stream = TcpStream::connect(server.address()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    stream.write_all(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    let _ = stream.write_all(b"X-Slow: 1\r\n");
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    assert_eq!(parse_response(&bytes).status, 408);
}

#[test]
fn initialize_needs_both_accept_types_and_sessions_need_the_protocol_header() {
    let server = static_server(json!({}));
    let json_only = Request::post(&initialize_body()).bearer(TOKEN_A).header("Accept", "application/json").send(&server);
    assert_eq!(json_only.status, 406);
    let wildcard = Request::post(&initialize_body()).bearer(TOKEN_A).header("Accept", "*/*").send(&server);
    assert_eq!(wildcard.status, 406);
    let id = open_session(&server, TOKEN_A);
    let missing = Request::post(&ping(2)).bearer(TOKEN_A).header("Mcp-Session-Id", &id).send(&server);
    assert!(missing.json()["error"]["message"].as_str().unwrap().starts_with("Missing MCP-Protocol-Version header"));
    let unsupported = Request::post(&ping(2)).bearer(TOKEN_A).session(&id).header("MCP-Protocol-Version", "2026-07-28").send(&server);
    assert_eq!(unsupported.status, 400);
    let no_session = Request::post(&ping(2)).bearer(TOKEN_A).send(&server);
    assert_eq!(no_session.json()["error"]["message"], "No valid session ID or initialize request");
    let reinitialize = Request::post(&initialize_body()).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(reinitialize.json()["error"]["message"], "Invalid Request: Server already initialized");
    let ok = Request::post(&ping(3)).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(ok.event()["result"], json!({}));
}

#[test]
fn sessions_are_isolated_between_principals() {
    let server = static_server(json!({}));
    let alice = open_session(&server, TOKEN_A);
    let hijack = Request::post(&ping(2)).bearer(TOKEN_B).session(&alice).send(&server);
    assert_eq!((hijack.status, hijack.json()["error"]["message"].clone()), (403, json!("MCP session belongs to another principal")));
    let stream = Request::bare("GET").bearer(TOKEN_B).session(&alice).send(&server);
    assert_eq!(stream.status, 403);
    let delete = Request::bare("DELETE").bearer(TOKEN_B).session(&alice).send(&server);
    assert_eq!(delete.status, 403);
    assert_eq!(server.session_count(), 1, "another principal cannot close the session");
    let forged = Request::post(&ping(2)).bearer(TOKEN_A).session("00000000-0000-4000-8000-000000000000").send(&server);
    assert_eq!(forged.status, 404);
}

#[test]
fn a_session_is_bound_to_its_credential_and_scopes() {
    let server = oauth_server();
    let id = open_session(&server, "alice/hoi4:read+hoi4:write/1");
    let other_credential = Request::post(&ping(2)).bearer("alice/hoi4:read+hoi4:write/2").session(&id).send(&server);
    assert_eq!(
        (other_credential.status, other_credential.json()["error"]["message"].clone()),
        (403, json!("MCP session authorization context does not match"))
    );
    let same = Request::post(&ping(3)).bearer("alice/hoi4:read+hoi4:write/1").session(&id).send(&server);
    assert_eq!(same.status, 200);
}

#[test]
fn write_tools_need_the_write_scope_and_principals_an_allowlist() {
    let server = oauth_server();
    let reader = "alice/hoi4:read/1";
    let id = open_session(&server, reader);
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "hoi4.focus_rewrite", "arguments": {} } });
    let refused = Request::post(&call).bearer(reader).session(&id).send(&server);
    assert_eq!((refused.status, refused.json()["error"].clone()), (403, json!("AUTH_SCOPE_INSUFFICIENT")));
    let challenge = refused.header("www-authenticate").unwrap();
    assert!(challenge.starts_with("Bearer error=\"insufficient_scope\", scope=\"hoi4:read hoi4:write\", resource_metadata=\"http://127.0.0.1/.well-known/oauth-protected-resource/mcp\""), "{challenge}");
    let read_call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "hoi4.example" } });
    assert_eq!(Request::post(&read_call).bearer(reader).session(&id).send(&server).status, 200);
    let stranger = Request::post(&initialize_body()).bearer("mallory/hoi4:read/1").send(&server);
    assert_eq!((stranger.status, stranger.json()["error"].clone()), (403, json!("AUTH_PRINCIPAL_FORBIDDEN")));
    let unsigned = Request::post(&initialize_body()).bearer("unsigned").send(&server);
    assert_eq!(unsigned.status, 401);
    let metadata = Request::bare("GET").send_to_path(&server, "/.well-known/oauth-protected-resource/mcp");
    assert_eq!(metadata.json()["resource"], "http://127.0.0.1/mcp");
}

impl Request {
    fn send_to_path(mut self, server: &HttpServerHandle, path: &str) -> Response {
        self.target = path.to_owned();
        self.send(server)
    }
}

#[test]
fn rate_and_session_limits_hold() {
    let server = static_server(json!({ "requestsPerMinute": 3 }));
    for _ in 0..3 {
        assert_ne!(Request::post(&ping(1)).bearer(TOKEN_A).send(&server).status, 429);
    }
    let limited = Request::post(&ping(1)).bearer(TOKEN_A).send(&server);
    assert_eq!((limited.status, limited.header("retry-after")), (429, Some("60")));
    assert_eq!(limited.json(), json!({ "error": "rate_limit" }));

    let server = static_server(json!({ "maxSessionsPerPrincipal": 1 }));
    open_session(&server, TOKEN_A);
    let second = Request::post(&initialize_body()).bearer(TOKEN_A).send(&server);
    assert_eq!((second.status, second.json()), (429, json!({ "error": "principal_session_limit" })));
    open_session(&server, TOKEN_B);
}

#[test]
fn event_streams_are_exclusive_bounded_and_end_with_their_session() {
    let server = Arc::new(static_server(json!({ "maxEventStreamsPerPrincipal": 1 })));
    let id = open_session(&server, TOKEN_A);
    let wrong_accept = Request::bare("GET").bearer(TOKEN_A).session(&id).header("Accept", "application/json").send(&server);
    assert_eq!(wrong_accept.status, 406);
    let first_server = Arc::clone(&server);
    let first_id = id.clone();
    let first = std::thread::spawn(move || Request::bare("GET").bearer(TOKEN_A).session(&first_id).send(&first_server));
    std::thread::sleep(Duration::from_millis(500));
    let second = Request::bare("GET").bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!((second.status, second.json()), (429, json!({ "error": "principal_event_stream_limit" })));
    assert_eq!(Request::bare("DELETE").bearer(TOKEN_A).session(&id).send(&server).status, 200);
    let first = first.join().unwrap();
    assert_eq!((first.status, first.header("content-type")), (200, Some("text/event-stream")));
}

#[test]
fn unsafe_deployments_refuse_to_start() {
    let secrets = BTreeMap::from([("TOKEN_A", TOKEN_A.to_owned())]);
    let lookup = |name: &str| secrets.get(name).cloned();
    let public = HttpConfig::from_json(&json!({ "host": "0.0.0.0", "port": 0, "tokens": [{ "principal": "alice", "tokenEnv": "TOKEN_A" }] })).unwrap();
    assert_eq!(start_http_server(public, &lookup, None, service()).unwrap_err().code, "HTTP_PUBLIC_OAUTH_REQUIRED");
    let none = HttpConfig::from_json(&json!({ "port": 0 })).unwrap();
    assert_eq!(start_http_server(none, &lookup, None, service()).unwrap_err().code, "HTTP_AUTH_NOT_CONFIGURED");
    let short = HttpConfig::from_json(&json!({ "port": 0, "tokens": [{ "principal": "alice", "tokenEnv": "TOKEN_SHORT" }] })).unwrap();
    assert_eq!(start_http_server(short, &|_| Some("short".into()), None, service()).unwrap_err().code, "HTTP_STATIC_TOKEN_INVALID");
    let oauth = HttpConfig::from_json(&json!({
        "port": 0,
        "publicUrl": "http://127.0.0.1/",
        "principals": [{ "principal": "alice" }],
        "oauth": { "issuer": "https://id.example.test/", "jwksUri": "https://id.example.test/jwks", "audience": "hoi4", "authorizationServers": ["https://id.example.test/"] },
    }))
    .unwrap();
    assert_eq!(start_http_server(oauth, &lookup, None, service()).unwrap_err().code, "HTTP_OAUTH_VERIFIER_UNAVAILABLE");
}

#[test]
fn the_rate_limit_key_ignores_forwarded_headers_from_untrusted_peers() {
    let server = static_server(json!({ "requestsPerMinute": 2 }));
    for spoof in ["198.51.100.1", "198.51.100.2"] {
        assert_ne!(Request::post(&ping(1)).bearer(TOKEN_A).header("X-Forwarded-For", spoof).send(&server).status, 429);
    }
    let third = Request::post(&ping(1)).bearer(TOKEN_A).header("X-Forwarded-For", "198.51.100.3").send(&server);
    assert_eq!(third.status, 429, "a spoofed X-Forwarded-For does not open a new window");
}

#[test]
fn invalid_credentials_are_rate_limited_before_authentication() {
    let server = static_server(json!({ "requestsPerMinute": 2 }));
    for _ in 0..2 {
        assert_eq!(Request::post(&ping(1)).bearer("not-the-secret-not-the-secret-not-it").send(&server).status, 401);
    }
    let limited = Request::post(&ping(1)).bearer("not-the-secret-not-the-secret-not-it").send(&server);
    assert_eq!((limited.status, limited.json()), (429, json!({ "error": "rate_limit" })), "guessing stops at the client window");
    let valid = Request::post(&ping(1)).bearer(TOKEN_A).send(&server);
    assert_eq!(valid.status, 429, "the window counts the client address before any token is checked");
}

#[test]
fn the_body_limit_holds_on_established_sessions() {
    let server = static_server(json!({ "maxBodyBytes": 1024 }));
    let id = open_session(&server, TOKEN_A);
    let padded = format!("{}{}", ping(2), " ".repeat(2048));
    let large = Request::post(&ping(2)).bearer(TOKEN_A).session(&id).raw_body(padded.as_bytes()).send(&server);
    assert_eq!(large.status, 413);
    let charset = Request::post(&ping(3)).bearer(TOKEN_A).session(&id).header("Content-Type", "application/json; charset=iso-8859-1").send(&server);
    assert_eq!(charset.status, 415, "only UTF-8 JSON is accepted");
    let ok = Request::post(&ping(4)).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(ok.status, 200);
}

#[test]
fn an_older_revision_is_negotiated_and_then_required() {
    let server = static_server(json!({}));
    let mut body = initialize_body();
    body["params"]["protocolVersion"] = json!("2025-06-18");
    let response = Request::post(&body).bearer(TOKEN_A).send(&server);
    assert_eq!(response.event()["result"]["protocolVersion"], "2025-06-18");
    let id = response.header("mcp-session-id").unwrap().to_owned();
    let older = Request::post(&ping(2)).bearer(TOKEN_A).session(&id).header("MCP-Protocol-Version", "2025-06-18").send(&server);
    assert_eq!(older.status, 200, "a supported non-current revision is accepted after negotiation");
    let unknown = Request::post(&json!({ "jsonrpc": "2.0", "id": 3, "method": "hoi4/unknown" })).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(unknown.event()["error"]["code"], -32_601);
    let mut future = initialize_body();
    future["params"]["protocolVersion"] = json!("2099-01-01");
    assert_eq!(Request::post(&future).bearer(TOKEN_A).send(&server).event()["result"]["protocolVersion"], "2025-11-25");
}

#[test]
fn oauth_challenges_name_the_resource_and_another_client_is_not_a_scope_failure() {
    let server = oauth_server();
    let missing = Request::post(&initialize_body()).send(&server);
    assert_eq!(missing.status, 401);
    let challenge = missing.header("www-authenticate").unwrap();
    assert!(challenge.contains("resource_metadata=\"http://127.0.0.1/.well-known/oauth-protected-resource/mcp\""), "{challenge}");
    let token = "alice/hoi4:read+hoi4:write/1/client-one";
    let id = open_session(&server, token);
    let other = Request::post(&ping(2)).bearer("alice/hoi4:read+hoi4:write/1/client-two").session(&id).send(&server);
    assert_eq!(other.status, 403);
    assert_eq!(other.json()["error"]["message"], "MCP session authorization context does not match");
    assert!(!other.header("www-authenticate").unwrap_or_default().contains("insufficient_scope"), "a client mismatch is not a scope failure");
    assert_eq!(Request::post(&ping(3)).bearer(token).session(&id).send(&server).status, 200);
}
