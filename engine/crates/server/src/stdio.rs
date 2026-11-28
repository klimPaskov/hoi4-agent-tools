//! The stdio transport: newline-delimited JSON-RPC with a fixed frame ceiling, strict UTF-8, and
//! the lifetime rules that end a server no client can reach.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/bounded-stdio.ts`
//! (`BoundedStdioServerTransport`, `STDIO_MAX_FRAME_BYTES`, the frame errors) and
//! `src/hoi4_agent_tools/mcp/transports/stdio-lifetime.ts` (`StdioLifetime`,
//! `cancelledRequestId`, `requestId`), commit 9b7dc80d. The parent-process probe is passed in;
//! the server binary supplies the platform one when the transport is wired (ADR 0089 step 8).

use std::collections::BTreeMap;
use std::io::{BufRead, Write};

use serde_json::Value;

use crate::jsonrpc::{CallerContext, McpService, classify};

/// The largest frame accepted: the bounded inline tool arguments, and the largest configurable
/// Streamable HTTP body.
pub const STDIO_MAX_FRAME_BYTES: usize = 16_777_216;
/// The largest single message written.
pub const STDIO_MAX_OUTPUT_BYTES: usize = 134_217_728;

/// Why the stdio loop stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdioExit {
    /// The client closed stdin.
    EndOfInput,
    /// `STDIO_FRAME_TOO_LARGE`: a frame passed the ceiling. The input is abandoned.
    FrameTooLarge,
    /// `STDIO_INVALID_UTF8`: a frame was not UTF-8. The input is abandoned.
    InvalidUtf8,
    /// The output pipe failed.
    OutputFailed(String),
    /// The input pipe failed.
    InputFailed(String),
}

impl StdioExit {
    /// The stable code reported for an abnormal stop.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::EndOfInput => None,
            Self::FrameTooLarge => Some("STDIO_FRAME_TOO_LARGE"),
            Self::InvalidUtf8 => Some("STDIO_INVALID_UTF8"),
            Self::OutputFailed(_) => Some("STDIO_OUTPUT_FAILED"),
            Self::InputFailed(_) => Some("STDIO_INPUT_FAILED"),
        }
    }
}

/// One frame read from the input.
#[derive(Debug, PartialEq)]
pub enum Frame {
    /// A JSON-RPC message.
    Message(Value),
    /// `STDIO_INVALID_MESSAGE`: a well-formed UTF-8 line that is not a JSON-RPC message. It is
    /// reported and skipped; the transport keeps reading.
    Invalid,
    /// The stream stopped.
    End(StdioExit),
}

/// Reads newline-delimited frames, holding at most `max_frame_bytes` of one unterminated frame.
pub struct FrameReader<R> {
    input: R,
    max_frame_bytes: usize,
    frame: Vec<u8>,
    done: bool,
}

impl<R: BufRead> FrameReader<R> {
    pub fn new(input: R, max_frame_bytes: usize) -> Self {
        Self { input, max_frame_bytes: max_frame_bytes.clamp(1, STDIO_MAX_FRAME_BYTES), frame: Vec::new(), done: false }
    }

    fn stop(&mut self, exit: StdioExit) -> Frame {
        self.done = true;
        self.frame = Vec::new();
        Frame::End(exit)
    }

    /// The next frame. After an `End`, every call returns `End(EndOfInput)`.
    pub fn next_frame(&mut self) -> Frame {
        if self.done {
            return Frame::End(StdioExit::EndOfInput);
        }
        loop {
            let available = match self.input.fill_buf() {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return self.stop(StdioExit::InputFailed(error.kind().to_string())),
            };
            if available.is_empty() {
                // A final line without a newline is not a frame, as in the TypeScript transport.
                return self.stop(StdioExit::EndOfInput);
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let part = newline.unwrap_or(available.len());
            if self.frame.len() + part > self.max_frame_bytes {
                return self.stop(StdioExit::FrameTooLarge);
            }
            self.frame.extend_from_slice(&available[..part]);
            let consumed = newline.map_or(part, |at| at + 1);
            self.input.consume(consumed);
            if newline.is_none() {
                continue;
            }
            let frame = std::mem::take(&mut self.frame);
            let Ok(text) = String::from_utf8(frame) else { return self.stop(StdioExit::InvalidUtf8) };
            let line = text.strip_suffix('\r').unwrap_or(&text);
            return match serde_json::from_str::<Value>(line) {
                Ok(message) if classify(&message).is_some() => Frame::Message(message),
                _ => Frame::Invalid,
            };
        }
    }
}

/// Writes one message as a line. A message over [`STDIO_MAX_OUTPUT_BYTES`] is refused.
pub fn write_message(output: &mut impl Write, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if line.len() > STDIO_MAX_OUTPUT_BYTES {
        return Err("Stdio output queue is full".to_owned());
    }
    line.push(b'\n');
    output.write_all(&line).and_then(|()| output.flush()).map_err(|error| error.kind().to_string())
}

/// Serves one stdio client until its input ends or a frame is refused. `report` receives each
/// stable error code (`STDIO_INVALID_MESSAGE` for a skipped line); it must log to stderr only.
pub fn serve_stdio<R: BufRead, W: Write>(
    input: R,
    mut output: W,
    service: &dyn McpService,
    lifetime: Option<&mut StdioLifetime>,
    report: &mut dyn FnMut(&'static str),
) -> StdioExit {
    let caller = CallerContext::default();
    let mut reader = FrameReader::new(input, STDIO_MAX_FRAME_BYTES);
    let mut lifetime = lifetime;
    loop {
        match reader.next_frame() {
            Frame::Message(message) => {
                if let Some(lifetime) = lifetime.as_deref_mut() {
                    lifetime.received(&message);
                }
                if let Some(answer) = service.handle(&message, &caller) {
                    if let Err(error) = write_message(&mut output, &answer) {
                        return StdioExit::OutputFailed(error);
                    }
                    if let Some(lifetime) = lifetime.as_deref_mut() {
                        lifetime.sent(&answer);
                    }
                }
            }
            Frame::Invalid => report("STDIO_INVALID_MESSAGE"),
            Frame::End(exit) => {
                if let Some(code) = exit.code() {
                    report(code);
                }
                return exit;
            }
        }
    }
}

/// Why the lifetime check ends the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioExitReason {
    ParentExited,
    Idle,
}

/// The default parent poll interval.
pub const PARENT_POLL_MS: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum RequestId {
    Text(String),
    Number(String),
}

fn request_id(message: &Value, field: &str) -> Option<RequestId> {
    let object = message.as_object()?;
    if !object.contains_key(field) {
        return None;
    }
    match object.get("id")? {
        Value::String(text) => Some(RequestId::Text(text.clone())),
        Value::Number(number) => Some(RequestId::Number(number.to_string())),
        _ => None,
    }
}

fn cancelled_request_id(message: &Value) -> Option<RequestId> {
    if message.get("method").and_then(Value::as_str) != Some("notifications/cancelled") {
        return None;
    }
    match message.get("params")?.get("requestId")? {
        Value::String(text) => Some(RequestId::Text(text.clone())),
        Value::Number(number) => Some(RequestId::Number(number.to_string())),
        _ => None,
    }
}

/// Ends a stdio server that no client can reach: its parent process is gone, or (optionally) no
/// client traffic arrived for a set number of minutes. Open requests keep it alive, but one open
/// for twice the idle limit counts as abandoned.
pub struct StdioLifetime {
    parent_pid: u32,
    is_alive: Box<dyn Fn(u32) -> bool + Send>,
    idle_exit_minutes: u64,
    poll_ms: u64,
    open: BTreeMap<RequestId, u64>,
    parent_gone: bool,
    last_activity_ms: u64,
    stopped: bool,
}

impl StdioLifetime {
    pub fn new(parent_pid: u32, is_alive: Box<dyn Fn(u32) -> bool + Send>, idle_exit_minutes: u64, poll_ms: u64, now_ms: u64) -> Self {
        Self { parent_pid, is_alive, idle_exit_minutes, poll_ms, open: BTreeMap::new(), parent_gone: false, last_activity_ms: now_ms, stopped: false }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
    }

    /// A client message: a request opens until its response is sent; a cancellation closes it.
    pub fn received(&mut self, message: &Value) {
        self.received_at(message, Self::now_ms());
    }

    pub fn received_at(&mut self, message: &Value, now_ms: u64) {
        self.last_activity_ms = now_ms;
        if let Some(id) = request_id(message, "method") {
            self.open.insert(id, now_ms);
        }
        if let Some(cancelled) = cancelled_request_id(message) {
            self.open.remove(&cancelled);
        }
    }

    /// A server message: a response closes its request.
    pub fn sent(&mut self, message: &Value) {
        self.sent_at(message, Self::now_ms());
    }

    pub fn sent_at(&mut self, message: &Value, now_ms: u64) {
        self.last_activity_ms = now_ms;
        if let Some(id) = request_id(message, "result").or_else(|| request_id(message, "error")) {
            self.open.remove(&id);
        }
    }

    pub fn last_activity_ms(&self) -> u64 {
        self.last_activity_ms
    }

    /// One poll. Returns the reason when the server should exit; after that it stays stopped.
    pub fn check(&mut self, now_ms: u64) -> Option<StdioExitReason> {
        if self.stopped {
            return None;
        }
        let idle_ms = self.idle_exit_minutes * 60_000;
        if idle_ms > 0 {
            self.open.retain(|_, opened_at| now_ms.saturating_sub(*opened_at) <= 2 * idle_ms);
        }
        // A parent pid of 0 or 1 means the server was reparented before it started.
        if self.parent_pid > 1 && !self.parent_gone && !(self.is_alive)(self.parent_pid) {
            self.parent_gone = true;
        }
        let quiet = now_ms.saturating_sub(self.last_activity_ms);
        if self.parent_gone && self.open.is_empty() && quiet >= self.poll_ms {
            self.stopped = true;
            return Some(StdioExitReason::ParentExited);
        }
        if idle_ms > 0 && self.open.is_empty() && quiet > idle_ms {
            self.stopped = true;
            return Some(StdioExitReason::Idle);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::{CoreService, ServerInfo};
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn service() -> CoreService {
        CoreService::new(ServerInfo { name: "test".into(), version: "0".into(), website_url: None, instructions: None }, Vec::new())
    }

    fn run(input: &[u8]) -> (StdioExit, Vec<Value>, Vec<&'static str>) {
        let mut output = Vec::new();
        let mut codes = Vec::new();
        let exit = serve_stdio(Cursor::new(input.to_vec()), &mut output, &service(), None, &mut |code| codes.push(code));
        let lines = String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        (exit, lines, codes)
    }

    #[test]
    fn answers_requests_in_order_and_skips_invalid_lines() {
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\r\nnot json\n[1]\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n";
        let (exit, lines, codes) = run(input);
        assert_eq!(exit, StdioExit::EndOfInput);
        assert_eq!(lines.iter().map(|line| line["id"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2)]);
        assert_eq!(codes, vec!["STDIO_INVALID_MESSAGE", "STDIO_INVALID_MESSAGE"]);
    }

    #[test]
    fn refuses_an_oversized_frame_and_stops_reading() {
        let mut reader = FrameReader::new(Cursor::new(b"0123456789\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n".to_vec()), 8);
        assert_eq!(reader.next_frame(), Frame::End(StdioExit::FrameTooLarge));
        assert_eq!(reader.next_frame(), Frame::End(StdioExit::EndOfInput), "nothing after a refused frame is read");
        // An unterminated frame over the ceiling is refused before its newline arrives.
        let mut endless = FrameReader::new(Cursor::new(vec![b'x'; 100]), 16);
        assert_eq!(endless.next_frame(), Frame::End(StdioExit::FrameTooLarge));
        // A frame exactly at the ceiling passes.
        let exact = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
        let mut fits = FrameReader::new(Cursor::new([&exact[..], b"\n"].concat()), exact.len());
        assert!(matches!(fits.next_frame(), Frame::Message(_)));
    }

    #[test]
    fn refuses_invalid_utf8_and_stops() {
        let (exit, lines, codes) = run(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"\xff\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n");
        assert_eq!(exit, StdioExit::InvalidUtf8);
        assert!(lines.is_empty());
        assert_eq!(codes, vec!["STDIO_INVALID_UTF8"]);
    }

    struct FailingOutput;

    impl Write for FailingOutput {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stops_when_the_output_pipe_fails() {
        let mut codes = Vec::new();
        let input = Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n".to_vec());
        let exit = serve_stdio(input, FailingOutput, &service(), None, &mut |code| codes.push(code));
        assert!(matches!(exit, StdioExit::OutputFailed(_)));
    }

    // Ported from tests/unit/stdio-lifetime.test.ts.
    #[test]
    fn exits_after_the_parent_dies_once_requests_finish_and_the_pipe_is_quiet() {
        let alive = Arc::new(AtomicBool::new(true));
        let probe = Arc::clone(&alive);
        let mut lifetime = StdioLifetime::new(4242, Box::new(move |_| probe.load(Ordering::SeqCst)), 0, 5_000, 0);
        lifetime.received_at(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call" }), 0);
        assert_eq!(lifetime.check(10_000), None);
        alive.store(false, Ordering::SeqCst);
        assert_eq!(lifetime.check(20_000), None, "an open request keeps the server");
        lifetime.sent_at(&json!({ "jsonrpc": "2.0", "id": 7, "result": {} }), 21_000);
        assert_eq!(lifetime.check(22_000), None, "waits for one quiet poll");
        assert_eq!(lifetime.check(26_000), Some(StdioExitReason::ParentExited));
        assert_eq!(lifetime.check(99_000), None, "reports once");
    }

    #[test]
    fn exits_when_idle_and_drops_abandoned_or_cancelled_requests() {
        let mut lifetime = StdioLifetime::new(1, Box::new(|_| false), 1, 5_000, 0);
        lifetime.received_at(&json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/call" }), 0);
        lifetime.received_at(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call" }), 0);
        lifetime.received_at(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 2 } }), 0);
        assert_eq!(lifetime.check(61_000), None, "the open request blocks the idle exit");
        assert_eq!(lifetime.check(120_001), Some(StdioExitReason::Idle), "a request open for twice the limit is abandoned");
        let mut never = StdioLifetime::new(0, Box::new(|_| false), 0, 5_000, 0);
        assert_eq!(never.check(u64::MAX / 2), None, "no idle limit and no parent to watch");
    }
}
