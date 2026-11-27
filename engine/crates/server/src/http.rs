//! The Streamable HTTP transport: an HTTP/1.1 server on the standard library with every check of
//! the TypeScript transport, in the same order.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/http.ts` (`startHttpServer` and its
//! middleware chain: ambiguous headers, request-target authority, Host, Origin, media type and
//! encoding, admission and rate limits, authentication before the body, the bounded JSON body,
//! the overflow gate, Protected Resource Metadata, the POST, GET and DELETE handlers, session
//! expiry; `httpUrlHost`, `httpAllowedHostname`, `jsonRpcError`, `sendAuthError`), with the Host
//! check of `@modelcontextprotocol/sdk` `hostHeaderValidation` and the stream rules of its
//! `StreamableHTTPServerTransport`, commit 9b7dc80d.
//!
//! Not ported in this change, and refused rather than guessed: the 2026-07-28 modern protocol
//! (`routeModernRequest`; a modern claim gets the legacy refusals) and JWT signature checks
//! (an OAuth deployment needs a [`JwtVerifier`] or the server refuses to start).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::Value;
use url::Url;

use crate::auth::{
    AuthFailure, Authenticator, HttpAuthError, JwtVerifier, SecretLookup, bearer_challenge, protected_resource_metadata, validate_http_deployment,
};
use crate::config::HttpConfig;
use crate::error::ServiceError;
use crate::grants::required_scopes_for_mcp_request;
use crate::headers::{accepts_exact_media_types, has_ambiguous_security_headers, is_identity_content_encoding, is_mcp_json_content_type};
use crate::jsonrpc::{CallerContext, McpService, MessageKind, classify, is_initialize_request};
use crate::limits::{Admission, AdmissionRefusal, AdmissionTicket, RateWindows, is_control_method, rate_limit_client_address};
use crate::protocol::{check_protocol_header, negotiate};
use crate::random::random_uuid;
use crate::session::{SessionRefusal, SessionStore};

/// The largest request head (request line and header fields), as Node's default.
pub const MAX_HEADER_BYTES: usize = 16_384;
const STREAM_POLL: Duration = Duration::from_millis(250);

/// Wall-clock milliseconds since the Unix epoch. Session lifetimes, credential expiry and rate
/// windows read it; socket deadlines use the monotonic clock instead.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The system wall clock.
pub fn system_clock() -> Clock {
    Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64))
}

/// A configured bind host as it appears in an authority: IPv6 in brackets.
pub fn http_url_host(host: &str) -> String {
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) { format!("[{host}]") } else { host.to_owned() }
}

/// The WHATWG hostname of an authority, as `new URL('http://' + authority).hostname`.
pub fn authority_hostname(authority: &str) -> Option<String> {
    let url = Url::parse(&format!("http://{authority}")).ok()?;
    if !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    url.host_str().map(str::to_owned)
}

/// One parsed request head.
#[derive(Debug)]
struct Head {
    method: String,
    target: String,
    http10: bool,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn header_count(&self, name: &str) -> usize {
        self.headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case(name)).count()
    }

    /// The path of an origin-form or absolute-form target, without its query.
    fn path(&self) -> String {
        let raw =
            if self.target.starts_with('/') { self.target.clone() } else { Url::parse(&self.target).map(|url| url.path().to_owned()).unwrap_or_default() };
        raw.split(['?', '#']).next().unwrap_or_default().to_owned()
    }
}

fn is_header_token(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
}

enum HeadError {
    Closed,
    TooLarge,
    Malformed,
    TimedOut,
}

fn read_head(reader: &mut BufReader<TcpStream>, deadline: &Deadline) -> Result<Head, HeadError> {
    let mut raw = Vec::new();
    loop {
        // One deadline covers the whole head, so a slow sender cannot renew it byte by byte.
        if deadline.arm(reader.get_ref()).is_err() {
            return Err(HeadError::TimedOut);
        }
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Err(HeadError::TimedOut),
            Err(_) => return Err(HeadError::Closed),
        };
        if available.is_empty() {
            return Err(if raw.is_empty() { HeadError::Closed } else { HeadError::Malformed });
        }
        let take = available.len().min(MAX_HEADER_BYTES + 4 - raw.len().min(MAX_HEADER_BYTES + 4));
        let start = raw.len().saturating_sub(3);
        raw.extend_from_slice(&available[..take]);
        if let Some(end) = raw[start..].windows(4).position(|window| window == b"\r\n\r\n").map(|at| start + at + 4) {
            let consumed = end - (raw.len() - take);
            reader.consume(consumed);
            raw.truncate(end);
            break;
        }
        reader.consume(take);
        if raw.len() > MAX_HEADER_BYTES {
            return Err(HeadError::TooLarge);
        }
    }
    if raw.len() > MAX_HEADER_BYTES {
        return Err(HeadError::TooLarge);
    }
    let text = std::str::from_utf8(&raw[..raw.len() - 4]).map_err(|_| HeadError::Malformed)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(HeadError::Malformed)?;
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(HeadError::Malformed) };
    if !is_header_token(method) || target.is_empty() || target.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
        return Err(HeadError::Malformed);
    }
    let http10 = match version {
        "HTTP/1.1" => false,
        "HTTP/1.0" => true,
        _ => return Err(HeadError::Malformed),
    };
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(HeadError::Malformed)?;
        if !is_header_token(name) || value.bytes().any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f) {
            return Err(HeadError::Malformed);
        }
        headers.push((name.to_owned(), value.trim_matches([' ', '\t']).to_owned()));
    }
    Ok(Head { method: method.to_owned(), target: target.to_owned(), http10, headers })
}

/// One response. Bodies are small JSON documents; event streams are written separately.
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    close: bool,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        _ => "Internal Server Error",
    }
}

fn json_string(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

impl Reply {
    fn json(status: u16, body: String) -> Self {
        Self { status, headers: vec![("Content-Type", "application/json; charset=utf-8".to_owned())], body: body.into_bytes(), close: false }
    }

    /// `{"jsonrpc":"2.0","error":{"code":…,"message":…},"id":null}` in Express key order.
    fn json_rpc_error(status: u16, message: &str, code: i64) -> Self {
        Self::json(status, format!("{{\"jsonrpc\":\"2.0\",\"error\":{{\"code\":{code},\"message\":{}}},\"id\":null}}", json_string(message)))
    }

    fn error_code(status: u16, code: &str) -> Self {
        Self::json(status, format!("{{\"error\":{}}}", json_string(code)))
    }

    fn retry_after(mut self, seconds: &str) -> Self {
        self.headers.push(("Retry-After", seconds.to_owned()));
        self
    }

    fn empty(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new(), close: false }
    }

    fn plain(status: u16, text: &str) -> Self {
        Self { status, headers: vec![("Content-Type", "text/plain; charset=utf-8".to_owned())], body: text.as_bytes().to_vec(), close: false }
    }
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", reply.status, reason(reply.status));
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
    head.push_str(if reply.close { "Connection: close\r\n\r\n" } else { "Connection: keep-alive\r\n\r\n" });
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    stream.flush()
}

/// Writes the head of an event stream; events follow as chunks.
fn write_stream_head(stream: &mut TcpStream, session_id: Option<&str>) -> std::io::Result<()> {
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n",
    );
    if let Some(id) = session_id {
        head.push_str(&format!("mcp-session-id: {id}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_event(stream: &mut TcpStream, event_id: &str, message: &Value) -> std::io::Result<()> {
    let data = format!("event: message\nid: {event_id}\ndata: {message}\n\n");
    stream.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
    stream.write_all(data.as_bytes())?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn end_stream(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n")?;
    stream.flush()
}

/// How a request body is framed.
enum Framing {
    None,
    Length(u64),
    Chunked,
}

fn body_framing(head: &Head) -> Result<Framing, Reply> {
    let lengths: Vec<&str> = head.headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.as_str()).collect();
    let encodings = head.header_count("transfer-encoding");
    if encodings > 0 {
        // A message with both framings, or any encoding but plain chunked, is a smuggling risk.
        if !lengths.is_empty() || encodings > 1 || !head.header("transfer-encoding").is_some_and(|value| value.eq_ignore_ascii_case("chunked")) {
            let mut reply = Reply::json_rpc_error(400, "Ambiguous or unsupported request body framing", -32_000);
            reply.close = true;
            return Err(reply);
        }
        return Ok(Framing::Chunked);
    }
    match lengths.as_slice() {
        [] => Ok(Framing::None),
        [value] if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value.parse().map(Framing::Length).map_err(|_| Reply::json_rpc_error(413, "Payload too large", -32_000))
        }
        _ => {
            let mut reply = Reply::json_rpc_error(400, "Ambiguous or unsupported request body framing", -32_000);
            reply.close = true;
            Err(reply)
        }
    }
}

enum BodyError {
    TooLarge,
    /// Chunked framing that is not valid HTTP/1.1.
    Malformed,
    Io,
}

struct Deadline(Instant);

impl Deadline {
    fn arm(&self, stream: &TcpStream) -> Result<(), BodyError> {
        let remaining = self.0.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()).ok_or(BodyError::Io)?;
        stream.set_read_timeout(Some(remaining)).map_err(|_| BodyError::Io)
    }
}

fn read_exact_bounded(reader: &mut BufReader<TcpStream>, deadline: &Deadline, length: usize, body: &mut Vec<u8>) -> Result<(), BodyError> {
    let target = body.len().checked_add(length).ok_or(BodyError::TooLarge)?;
    while body.len() < target {
        deadline.arm(reader.get_ref())?;
        let mut chunk = [0u8; 8192];
        let want = (target - body.len()).min(chunk.len());
        let read = reader.read(&mut chunk[..want]).map_err(|_| BodyError::Io)?;
        if read == 0 {
            return Err(BodyError::Io);
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(())
}

fn read_line_bounded(reader: &mut BufReader<TcpStream>, deadline: &Deadline) -> Result<String, BodyError> {
    let mut line = Vec::new();
    loop {
        deadline.arm(reader.get_ref())?;
        let mut byte = [0u8; 1];
        if reader.read(&mut byte).map_err(|_| BodyError::Io)? == 0 {
            return Err(BodyError::Io);
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > 4096 {
            return Err(BodyError::Io);
        }
    }
    let text = String::from_utf8(line).map_err(|_| BodyError::Io)?;
    Ok(text.strip_suffix('\r').unwrap_or(&text).to_owned())
}

fn read_body(reader: &mut BufReader<TcpStream>, framing: &Framing, limit: u64, deadline: &Deadline) -> Result<Vec<u8>, BodyError> {
    let mut body = Vec::new();
    match framing {
        Framing::None => {}
        Framing::Length(length) => {
            if *length > limit {
                return Err(BodyError::TooLarge);
            }
            read_exact_bounded(reader, deadline, *length as usize, &mut body)?;
        }
        Framing::Chunked => loop {
            let line = read_line_bounded(reader, deadline)?;
            let size_text = line.split(';').next().unwrap_or_default().trim();
            if size_text.is_empty() || !size_text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(BodyError::Malformed);
            }
            // A size beyond u64 is larger than any limit.
            let size = u64::from_str_radix(size_text, 16).map_err(|_| BodyError::TooLarge)?;
            if size == 0 {
                // Trailers are read and ignored.
                while !read_line_bounded(reader, deadline)?.is_empty() {}
                break;
            }
            if (body.len() as u64).checked_add(size).is_none_or(|total| total > limit) {
                return Err(BodyError::TooLarge);
            }
            read_exact_bounded(reader, deadline, size as usize, &mut body)?;
            if !read_line_bounded(reader, deadline)?.is_empty() {
                return Err(BodyError::Malformed);
            }
        },
    }
    Ok(body)
}

/// Everything a running server shares between its connections.
struct Shared {
    config: HttpConfig,
    allowed_hosts: Vec<String>,
    allowed_origins: Vec<String>,
    authenticator: Authenticator,
    admission: Admission,
    pre_auth_rates: RateWindows,
    rates: RateWindows,
    sessions: SessionStore,
    service: Arc<dyn McpService>,
    metadata: Option<String>,
    shutdown: AtomicBool,
    connections: AtomicU64,
    clock: Clock,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        (self.clock)()
    }
}

/// A running Streamable HTTP server.
pub struct HttpServerHandle {
    shared: Arc<Shared>,
    address: SocketAddr,
    url: String,
    accept: Option<JoinHandle<()>>,
    cleanup: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for HttpServerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpServerHandle").field("address", &self.address).field("url", &self.url).finish()
    }
}

impl HttpServerHandle {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The endpoint URL: the public URL's `/mcp` when configured, else the bound address.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The number of live sessions.
    pub fn session_count(&self) -> usize {
        self.shared.sessions.len()
    }

    /// Stops accepting, closes every session and waits for the accept and cleanup threads.
    pub fn close(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        if self.shared.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        // Wake the blocking accept.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(1));
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
        if let Some(cleanup) = self.cleanup.take() {
            let _ = cleanup.join();
        }
        self.shared.sessions.prune(u64::MAX);
    }
}

impl Drop for HttpServerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts the server after the deployment checks. `secrets` reads the static-token environment
/// variables; `verifier` checks JWT signatures and is required when OAuth is configured.
pub fn start_http_server(
    config: HttpConfig,
    secrets: SecretLookup<'_>,
    verifier: Option<Box<dyn JwtVerifier>>,
    service: Arc<dyn McpService>,
) -> Result<HttpServerHandle, ServiceError> {
    start_http_server_with_clock(config, secrets, verifier, service, system_clock())
}

/// [`start_http_server`] with the wall clock it reads, so tests can move time forward instead
/// of sleeping through a session lifetime.
pub fn start_http_server_with_clock(
    config: HttpConfig,
    secrets: SecretLookup<'_>,
    verifier: Option<Box<dyn JwtVerifier>>,
    service: Arc<dyn McpService>,
    clock: Clock,
) -> Result<HttpServerHandle, ServiceError> {
    config.validate()?;
    validate_http_deployment(&config, secrets)?;
    if config.oauth.is_some() && verifier.is_none() {
        return Err(ServiceError::new("HTTP_OAUTH_VERIFIER_UNAVAILABLE", "OAuth Streamable HTTP needs a JWT verifier, which this build does not have yet"));
    }
    let mut allowed_hosts = vec![
        authority_hostname(&http_url_host(&config.host))
            .ok_or_else(|| ServiceError::new("HTTP_HOST_INVALID", "The configured HTTP host is not a valid hostname"))?,
    ];
    if let Some(public_url) = &config.public_url {
        let url = Url::parse(public_url).map_err(|_| ServiceError::new("HTTP_PUBLIC_URL_INVALID", "Streamable HTTP publicUrl must be a URL"))?;
        if let Some(host) = url.host_str() {
            allowed_hosts.push(host.to_owned());
        }
    }
    allowed_hosts.dedup();
    let allowed_origins = config.allowed_origins.iter().filter_map(|origin| Url::parse(origin).ok()).map(|url| url.origin().ascii_serialization()).collect();
    let metadata = match (&config.oauth, &config.public_url) {
        (Some(_), Some(_)) => Some(protected_resource_metadata(&config)?.to_string()),
        _ => None,
    };
    let listener = TcpListener::bind((config.host.trim_start_matches('[').trim_end_matches(']'), config.port))
        .map_err(|error| ServiceError::new("HTTP_LISTEN_FAILED", format!("Unable to listen: {}", error.kind())))?;
    let address = listener.local_addr().map_err(|error| ServiceError::new("HTTP_LISTEN_FAILED", error.kind().to_string()))?;
    let url = match &config.public_url {
        Some(public_url) => Url::parse(public_url).and_then(|url| url.join("/mcp")).map(String::from).unwrap_or_default(),
        None => format!("http://{}:{}/mcp", http_url_host(&config.host), address.port()),
    };
    let shared = Arc::new(Shared {
        allowed_hosts,
        allowed_origins,
        authenticator: Authenticator::new(&config, secrets, verifier),
        admission: Admission::new(&config),
        pre_auth_rates: RateWindows::new(config.requests_per_minute),
        rates: RateWindows::new(config.requests_per_minute),
        sessions: SessionStore::new(&config),
        service,
        metadata,
        shutdown: AtomicBool::new(false),
        connections: AtomicU64::new(0),
        clock,
        config,
    });
    let accept_shared = Arc::clone(&shared);
    let accept = std::thread::Builder::new()
        .name("hoi4-http-accept".to_owned())
        .spawn(move || accept_loop(&listener, &accept_shared))
        .map_err(|_| ServiceError::new("HTTP_LISTEN_FAILED", "Unable to start the accept thread"))?;
    let cleanup_shared = Arc::clone(&shared);
    let cleanup = std::thread::Builder::new()
        .name("hoi4-http-sessions".to_owned())
        .spawn(move || {
            let interval = Duration::from_millis(60_000u64.min(cleanup_shared.config.session_ttl_seconds * 1000));
            let mut last = Instant::now();
            while !cleanup_shared.shutdown.load(Ordering::SeqCst) {
                std::thread::sleep(STREAM_POLL);
                if last.elapsed() >= interval {
                    cleanup_shared.sessions.prune(cleanup_shared.now_ms());
                    last = Instant::now();
                }
            }
        })
        .map_err(|_| ServiceError::new("HTTP_LISTEN_FAILED", "Unable to start the session thread"))?;
    Ok(HttpServerHandle { shared, address, url, accept: Some(accept), cleanup: Some(cleanup) })
}

struct ConnectionSlot<'a>(&'a AtomicU64);

impl Drop for ConnectionSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn accept_loop(listener: &TcpListener, shared: &Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.shutdown.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        // Over the connection limit, the socket is dropped unanswered, as Node does.
        if shared.connections.fetch_add(1, Ordering::SeqCst) >= shared.config.max_connections {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }
        let connection_shared = Arc::clone(shared);
        let spawned = std::thread::Builder::new().name("hoi4-http-connection".to_owned()).spawn(move || {
            let _slot = ConnectionSlot(&connection_shared.connections);
            serve_connection(stream, &connection_shared);
        });
        if spawned.is_err() {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn serve_connection(stream: TcpStream, shared: &Shared) {
    let Ok(peer) = stream.peer_addr() else { return };
    let Ok(write_half) = stream.try_clone() else { return };
    let mut writer = write_half;
    let mut reader = BufReader::new(stream);
    let mut served = 0u64;
    loop {
        if shared.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let wait = if served == 0 { shared.config.headers_timeout_ms } else { shared.config.keep_alive_timeout_ms };
        if reader.get_ref().set_read_timeout(Some(Duration::from_millis(wait))).is_err() {
            return;
        }
        // The first byte of a request starts its header and complete-request clocks.
        if !matches!(reader.fill_buf(), Ok(bytes) if !bytes.is_empty()) {
            return;
        }
        let started = Instant::now();
        let header_deadline = Deadline(started + Duration::from_millis(shared.config.headers_timeout_ms));
        let head = match read_head(&mut reader, &header_deadline) {
            Ok(head) => head,
            Err(HeadError::Closed) => return,
            Err(HeadError::TimedOut) => {
                let mut reply = Reply::plain(408, "Request Timeout");
                reply.close = true;
                let _ = write_reply(&mut writer, &reply);
                return;
            }
            Err(HeadError::TooLarge) => {
                let mut reply = Reply::plain(431, "Request Header Fields Too Large");
                reply.close = true;
                let _ = write_reply(&mut writer, &reply);
                let _ = writer.shutdown(Shutdown::Write);
                drain(&mut reader);
                return;
            }
            Err(HeadError::Malformed) => {
                let mut reply = Reply::plain(400, "Bad Request");
                reply.close = true;
                let _ = write_reply(&mut writer, &reply);
                return;
            }
        };
        served += 1;
        let deadline = Deadline(started + Duration::from_millis(shared.config.request_timeout_ms));
        let outcome = handle_request(&head, &mut reader, &mut writer, peer, shared, &deadline);
        let last = head.http10
            || served >= shared.config.max_requests_per_socket
            || head.header("connection").is_some_and(|value| value.eq_ignore_ascii_case("close"));
        match outcome {
            Outcome::Reply(mut reply) => {
                reply.close |= last;
                if write_reply(&mut writer, &reply).is_err() || reply.close {
                    let _ = writer.shutdown(Shutdown::Write);
                    drain(&mut reader);
                    return;
                }
            }
            Outcome::Streamed { keep_alive } => {
                if !keep_alive || last {
                    let _ = writer.shutdown(Shutdown::Write);
                    return;
                }
            }
        }
    }
}

/// Reads and discards what the client still sends after a refusal, briefly and boundedly, so
/// closing a socket with unread input does not reset the connection before the client reads the
/// refusal.
fn drain(reader: &mut BufReader<TcpStream>) {
    let until = Instant::now() + Duration::from_millis(500);
    let mut discarded = 0usize;
    let mut buffer = [0u8; 8192];
    while discarded < 4 * 1_048_576 {
        let Some(left) = until.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) else { return };
        if reader.get_ref().set_read_timeout(Some(left)).is_err() {
            return;
        }
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => discarded += read,
        }
    }
}

enum Outcome {
    Reply(Reply),
    Streamed { keep_alive: bool },
}

impl From<Reply> for Outcome {
    fn from(reply: Reply) -> Self {
        Self::Reply(reply)
    }
}

fn auth_reply(config: &HttpConfig, error: &HttpAuthError) -> Reply {
    let mut reply = Reply::error_code(error.status, error.code);
    reply.headers.push(("WWW-Authenticate", bearer_challenge(config, error.bearer_error, &error.required_scopes)));
    reply
}

fn auth_failure_reply(config: &HttpConfig, failure: AuthFailure, required: &[String]) -> Reply {
    match failure {
        AuthFailure::Http(error) => auth_reply(config, &error),
        AuthFailure::Service(_) => {
            auth_reply(config, &HttpAuthError::new(401, "AUTH_INVALID", "Authentication failed", Some(crate::auth::BearerError::InvalidToken), required))
        }
    }
}

fn session_refusal_reply(config: &HttpConfig, refusal: SessionRefusal) -> Reply {
    match refusal {
        SessionRefusal::JsonRpc(status, message) => Reply::json_rpc_error(status, message, -32_000),
        SessionRefusal::Code(status, code) => Reply::error_code(status, code),
        SessionRefusal::Auth { status, code, bearer_error, required_scopes } => {
            auth_reply(config, &HttpAuthError::new(status, code, "", Some(bearer_error), &required_scopes))
        }
    }
}

/// The request-target check: origin-form passes; absolute-form must name an allowed host whose
/// authority equals `Host`.
fn check_request_target(head: &Head, allowed_hosts: &[String]) -> Result<(), Reply> {
    if head.target.starts_with('/') {
        return Ok(());
    }
    let lower = head.target.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(Reply::json_rpc_error(400, "Unsupported HTTP request-target form", -32_000));
    }
    let refused = || Reply::json_rpc_error(400, "Absolute request-target authority does not match Host", -32_000);
    let target = Url::parse(&head.target).map_err(|_| refused())?;
    let host = head.header("host").ok_or_else(refused)?;
    let header_authority = Url::parse(&format!("{}://{host}", target.scheme())).map_err(|_| refused())?;
    let authority = |url: &Url| format!("{}{}", url.host_str().unwrap_or_default(), url.port().map(|port| format!(":{port}")).unwrap_or_default());
    let hostname = target.host_str().unwrap_or_default().to_ascii_lowercase();
    if !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || !allowed_hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(&hostname))
        || !authority(&target).eq_ignore_ascii_case(&authority(&header_authority))
    {
        return Err(refused());
    }
    Ok(())
}

fn check_host(head: &Head, allowed_hosts: &[String]) -> Result<(), Reply> {
    let Some(host) = head.header("host").filter(|host| !host.is_empty()) else { return Err(Reply::json_rpc_error(403, "Missing Host header", -32_000)) };
    let Some(hostname) = authority_hostname(host) else { return Err(Reply::json_rpc_error(403, &format!("Invalid Host header: {host}"), -32_000)) };
    if !allowed_hosts.contains(&hostname) {
        return Err(Reply::json_rpc_error(403, &format!("Invalid Host: {hostname}"), -32_000));
    }
    Ok(())
}

fn is_mcp_path(path: &str) -> bool {
    path.eq_ignore_ascii_case("/mcp") || path.eq_ignore_ascii_case("/mcp/")
}

fn admission_reply(refusal: AdmissionRefusal) -> Reply {
    match refusal {
        AdmissionRefusal::PayloadTooLarge => Reply::json_rpc_error(413, "Payload too large", -32_000),
        AdmissionRefusal::ConcurrencyLimit => Reply::error_code(429, "concurrency_limit").retry_after("1"),
        AdmissionRefusal::BodyCapacityLimit => Reply::error_code(429, "body_capacity_limit").retry_after("1"),
    }
}

/// Handles one request. The body framing is worked out first, and a request whose body is left
/// unread never keeps its connection: the unread bytes would otherwise be parsed as the next
/// request on the socket (a desync that mixes up responses behind a connection-reusing proxy).
fn handle_request(head: &Head, reader: &mut BufReader<TcpStream>, writer: &mut TcpStream, peer: SocketAddr, shared: &Shared, deadline: &Deadline) -> Outcome {
    let framing = match body_framing(head) {
        Ok(framing) => framing,
        Err(mut reply) => {
            reply.close = true;
            return reply.into();
        }
    };
    let mut consumed = matches!(framing, Framing::None | Framing::Length(0));
    let outcome = handle_framed_request(head, &framing, &mut consumed, reader, writer, peer, shared, deadline);
    if consumed {
        return outcome;
    }
    match outcome {
        Outcome::Reply(mut reply) => {
            reply.close = true;
            Outcome::Reply(reply)
        }
        Outcome::Streamed { .. } => Outcome::Streamed { keep_alive: false },
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_framed_request(
    head: &Head,
    framing: &Framing,
    consumed: &mut bool,
    reader: &mut BufReader<TcpStream>,
    writer: &mut TcpStream,
    peer: SocketAddr,
    shared: &Shared,
    deadline: &Deadline,
) -> Outcome {
    let config = &shared.config;
    let names = head.headers.iter().map(|(name, _)| name.as_str());
    if has_ambiguous_security_headers(names) {
        return Reply::json_rpc_error(400, "Ambiguous or duplicate security-sensitive HTTP header", -32_000).into();
    }
    if let Err(reply) = check_request_target(head, &shared.allowed_hosts) {
        return reply.into();
    }
    if let Err(reply) = check_host(head, &shared.allowed_hosts) {
        return reply.into();
    }
    if let Some(origin) = head.header("origin")
        && !shared.allowed_origins.iter().any(|allowed| allowed == origin)
    {
        return Reply::error_code(403, "origin_not_allowed").into();
    }
    let path = head.path();
    let mcp = is_mcp_path(&path);
    let method = head.method.as_str();
    if mcp && method == "POST" {
        if !is_mcp_json_content_type(head.header("content-type")) {
            return Reply::json_rpc_error(415, "Unsupported Media Type: Content-Type must be UTF-8 application/json", -32_000).into();
        }
        if !is_identity_content_encoding(head.header("content-encoding")) {
            return Reply::json_rpc_error(415, "Unsupported Media Type: Content-Encoding must be identity", -32_000).into();
        }
    }
    // A chunked POST declares no length, so it reserves the whole body limit.
    let declared = match framing {
        Framing::Length(length) => Some(length.to_string()),
        Framing::None | Framing::Chunked => None,
    };
    let mut ticket = match shared.admission.admit(method == "POST", declared.as_deref()) {
        Ok(ticket) => ticket,
        Err(refusal) => return Outcome::from(admission_reply(refusal)),
    };
    let socket = match peer.ip() {
        std::net::IpAddr::V4(address) => address.to_string(),
        std::net::IpAddr::V6(address) => address.to_string(),
    };
    let Some(client) = rate_limit_client_address(&socket, head.header("x-forwarded-for"), &config.trusted_proxy_addresses) else {
        return Outcome::from(Reply::error_code(400, "invalid_forwarded_for"));
    };
    if !shared.pre_auth_rates.hit(&client, shared.now_ms()) {
        return Outcome::from(Reply::error_code(429, "rate_limit").retry_after("60"));
    }
    let base_scopes = required_scopes_for_mcp_request(config, None);
    let now_seconds = shared.now_ms() as f64 / 1000.0;
    if mcp && !matches!(method, "GET" | "POST" | "DELETE") {
        // Authentication, then the per-principal rate, as `authenticateMiddleware` runs first.
        let reply = match authenticate_request(head, None, shared, now_seconds) {
            Ok(_) => {
                let mut reply = Reply::json_rpc_error(405, "Method not allowed.", -32_000);
                reply.headers.push(("Allow", "GET, POST, DELETE".to_owned()));
                reply
            }
            Err(reply) => reply,
        };
        return Outcome::from(reply);
    }
    let mut body: Option<Value> = None;
    if mcp && method == "POST" {
        // Authenticate before reading the body, so an unauthenticated caller cannot hold a slot
        // and body budget while it sends one slowly.
        if let Err(failure) = shared.authenticator.authenticate(head.header("authorization"), &base_scopes, now_seconds) {
            return Outcome::from(auth_failure_reply(config, failure, &base_scopes));
        }
        let bytes = match read_body(reader, framing, config.max_body_bytes, deadline) {
            Ok(bytes) => {
                *consumed = true;
                bytes
            }
            Err(BodyError::TooLarge) => {
                let mut reply = Reply::json_rpc_error(413, "Payload too large", -32_000);
                reply.close = true;
                return reply.into();
            }
            Err(BodyError::Malformed) => {
                let mut reply = Reply::json_rpc_error(400, "Malformed chunked request body", -32_000);
                reply.close = true;
                return reply.into();
            }
            Err(BodyError::Io) => {
                let mut reply = Reply::plain(408, "Request Timeout");
                reply.close = true;
                return reply.into();
            }
        };
        let Ok(text) = std::str::from_utf8(&bytes) else { return Reply::json_rpc_error(400, "Parse error: Invalid UTF-8 JSON", -32_700).into() };
        let trimmed = text.trim_start_matches([' ', '\t', '\n', '\r']);
        let parsed = if trimmed.is_empty() {
            Some(Value::Object(serde_json::Map::new()))
        } else if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
            None
        } else {
            serde_json::from_str::<Value>(text).ok()
        };
        let Some(parsed) = parsed else { return Reply::json_rpc_error(400, "Parse error: Invalid JSON", -32_700).into() };
        let rpc_method = parsed.get("method").and_then(Value::as_str);
        let control = parsed.get("method").is_none() || is_control_method(rpc_method);
        if ticket.overflow && (!control || parsed.get("method").is_some_and(|method| !method.is_string())) {
            return Reply::error_code(429, "concurrency_limit").retry_after("1").into();
        }
        body = Some(parsed);
    } else if !*consumed {
        // Only an MCP POST reads a body; any other request with one cannot keep the connection.
        let mut reply = route_bodyless(head, &path, mcp, shared, &mut ticket, writer, now_seconds);
        if let Outcome::Reply(reply) = &mut reply {
            reply.close = true;
        }
        return reply;
    }
    if mcp && method == "POST" {
        return handle_post(head, body.unwrap_or(Value::Null), writer, shared, now_seconds);
    }
    route_bodyless(head, &path, mcp, shared, &mut ticket, writer, now_seconds)
}

fn route_bodyless(head: &Head, path: &str, mcp: bool, shared: &Shared, ticket: &mut AdmissionTicket, writer: &mut TcpStream, now_seconds: f64) -> Outcome {
    let method = head.method.as_str();
    if method == "GET"
        && let Some(metadata) = &shared.metadata
        && (path.eq_ignore_ascii_case("/.well-known/oauth-protected-resource") || path.eq_ignore_ascii_case("/.well-known/oauth-protected-resource/mcp"))
    {
        return Reply::json(200, metadata.clone()).into();
    }
    if !mcp {
        return Reply::plain(404, &format!("Cannot {method} {path}")).into();
    }
    match method {
        "GET" => handle_get(head, writer, shared, ticket, now_seconds),
        "DELETE" => handle_delete(head, shared, now_seconds),
        _ => Reply::plain(404, &format!("Cannot {method} {path}")).into(),
    }
}

/// Full authentication with the scopes of the parsed body, then the per-principal rate.
fn authenticate_request(head: &Head, body: Option<&Value>, shared: &Shared, now_seconds: f64) -> Result<crate::auth::AuthenticatedPrincipal, Reply> {
    let required = required_scopes_for_mcp_request(&shared.config, body);
    let principal = shared
        .authenticator
        .authenticate(head.header("authorization"), &required, now_seconds)
        .map_err(|failure| auth_failure_reply(&shared.config, failure, &required))?;
    if !shared.rates.hit(&principal.principal, shared.now_ms()) {
        return Err(Reply::error_code(429, "rate_limit").retry_after("60"));
    }
    Ok(principal)
}

struct SessionRequest<'a> {
    shared: &'a Shared,
    id: String,
}

impl Drop for SessionRequest<'_> {
    fn drop(&mut self) {
        self.shared.sessions.finish(&self.id, self.shared.now_ms());
    }
}

/// The caller of an authenticated HTTP request: always its principal and the credential's scopes,
/// never a default. A default `CallerContext` has no principal, which is the trusted stdio caller.
fn caller_for(principal: &crate::auth::AuthenticatedPrincipal) -> CallerContext {
    CallerContext { principal: Some(principal.principal.clone()), scopes: principal.scopes.clone() }
}

/// The revision a POST speaks for the priming decision: the `initialize` request's own, else the
/// header, else the SDK's `DEFAULT_NEGOTIATED_PROTOCOL_VERSION`.
fn post_protocol_version<'a>(head: &'a Head, body: &'a Value) -> &'a str {
    if is_initialize_request(body) {
        return body.get("params").and_then(|params| params.get("protocolVersion")).and_then(Value::as_str).unwrap_or_default();
    }
    head.header("mcp-protocol-version").unwrap_or(DEFAULT_NEGOTIATED_PROTOCOL_VERSION)
}

/// The first revision whose clients accept the empty-data priming event.
const PRIMING_PROTOCOL_VERSION: &str = "2025-11-25";
const DEFAULT_NEGOTIATED_PROTOCOL_VERSION: &str = "2025-03-26";

/// Answers on a new event stream of a session. As the SDK's `writePrimingEvent`, a client at
/// 2025-11-25 or later first gets a stored priming event (an id with empty data) to resume from.
fn stream_answer(writer: &mut TcpStream, shared: &Shared, session_id: &str, answer: &Value, protocol_version: &str) -> Outcome {
    let stream_id = random_uuid();
    let now = shared.now_ms();
    let (priming, event_id) = shared
        .sessions
        .with_session(session_id, |session| {
            let priming = (protocol_version >= PRIMING_PROTOCOL_VERSION)
                .then(|| session.event_store.store_event(&stream_id, &Value::Object(serde_json::Map::new()), now));
            (priming, session.event_store.store_event(&stream_id, answer, now))
        })
        .unwrap_or_else(|| (None, random_uuid()));
    let mut written = write_stream_head(writer, Some(session_id));
    if let Some(priming) = &priming {
        written = written.and_then(|()| write_priming_event(writer, priming));
    }
    let written = written.and_then(|()| write_event(writer, &event_id, answer)).and_then(|()| end_stream(writer));
    Outcome::Streamed { keep_alive: written.is_ok() }
}

fn write_priming_event(stream: &mut TcpStream, event_id: &str) -> std::io::Result<()> {
    let data = format!("id: {event_id}\ndata: \n\n");
    stream.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
    stream.write_all(data.as_bytes())?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn handle_post(head: &Head, body: Value, writer: &mut TcpStream, shared: &Shared, now_seconds: f64) -> Outcome {
    let config = &shared.config;
    let principal = match authenticate_request(head, Some(&body), shared, now_seconds) {
        Ok(principal) => principal,
        Err(reply) => return reply.into(),
    };
    let session_header = head.header("mcp-session-id");
    if let Err(message) = check_protocol_header(head.header("mcp-protocol-version"), session_header.is_some()) {
        return Reply::json_rpc_error(400, &message, -32_000).into();
    }
    if body.is_array() {
        return Reply::json_rpc_error(400, "JSON-RPC batching is not supported", -32_000).into();
    }
    let both = ["application/json", "text/event-stream"];
    let now = shared.now_ms();
    if session_header.is_none() {
        if !is_initialize_request(&body) {
            return Reply::json_rpc_error(400, "No valid session ID or initialize request", -32_000).into();
        }
        if !accepts_exact_media_types(head.header("accept"), &both) {
            return Reply::json_rpc_error(406, "Not Acceptable: Accept must include application/json and text/event-stream", -32_000).into();
        }
        let required = required_scopes_for_mcp_request(config, Some(&body));
        let pending = match shared.sessions.reserve(&principal, &required, now) {
            Ok(pending) => pending,
            Err(refusal) => return session_refusal_reply(config, refusal).into(),
        };
        let caller = caller_for(&principal);
        let Some(answer) = shared.service.handle(&body, &caller) else { return Reply::json_rpc_error(500, "Internal server error", -32_000).into() };
        if answer.get("result").is_none() {
            // A failed initialize opens no session.
            drop(pending);
            return write_unsessioned_answer(writer, &answer);
        }
        let requested = body.get("params").and_then(|params| params.get("protocolVersion")).and_then(Value::as_str);
        let id = shared.sessions.open(pending, negotiate(requested), now);
        return stream_answer(writer, shared, &id, &answer, post_protocol_version(head, &body));
    }
    let id = match shared.sessions.begin(session_header, &principal, now) {
        Ok(id) => id,
        Err(refusal) => return session_refusal_reply(config, refusal).into(),
    };
    let request = SessionRequest { shared, id };
    if !accepts_exact_media_types(head.header("accept"), &both) {
        return Reply::json_rpc_error(406, "Not Acceptable: Accept must include application/json and text/event-stream", -32_000).into();
    }
    let Some(kind) = classify(&body) else { return Reply::json_rpc_error(400, "Parse error: Invalid JSON-RPC message", -32_700).into() };
    if is_initialize_request(&body) {
        return Reply::json_rpc_error(400, "Invalid Request: Server already initialized", -32_600).into();
    }
    // `begin` checked this credential against the session. The caller comes from the credential,
    // so a session removed meanwhile cannot turn the request into an ungranted one.
    let caller = caller_for(&principal);
    let answer = shared.service.handle(&body, &caller);
    match (kind, answer) {
        (MessageKind::Request, Some(answer)) => stream_answer(writer, shared, &request.id, &answer, post_protocol_version(head, &body)),
        (MessageKind::Request, None) => Reply::json_rpc_error(500, "Internal server error", -32_000).into(),
        _ => Reply::empty(202).into(),
    }
}

fn write_unsessioned_answer(writer: &mut TcpStream, answer: &Value) -> Outcome {
    let written = write_stream_head(writer, None).and_then(|()| write_event(writer, &random_uuid(), answer)).and_then(|()| end_stream(writer));
    Outcome::Streamed { keep_alive: written.is_ok() }
}

/// True while the peer keeps the connection open; reads nothing it would need later.
fn peer_open(stream: &TcpStream) -> bool {
    if stream.set_read_timeout(Some(Duration::from_millis(1))).is_err() {
        return false;
    }
    let mut probe = [0u8; 1];
    match stream.peek(&mut probe) {
        Ok(0) => false,
        Ok(_) => true,
        Err(error) => matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted),
    }
}

fn handle_get(head: &Head, writer: &mut TcpStream, shared: &Shared, ticket: &mut AdmissionTicket, now_seconds: f64) -> Outcome {
    let config = &shared.config;
    let principal = match authenticate_request(head, None, shared, now_seconds) {
        Ok(principal) => principal,
        Err(reply) => return reply.into(),
    };
    if let Err(message) = check_protocol_header(head.header("mcp-protocol-version"), true) {
        return Reply::json_rpc_error(400, &message, -32_000).into();
    }
    let id = match shared.sessions.begin(head.header("mcp-session-id"), &principal, shared.now_ms()) {
        Ok(id) => id,
        Err(refusal) => return session_refusal_reply(config, refusal).into(),
    };
    let request = SessionRequest { shared, id };
    if !accepts_exact_media_types(head.header("accept"), &["text/event-stream"]) {
        return Reply::json_rpc_error(406, "Not Acceptable: Accept must include text/event-stream", -32_000).into();
    }
    let _stream_slot = match shared.sessions.open_stream(&principal.principal) {
        Ok(slot) => slot,
        Err(SessionRefusal::Code(status, code)) => return Reply::error_code(status, code).retry_after("1").into(),
        Err(refusal) => return session_refusal_reply(config, refusal).into(),
    };
    // A long-lived stream holds no request slot.
    ticket.release();
    let replay = match head.header("last-event-id") {
        Some(last) => match shared.sessions.with_session(&request.id, |session| session.event_store.replay_events_after(last, shared.now_ms())) {
            Some(Ok((_, events))) => events,
            _ => return Reply::json_rpc_error(400, "Event ID is unknown or expired", -32_000).into(),
        },
        None => Vec::new(),
    };
    let claimed = shared.sessions.with_session(&request.id, |session| !std::mem::replace(&mut session.standalone_stream, true)).unwrap_or(false);
    if !claimed {
        return Reply::json_rpc_error(409, "Conflict: Only one SSE stream is allowed per session", -32_000).into();
    }
    let mut open = write_stream_head(writer, Some(&request.id)).is_ok();
    for (event_id, message) in &replay {
        open = open && write_event(writer, event_id, message).is_ok();
    }
    while open && !shared.shutdown.load(Ordering::SeqCst) && session_live(shared, &request.id) && peer_open(writer) {
        std::thread::sleep(STREAM_POLL);
    }
    shared.sessions.with_session(&request.id, |session| session.standalone_stream = false);
    let ended = open && end_stream(writer).is_ok();
    Outcome::Streamed { keep_alive: ended && !shared.shutdown.load(Ordering::SeqCst) }
}

/// True while a session exists and has not expired. An expired session is removed at once, as the
/// TypeScript per-session timer does at its `expiresAt`, so a stream never outlives its credential.
fn session_live(shared: &Shared, id: &str) -> bool {
    match shared.sessions.with_session(id, |session| session.expired(shared.now_ms())) {
        None => false,
        Some(false) => true,
        Some(true) => {
            shared.sessions.remove(id);
            false
        }
    }
}

fn handle_delete(head: &Head, shared: &Shared, now_seconds: f64) -> Outcome {
    let principal = match authenticate_request(head, None, shared, now_seconds) {
        Ok(principal) => principal,
        Err(reply) => return reply.into(),
    };
    if let Err(message) = check_protocol_header(head.header("mcp-protocol-version"), true) {
        return Reply::json_rpc_error(400, &message, -32_000).into();
    }
    let id = match shared.sessions.begin(head.header("mcp-session-id"), &principal, shared.now_ms()) {
        Ok(id) => id,
        Err(refusal) => return session_refusal_reply(&shared.config, refusal).into(),
    };
    shared.sessions.remove(&id);
    Reply::empty(200).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_bracketed_and_normalized_like_whatwg() {
        assert_eq!(http_url_host("::1"), "[::1]");
        assert_eq!(http_url_host("[::1]"), "[::1]");
        assert_eq!(http_url_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(authority_hostname("LocalHost:3210").as_deref(), Some("localhost"));
        assert_eq!(authority_hostname("[::1]:80").as_deref(), Some("[::1]"));
        assert_eq!(authority_hostname("evil.test@127.0.0.1"), None);
        assert_eq!(authority_hostname("127.0.0.1/path"), None);
    }
}
