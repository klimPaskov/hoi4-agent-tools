//! `hoi4-engine serve`: a resident engine for the MCP server. It reads framed requests on stdin
//! and writes framed responses on stdout until stdin closes, so callers pay start-up and cache
//! warm-up once instead of per call.
//!
//! A frame is one JSON line, then `payload` raw bytes when the line says `"payload": N`:
//!
//! ```text
//! request:  {"id":7,"op":"texture.decode","extension":"dds","maxPixels":16777216,"payload":4244}\n<4244 bytes>
//! response: {"id":7,"ok":true,"result":{"width":64,"height":64,"format":"BC7_UNORM"},"payload":16384}\n<16384 bytes>
//! error:    {"id":7,"ok":false,"error":{"code":"unsupported","message":"...","format":"BC6H_UF16"}}\n
//! ```
//!
//! Requests run in parallel; each response is written whole, in completion order, and matched by
//! `id`. A malformed frame ends the server with exit code 2, because the stream can no longer be
//! trusted to be in step. When stdin closes, requests still running finish first.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{Value, json};

/// The protocol version in `hello`; bumped when a request or response changes shape.
pub const PROTOCOL: u32 = 1;
/// The largest request payload accepted (a texture file).
const MAX_REQUEST_PAYLOAD: usize = 256 * 1024 * 1024;

pub struct Response {
    /// `Ok(result)` or `Err(error object)` with at least `code` and `message`.
    pub result: Result<Value, Value>,
    pub payload: Vec<u8>,
}

impl Response {
    pub fn ok(result: Value) -> Self {
        Response { result: Ok(result), payload: Vec::new() }
    }

    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Response { result: Err(json!({ "code": code, "message": message.into() })), payload: Vec::new() }
    }
}

fn texture_decode(request: &Value, payload: &[u8]) -> Response {
    let extension = request["extension"].as_str().unwrap_or("dds");
    let max_pixels = request["maxPixels"].as_u64().unwrap_or(hoi4_texture::DEFAULT_MAX_PIXELS);
    match hoi4_texture::decode(payload, extension, max_pixels) {
        Ok(decoded) => Response {
            result: Ok(json!({ "width": decoded.image.width, "height": decoded.image.height, "format": decoded.format })),
            payload: decoded.image.rgba,
        },
        Err(error) => {
            let code = match error.kind {
                hoi4_texture::ErrorKind::Invalid => "invalid",
                hoi4_texture::ErrorKind::Unsupported => "unsupported",
                hoi4_texture::ErrorKind::Truncated => "truncated",
                hoi4_texture::ErrorKind::TooLarge => "too_large",
            };
            Response { result: Err(json!({ "code": code, "message": error.message, "format": error.format })), payload: Vec::new() }
        }
    }
}

/// The previews of every workspace this server has rendered, kept for its whole life.
fn preview() -> &'static hoi4_preview::Preview {
    static PREVIEW: std::sync::OnceLock<hoi4_preview::Preview> = std::sync::OnceLock::new();
    PREVIEW.get_or_init(hoi4_preview::Preview::new)
}

/// `layers`: `[{ "name", "path", "replacePaths": [...] }]` in load order.
fn layers(request: &Value) -> Result<Vec<hoi4_preview::LayerRoot>, String> {
    let list = request["layers"].as_array().ok_or("the request has no layers")?;
    list.iter()
        .map(|layer| {
            let path = layer["path"].as_str().ok_or("a layer has no path")?;
            let path = std::path::PathBuf::from(path);
            if !path.is_absolute() || !path.is_dir() {
                return Err(format!("layer {} is not an existing absolute folder", path.display()));
            }
            Ok(hoi4_preview::LayerRoot {
                name: layer["name"].as_str().unwrap_or("").to_string(),
                path,
                replace_paths: layer["replacePaths"]
                    .as_array()
                    .map(|paths| paths.iter().filter_map(Value::as_str).map(|p| p.trim_matches('/').replace('\\', "/").to_ascii_lowercase()).collect())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn focus_render(request: &Value) -> Response {
    let layers = match layers(request) {
        Ok(layers) => layers,
        Err(message) => return Response::error("invalid_request", message),
    };
    let render: hoi4_preview::focus::FocusRenderRequest = match serde_json::from_value(request["request"].clone()) {
        Ok(render) => render,
        Err(e) => return Response::error("invalid_request", format!("invalid focus render request: {e}")),
    };
    match preview().focus_png(layers, &render) {
        Ok((png, report, cache, timings)) => Response { result: Ok(json!({ "report": report, "cache": cache, "timings": timings })), payload: png },
        Err(message) => Response::error("invalid_request", message),
    }
}

fn handle(request: &Value, payload: &[u8]) -> Response {
    match request["op"].as_str() {
        Some("hello") => {
            Response::ok(json!({ "engine": hoi4_engine::VERSION, "protocol": PROTOCOL, "ops": ["hello", "texture.decode", "focus.render", "index.files"] }))
        }
        Some("texture.decode") => texture_decode(request, payload),
        Some("focus.render") => focus_render(request),
        Some("index.files") => match hoi4_engine::symbol_index::records::respond(request, payload) {
            Ok(result) => Response::ok(result),
            Err(error) => Response { result: Err(error), payload: Vec::new() },
        },
        Some(other) => Response::error("unknown_op", format!("unknown op {other}")),
        None => Response::error("invalid_request", "the request has no op"),
    }
}

fn write_frame(out: &Mutex<std::io::Stdout>, id: &Value, response: Response) -> std::io::Result<()> {
    let header = match &response.result {
        Ok(result) => json!({ "id": id, "ok": true, "result": result, "payload": response.payload.len() }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    let mut line = serde_json::to_vec(&header).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    out.write_all(&line)?;
    if response.result.is_ok() {
        out.write_all(&response.payload)?;
    }
    out.flush()
}

/// Counts requests still running, so the server can drain them before it exits.
#[derive(Default)]
struct InFlight {
    count: Mutex<usize>,
    idle: Condvar,
}

impl InFlight {
    fn start(&self) {
        *self.count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    }

    fn finish(&self) {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        *count -= 1;
        if *count == 0 {
            self.idle.notify_all();
        }
    }

    fn wait(&self) {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count > 0 {
            count = self.idle.wait(count).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// Runs until stdin closes. Returns the process exit code.
pub fn run() -> u8 {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let in_flight = Arc::new(InFlight::default());
    let mut input = BufReader::with_capacity(1 << 20, std::io::stdin().lock());
    let mut line = Vec::new();
    let code = loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) => break 0,
            Ok(_) => {}
            Err(e) => {
                eprintln!("hoi4-engine serve: cannot read stdin: {e}");
                break 2;
            }
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("hoi4-engine serve: malformed request frame: {e}");
                break 2;
            }
        };
        let size = request["payload"].as_u64().unwrap_or(0);
        if size > MAX_REQUEST_PAYLOAD as u64 {
            eprintln!("hoi4-engine serve: a request payload of {size} bytes is over the limit");
            break 2;
        }
        let mut payload = vec![0; size as usize];
        if let Err(e) = input.read_exact(&mut payload) {
            eprintln!("hoi4-engine serve: a request payload is truncated: {e}");
            break 2;
        }
        let (out, in_flight) = (Arc::clone(&out), Arc::clone(&in_flight));
        in_flight.start();
        rayon::spawn(move || {
            let id = request["id"].clone();
            // A panic in one request answers that request with an error; the server keeps going.
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&request, &payload)))
                .unwrap_or_else(|_| Response::error("internal", "the engine failed on this request"));
            if let Err(e) = write_frame(&out, &id, response) {
                eprintln!("hoi4-engine serve: cannot write a response: {e}");
                std::process::exit(2);
            }
            in_flight.finish();
        });
    };
    in_flight.wait();
    code
}
