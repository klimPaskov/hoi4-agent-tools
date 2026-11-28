//! Negative tests of the Streamable HTTP transport, driven over TCP as an external client.
//!
//! Ported from `tests/integration/http-security.test.ts`, `http-authorization.test.ts`,
//! `http-limits.test.ts` and `http-streaming.test.ts`, commit 9b7dc80d. Each test fails against a
//! server that drops the rule it names.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hoi4_server::auth::{JwtExpectations, JwtVerifier};
use hoi4_server::config::HttpConfig;
use hoi4_server::http::{Clock, HttpServerHandle, start_http_server, start_http_server_with_clock};
use hoi4_server::jsonrpc::{CallerContext, CoreService, McpService, ServerInfo};
use serde_json::{Map, Value, json};

const TOKEN_A: &str = "alice-static-secret-0123456789abcdef";
const TOKEN_B: &str = "bob-static-secret-0123456789abcdefgh";
/// The default body limit; the aggregate body budget is twice it.
const MAX_BODY: u64 = hoi4_server::config::HTTP_MAX_BODY_BYTES;

fn service() -> Arc<CoreService> {
    Arc::new(CoreService::new(
        ServerInfo { name: "hoi4-agent-tools".into(), version: "0.0.0-test".into(), website_url: None, instructions: None },
        vec![json!({ "name": "hoi4.example", "inputSchema": { "type": "object" } })],
    ))
}

/// The wall clock plus a test-controlled offset, so a test moves time forward instead of sleeping
/// through a session lifetime, as the TypeScript tests replace `Date.now`.
#[derive(Clone, Default)]
struct TestClock(Arc<AtomicU64>);

impl TestClock {
    fn advance(&self, milliseconds: u64) {
        self.0.fetch_add(milliseconds, Ordering::SeqCst);
    }

    fn now_seconds(&self) -> u64 {
        (self.clock())() / 1000
    }

    fn clock(&self) -> Clock {
        let offset = Arc::clone(&self.0);
        Arc::new(move || {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) + offset.load(Ordering::SeqCst)
        })
    }
}

fn static_server(extra: Value) -> HttpServerHandle {
    static_server_with(extra, service(), TestClock::default())
}

fn static_server_with(extra: Value, service: Arc<dyn McpService>, clock: TestClock) -> HttpServerHandle {
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
    start_http_server_with_clock(HttpConfig::from_json(&config).unwrap(), &|name| secrets.get(name).cloned(), None, service, clock.clock()).unwrap()
}

/// Accepts `<subject>/<scopes>/<n>[/<client>[/<exp>]]` tokens (scopes contain `:`). The number
/// makes distinct credentials, the fourth part names the OAuth client (`-` for none), and the
/// fifth sets `exp` in Unix seconds. It returns the configured issuer and audience, as a verifier
/// that checked them would, and checks no time claim itself, so the server's checks are tested.
struct FakeVerifier;

impl JwtVerifier for FakeVerifier {
    fn verify(&self, token: &str, expected: &JwtExpectations<'_>) -> Result<Map<String, Value>, String> {
        assert_eq!((expected.issuer, expected.audience, expected.algorithms), ("https://id.example.test/", "hoi4", &["RS256".to_owned()][..]));
        let mut parts = token.split('/');
        let (Some(subject), Some(scopes), Some(_)) = (parts.next(), parts.next(), parts.next()) else { return Err("unsigned".into()) };
        let mut claims =
            json!({ "iss": expected.issuer, "aud": expected.audience, "sub": subject, "exp": 4_000_000_000u64, "scope": scopes.replace('+', " ") });
        if let Some(client) = parts.next().filter(|client| *client != "-") {
            claims["client_id"] = json!(client);
        }
        if let Some(exp) = parts.next() {
            claims["exp"] = json!(exp.parse::<u64>().map_err(|_| "bad exp")?);
        }
        Ok(claims.as_object().cloned().unwrap_or_default())
    }
}

fn oauth_server() -> HttpServerHandle {
    oauth_server_with(json!({}), TestClock::default())
}

fn oauth_server_with(extra: Value, clock: TestClock) -> HttpServerHandle {
    let mut config = json!({
        "port": 0,
        "publicUrl": "http://127.0.0.1/",
        "principals": [{ "principal": "alice" }, { "principal": "bob" }],
        "oauth": { "issuer": "https://id.example.test/", "jwksUri": "https://id.example.test/jwks", "audience": "hoi4", "authorizationServers": ["https://id.example.test/"] },
    });
    if let (Some(target), Some(source)) = (config.as_object_mut(), extra.as_object()) {
        target.extend(source.clone());
    }
    start_http_server_with_clock(HttpConfig::from_json(&config).unwrap(), &|_| None, Some(Box::new(FakeVerifier)), service(), clock.clock()).unwrap()
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

    /// The JSON of the first non-empty `data:` line of an event stream; the priming event's data
    /// is empty.
    fn event(&self) -> Value {
        let data = self.body.lines().filter_map(|line| line.strip_prefix("data: ")).find(|data| !data.is_empty()).unwrap_or("null");
        serde_json::from_str(data).unwrap_or(Value::Null)
    }

    /// The `id:` of the stream's first event, the priming event at 2025-11-25.
    fn first_event_id(&self) -> Option<String> {
        self.body.lines().find_map(|line| line.strip_prefix("id: ")).map(str::to_owned)
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
        send_raw(server, &self.bytes(server, true))
    }

    /// The request on the wire; `close` adds `Connection: close`.
    fn bytes(&self, server: &HttpServerHandle, close: bool) -> Vec<u8> {
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
        raw.push_str(if close { "Connection: close\r\n\r\n" } else { "\r\n" });
        let mut bytes = raw.into_bytes();
        if let Some(body) = &self.body {
            bytes.extend_from_slice(body);
        }
        bytes
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
    // Every name of SINGLETON_SECURITY_HEADERS, and the mcp-param-* family.
    for name in [
        "Authorization",
        "Content-Encoding",
        "Content-Type",
        "Host",
        "Last-Event-ID",
        "Mcp-Method",
        "Mcp-Name",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "Origin",
        "X-Forwarded-For",
        "Mcp-Param-Workspace",
    ] {
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

// ---- Helpers for raw connections ----

fn connect(server: &HttpServerHandle) -> TcpStream {
    let stream = TcpStream::connect(server.address()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    stream
}

/// Reads until the server closes the connection or the read timeout passes.
fn read_all(stream: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    bytes
}

/// Reads until `needle` arrives (or the connection ends), then returns what was read.
fn read_until(stream: &mut TcpStream, needle: &str) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    while !String::from_utf8_lossy(&bytes).contains(needle) {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => bytes.extend_from_slice(&buffer[..read]),
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// The number of HTTP responses in what a connection returned.
fn response_count(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    usize::from(text.starts_with("HTTP/1.1 ")) + text.matches("\r\nHTTP/1.1 ").count()
}

/// Waits, boundedly, until `ready` holds; the server releases resources on its own threads.
fn eventually(what: &str, ready: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < until, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Records the caller of every `tools/call`.
struct Recording {
    inner: Arc<CoreService>,
    callers: Mutex<Vec<CallerContext>>,
}

impl McpService for Recording {
    fn handle(&self, message: &Value, caller: &CallerContext) -> Option<Value> {
        if message["method"] == "tools/call" {
            self.callers.lock().unwrap().push(caller.clone());
        }
        self.inner.handle(message, caller)
    }
}

// ---- Request desync (review finding 1) ----

#[test]
fn a_refused_request_never_leaves_its_body_on_the_connection() {
    let server = static_server(json!({ "keepAliveTimeoutMs": 1000, "headersTimeoutMs": 2000 }));
    let port = server.address().port();
    // The body of each refused request is a whole second request; were it left unread, it would be
    // answered as the next request on the socket.
    let smuggled = format!("GET /x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    let base = || Request::post(&json!({})).bearer(TOKEN_A).raw_body(smuggled.as_bytes());
    let mut absolute = base();
    absolute.target = format!("http://evil.test:{port}/mcp");
    let mut other_path = base();
    other_path.target = "/other".into();
    let mut put = base();
    put.method = "PUT";
    let cases: Vec<(&str, Request, u16)> = vec![
        ("duplicate Origin", base().extra_header("Origin", "http://allowed.test").extra_header("Origin", "http://allowed.test"), 400),
        ("request target", absolute, 400),
        ("Host", base().header("Host", &format!("evil.test:{port}")), 403),
        ("Origin", base().header("Origin", "http://evil.test"), 403),
        ("Content-Type", base().header("Content-Type", "text/plain"), 415),
        ("Content-Encoding", base().header("Content-Encoding", "gzip"), 415),
        ("missing token", base().header("Authorization", "Basic eA=="), 401),
        ("another path", other_path, 404),
        ("another method", put, 405),
    ];
    for (name, request, status) in cases {
        let mut stream = connect(&server);
        stream.write_all(&request.bytes(&server, false)).unwrap();
        let bytes = read_all(&mut stream);
        assert_eq!(parse_response(&bytes).status, status, "{name}");
        assert_eq!(response_count(&bytes), 1, "{name}: the unread body was answered as a request: {}", String::from_utf8_lossy(&bytes));
        assert_eq!(parse_response(&bytes).header("connection"), Some("close"), "{name}");
    }
    // The same with a chunked body.
    let mut stream = connect(&server);
    let chunked = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{smuggled}\r\n0\r\n\r\n",
        smuggled.len()
    );
    stream.write_all(chunked.as_bytes()).unwrap();
    let bytes = read_all(&mut stream);
    assert_eq!((parse_response(&bytes).status, response_count(&bytes)), (415, 1));
    // A body the server did read keeps the connection, so a pipelined request is answered: the
    // test above would see a desync.
    let mut stream = connect(&server);
    let mut pipelined = Request::post(&initialize_body()).bearer(TOKEN_A).bytes(&server, false);
    pipelined.extend_from_slice(smuggled.as_bytes());
    stream.write_all(&pipelined).unwrap();
    let bytes = read_all(&mut stream);
    assert_eq!(response_count(&bytes), 2, "{}", String::from_utf8_lossy(&bytes));
    assert!(String::from_utf8_lossy(&bytes).contains("Cannot GET /x"));
}

// ---- Caller context (review finding 2) ----

#[test]
fn every_session_request_reaches_the_service_as_its_authenticated_principal() {
    let recording = Arc::new(Recording { inner: service(), callers: Mutex::new(Vec::new()) });
    let server = Arc::new(static_server_with(json!({}), Arc::clone(&recording) as Arc<dyn McpService>, TestClock::default()));
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "hoi4.example" } });
    // Requests race session closes: a session removed between its lookup and the call must never
    // reach the service as the trusted caller without a principal.
    for _ in 0..10 {
        let id = open_session(&server, TOKEN_A);
        let callers: Vec<_> = (0..4)
            .map(|_| {
                let (server, id, call) = (Arc::clone(&server), id.clone(), call.clone());
                std::thread::spawn(move || {
                    for _ in 0..5 {
                        Request::post(&call).bearer(TOKEN_A).session(&id).send(&server);
                    }
                })
            })
            .collect();
        std::thread::sleep(Duration::from_millis(5));
        Request::bare("DELETE").bearer(TOKEN_A).session(&id).send(&server);
        for caller in callers {
            caller.join().unwrap();
        }
    }
    let id = open_session(&server, TOKEN_A);
    assert_eq!(Request::post(&call).bearer(TOKEN_A).session(&id).send(&server).status, 200);
    let callers = recording.callers.lock().unwrap();
    assert!(!callers.is_empty());
    for caller in callers.iter() {
        assert_eq!(caller.principal.as_deref(), Some("alice"), "{caller:?}");
        assert_eq!(caller.scopes, vec!["hoi4:read".to_owned(), "hoi4:write".to_owned()]);
    }
}

// ---- Chunk sizes (review finding 4) ----

#[test]
fn chunk_sizes_cannot_overflow_or_be_malformed() {
    let server = static_server(json!({}));
    let port = server.address().port();
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
    );
    for (chunks, status) in [
        ("1\r\n{\r\nffffffffffffffff\r\n", 413),
        ("ffffffffffffffff\r\n", 413),
        ("10000000000000000\r\n", 413),
        ("zz\r\n{}\r\n0\r\n\r\n", 400),
        ("2\r\n{}XX0\r\n\r\n", 400),
    ] {
        let response = send_raw(&server, format!("{head}{chunks}").as_bytes());
        assert_eq!(response.status, status, "{chunks:?}");
        assert_eq!(response.header("connection"), Some("close"), "{chunks:?}");
    }
    // The server is still serving.
    assert_eq!(Request::post(&initialize_body()).bearer(TOKEN_A).send(&server).status, 200);
}

// ---- Streams and credential expiry (review finding 5) ----

#[test]
fn an_event_stream_ends_when_its_credential_expires() {
    let clock = TestClock::default();
    let server = oauth_server_with(json!({}), clock.clone());
    let token = format!("alice/hoi4:read/1/-/{}", clock.now_seconds() + 60);
    let id = open_session(&server, &token);
    let mut stream = connect(&server);
    stream.write_all(&Request::bare("GET").bearer(&token).session(&id).bytes(&server, true)).unwrap();
    assert!(read_until(&mut stream, "\r\n\r\n").starts_with("HTTP/1.1 200"));
    clock.advance(61_000);
    let started = Instant::now();
    read_all(&mut stream);
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(5), "the stream outlived its credential by {elapsed:?}");
    assert_eq!(server.session_count(), 0, "the expired session is removed with its stream");
}

// ---- The 405 path and the per-principal rate (review finding 6) ----

#[test]
fn an_unsupported_method_counts_against_the_principal_rate() {
    // Forwarded addresses from the trusted loopback proxy give each request its own pre-auth
    // window, so only the per-principal window can refuse the third PUT.
    let server = static_server(json!({ "requestsPerMinute": 2, "trustedProxyAddresses": ["127.0.0.1"] }));
    for (address, status) in [("192.0.2.1", 405), ("192.0.2.2", 405), ("192.0.2.3", 429)] {
        let response = Request::bare("PUT").bearer(TOKEN_A).header("X-Forwarded-For", address).send(&server);
        assert_eq!(response.status, status, "{address}");
    }
    assert_eq!(Request::bare("PUT").bearer(TOKEN_B).header("X-Forwarded-For", "192.0.2.4").send(&server).status, 405, "bob has his own window");
}

// ---- Ported from http-limits.test.ts:474 ----

#[test]
fn concurrency_is_reserved_before_the_body_and_the_overflow_admits_only_control_methods() {
    let server = static_server(json!({ "maxConcurrentRequests": 1, "headersTimeoutMs": 1500, "requestTimeoutMs": 10000, "keepAliveTimeoutMs": 1000 }));
    let id = open_session(&server, TOKEN_A);
    // An authenticated upload that never finishes holds the only request slot.
    let mut held = connect(&server);
    held.write_all(
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{{",
            server.address().port()
        )
        .as_bytes(),
    )
    .unwrap();
    let call = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "hoi4.example" } });
    eventually("the upload holds the slot", || Request::post(&call).bearer(TOKEN_A).session(&id).send(&server).status == 429);
    for method in ["ping", "tools/list", "resources/templates/list"] {
        let control = Request::post(&json!({ "jsonrpc": "2.0", "id": 3, "method": method, "params": {} })).bearer(TOKEN_A).session(&id).send(&server);
        assert_eq!(control.status, 200, "{method}");
    }
    let cancellation = Request::post(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 9 } }))
        .bearer(TOKEN_A)
        .session(&id)
        .send(&server);
    assert_eq!(cancellation.status, 202);
    let refused = Request::post(&call).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!((refused.status, refused.header("retry-after")), (429, Some("1")));
    let initialize = Request::post(&initialize_body()).bearer(TOKEN_A).send(&server);
    assert_eq!((initialize.status, initialize.json()), (429, json!({ "error": "concurrency_limit" })));
    drop(held);
}

// ---- Ported from http-limits.test.ts:540 ----

#[test]
fn the_aggregate_body_budget_is_bounded_and_released_after_interrupted_uploads() {
    let server = static_server(json!({ "maxConcurrentRequests": 8 }));
    let id = open_session(&server, TOKEN_A);
    let port = server.address().port();
    let upload = |authorization: &str| {
        format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authorization}Content-Type: application/json\r\nContent-Length: {MAX_BODY}\r\n\r\n{{")
    };
    // An unauthenticated upload is refused before its body and holds nothing.
    let mut anonymous = connect(&server);
    anonymous.write_all(upload("").as_bytes()).unwrap();
    assert!(read_until(&mut anonymous, "\r\n").starts_with("HTTP/1.1 401"));
    assert_eq!(server.reserved_body_bytes(), 0, "the refused upload holds nothing");
    // Two authenticated maximum-size uploads fill the aggregate budget of twice the body limit.
    // The wait reads the reservation itself: a probe request sent meanwhile reserves its own body,
    // and one admitted between the two uploads leaves too little for the second.
    let held: Vec<TcpStream> = (0..2)
        .map(|_| {
            let mut stream = connect(&server);
            stream.write_all(upload(&format!("Authorization: Bearer {TOKEN_A}\r\n")).as_bytes()).unwrap();
            stream
        })
        .collect();
    eventually("both uploads hold their reservation", || server.reserved_body_bytes() == 2 * MAX_BODY);
    let probe = Request::post(&initialize_body()).bearer(TOKEN_A).send(&server);
    assert_eq!((probe.status, probe.json()), (429, json!({ "error": "body_capacity_limit" })));
    assert_eq!(server.reserved_body_bytes(), 2 * MAX_BODY, "the refused probe holds nothing");
    drop(held);
    drop(anonymous);
    eventually("the interrupted uploads release their reservation", || server.reserved_body_bytes() == 0);
    assert_eq!(Request::post(&ping(2)).bearer(TOKEN_A).session(&id).send(&server).status, 200);
}

#[test]
fn a_request_admitted_between_two_maximum_uploads_leaves_too_little_for_the_second() {
    // Why the test above waits on the reservation: a small request admitted while the first
    // maximum-size upload holds its reservation takes part of the budget the second one needs.
    let server = static_server(json!({ "maxConcurrentRequests": 8 }));
    let port = server.address().port();
    let head = |length: u64| {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN_A}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n\r\n{{"
        )
    };
    let mut first = connect(&server);
    first.write_all(head(MAX_BODY).as_bytes()).unwrap();
    eventually("the first upload holds its reservation", || server.reserved_body_bytes() == MAX_BODY);
    let mut small = connect(&server);
    small.write_all(head(200).as_bytes()).unwrap();
    eventually("the small request holds its reservation", || server.reserved_body_bytes() == MAX_BODY + 200);
    let mut second = connect(&server);
    second.write_all(head(MAX_BODY).as_bytes()).unwrap();
    let refused = read_until(&mut second, "\r\n\r\n");
    assert!(refused.starts_with("HTTP/1.1 429"), "{refused}");
    assert_eq!(server.reserved_body_bytes(), MAX_BODY + 200, "the refused upload holds nothing");
    drop((first, small));
    eventually("the uploads release their reservation", || server.reserved_body_bytes() == 0);
}

// ---- Ported from http-authorization.test.ts:250 ----

#[test]
fn an_expired_oauth_initialize_is_refused_and_an_expired_session_releases_its_slot() {
    let clock = TestClock::default();
    let server = oauth_server_with(json!({ "maxSessionsPerPrincipal": 1 }), clock.clone());
    let now = clock.now_seconds();
    let expired = Request::post(&initialize_body()).bearer(&format!("alice/hoi4:read/1/-/{}", now - 1)).send(&server);
    assert_eq!(expired.status, 401);
    let short = format!("alice/hoi4:read/2/-/{}", now + 60);
    let id = open_session(&server, &short);
    let replacement = format!("alice/hoi4:read/3/-/{}", now + 7200);
    let blocked = Request::post(&initialize_body()).bearer(&replacement).send(&server);
    assert_eq!((blocked.status, blocked.json()), (429, json!({ "error": "principal_session_limit" })), "the short session holds the only slot");
    clock.advance(61_000);
    assert_eq!(Request::post(&initialize_body()).bearer(&replacement).send(&server).status, 200, "the expired session released its slot");
    assert_eq!(Request::post(&ping(2)).bearer(&short).session(&id).send(&server).status, 401, "its credential has expired");
}

// ---- Ported from http-limits.test.ts:646 ----

#[test]
fn forwarded_client_addresses_count_only_from_trusted_proxies() {
    let invalid = "x".repeat(32);
    let trusted = static_server(json!({ "requestsPerMinute": 1, "trustedProxyAddresses": ["127.0.0.1"] }));
    for address in ["192.0.2.10", "192.0.2.11"] {
        let response = Request::post(&initialize_body()).bearer(&invalid).header("X-Forwarded-For", address).send(&trusted);
        assert_eq!(response.status, 401, "a trusted proxy's clients have their own windows: {address}");
    }
    let untrusted = static_server(json!({ "requestsPerMinute": 1 }));
    let first = Request::post(&initialize_body()).bearer(&invalid).header("X-Forwarded-For", "192.0.2.20").send(&untrusted);
    assert_eq!(first.status, 401);
    let second = Request::post(&initialize_body()).bearer(&invalid).header("X-Forwarded-For", "192.0.2.21").send(&untrusted);
    assert_eq!((second.status, second.header("retry-after")), (429, Some("60")));
}

// ---- Ported from http-limits.test.ts:750 and :787 ----

#[test]
fn sessions_expire_after_inactivity_on_a_sliding_lifetime() {
    let clock = TestClock::default();
    let server = static_server_with(json!({ "sessionTtlSeconds": 60 }), service(), clock.clone());
    let list = |id: u64| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {} });
    let idle = open_session(&server, TOKEN_A);
    let sliding = open_session(&server, TOKEN_A);
    clock.advance(59_000);
    assert_eq!(Request::post(&list(2)).bearer(TOKEN_A).session(&sliding).send(&server).status, 200);
    clock.advance(59_000);
    assert_eq!(Request::post(&list(3)).bearer(TOKEN_A).session(&sliding).send(&server).status, 200, "each request renews the lifetime");
    assert_eq!(Request::post(&list(4)).bearer(TOKEN_A).session(&idle).send(&server).status, 404, "an idle session expires");
}

#[test]
fn a_long_lived_event_stream_holds_no_request_slot() {
    let server = Arc::new(static_server(json!({ "maxConcurrentRequests": 1 })));
    let id = open_session(&server, TOKEN_A);
    let mut stream = connect(&server);
    stream.write_all(&Request::bare("GET").bearer(TOKEN_A).session(&id).bytes(&server, false)).unwrap();
    assert!(read_until(&mut stream, "\r\n\r\n").starts_with("HTTP/1.1 200"));
    let list = Request::post(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "hoi4.example" } }))
        .bearer(TOKEN_A)
        .session(&id)
        .send(&server);
    assert_eq!(list.status, 200);
}

// ---- Ported from http-streaming.test.ts:389 ----

#[test]
fn a_stream_resumes_after_its_priming_event_only_in_its_own_session() {
    let server = static_server(json!({}));
    let id = open_session(&server, TOKEN_A);
    let call = Request::post(&json!({ "jsonrpc": "2.0", "id": 42, "method": "tools/list", "params": {} })).bearer(TOKEN_A).session(&id).send(&server);
    assert_eq!(call.header("content-type"), Some("text/event-stream"));
    let priming = call.first_event_id().unwrap();
    assert_eq!(priming.len(), 36, "{priming}");
    assert!(call.body.starts_with(&format!("id: {priming}\ndata: \n\n")), "the priming event comes first: {:?}", call.body);
    assert_eq!(call.event()["id"], 42);

    let mut replay = connect(&server);
    replay.write_all(&Request::bare("GET").bearer(TOKEN_A).session(&id).header("Last-Event-ID", &priming).bytes(&server, false)).unwrap();
    let replayed = read_until(&mut replay, "\"id\":42");
    assert!(replayed.starts_with("HTTP/1.1 200"), "{replayed}");
    assert!(replayed.contains("\"id\":42") && replayed.contains("hoi4.example"), "{replayed}");
    drop(replay);

    let unknown = Request::bare("GET").bearer(TOKEN_A).session(&id).header("Last-Event-ID", "00000000-0000-4000-8000-000000000000").send(&server);
    assert_eq!((unknown.status, unknown.json()["error"]["message"].clone()), (400, json!("Event ID is unknown or expired")));
    let other = open_session(&server, TOKEN_A);
    let crossed = Request::bare("GET").bearer(TOKEN_A).session(&other).header("Last-Event-ID", &priming).send(&server);
    assert_eq!(crossed.status, 400, "another session's event cannot be replayed");

    // An older client gets no priming event, which it could not parse.
    let mut body = initialize_body();
    body["params"]["protocolVersion"] = json!("2025-06-18");
    let older = Request::post(&body).bearer(TOKEN_A).send(&server);
    assert!(older.body.starts_with("event: message\n"), "{:?}", older.body);
}
