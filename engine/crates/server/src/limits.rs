//! Request admission: body size, concurrency with a small control reserve, the aggregate body
//! budget, per-minute rate windows, and the client address behind trusted proxies.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/http.ts` (`normalizeIpAddress`,
//! `rateLimitClientAddress`, `admissionMiddleware`, the per-principal rate check of
//! `authenticateMiddleware`, and the overflow gate that lets only control messages through),
//! commit 9b7dc80d.

use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use crate::config::{HTTP_MAX_AGGREGATE_BODY_BYTES, HttpConfig};

/// Extra slots for small control envelopes (cancellation, roots replies, discovery) when every
/// request slot is taken.
pub const CONTROL_RESERVE_SLOTS: u64 = 16;
/// The largest body a control envelope admitted into the reserve may declare.
pub const CONTROL_RESERVE_BODY_BYTES: u64 = 65_536;

/// Lower-cases an address and unwraps an IPv4-mapped IPv6 address.
pub fn normalize_ip_address(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    match lower.strip_prefix("::ffff:") {
        Some(rest) if rest.parse::<std::net::Ipv4Addr>().is_ok() => rest.to_owned(),
        _ => lower,
    }
}

/// The address a request is rate-limited by. Behind a trusted proxy it is the last untrusted hop
/// of `X-Forwarded-For`; `None` when that header is missing, malformed or all trusted.
pub fn rate_limit_client_address(socket_address: &str, forwarded_for: Option<&str>, trusted_proxies: &[String]) -> Option<String> {
    let socket = normalize_ip_address(socket_address);
    let trusted: BTreeSet<String> = trusted_proxies.iter().map(|address| normalize_ip_address(address)).collect();
    if !trusted.contains(&socket) {
        return Some(socket);
    }
    let forwarded = forwarded_for?;
    for hop in forwarded.split(',').rev() {
        let hop = hop.trim();
        if hop.parse::<IpAddr>().is_err() {
            return None;
        }
        let normalized = normalize_ip_address(hop);
        if !trusted.contains(&normalized) {
            return Some(normalized);
        }
    }
    None
}

/// Methods admitted while the request slots overflow into the control reserve.
pub fn is_control_method(method: Option<&str>) -> bool {
    match method {
        None => true,
        Some(method) => {
            method.starts_with("notifications/") || matches!(method, "ping" | "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list")
        }
    }
}

/// Why admission refused a request, with the HTTP status and body code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionRefusal {
    PayloadTooLarge,
    ConcurrencyLimit,
    BodyCapacityLimit,
}

#[derive(Debug, Default)]
struct AdmissionState {
    concurrent: u64,
    reserved_body_bytes: u64,
}

/// Concurrency and body budget of one server.
#[derive(Debug, Clone)]
pub struct Admission {
    max_concurrent: u64,
    max_body_bytes: u64,
    aggregate_body_bytes: u64,
    state: Arc<Mutex<AdmissionState>>,
}

/// One admitted request. Dropping it releases its slot and body reservation.
#[derive(Debug)]
pub struct AdmissionTicket {
    state: Arc<Mutex<AdmissionState>>,
    body_bytes: u64,
    /// The request took a control-reserve slot; only control methods may proceed.
    pub overflow: bool,
    released: bool,
}

impl AdmissionTicket {
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.concurrent = state.concurrent.saturating_sub(1);
        state.reserved_body_bytes = state.reserved_body_bytes.saturating_sub(self.body_bytes);
    }
}

impl Drop for AdmissionTicket {
    fn drop(&mut self) {
        self.release();
    }
}

impl Admission {
    pub fn new(config: &HttpConfig) -> Self {
        Self::with_aggregate(config, HTTP_MAX_AGGREGATE_BODY_BYTES)
    }

    pub fn with_aggregate(config: &HttpConfig, aggregate_body_bytes: u64) -> Self {
        Self { max_concurrent: config.max_concurrent_requests, max_body_bytes: config.max_body_bytes, aggregate_body_bytes, state: Arc::default() }
    }

    /// Admits a request. A POST without `Content-Length` reserves the whole body limit.
    pub fn admit(&self, is_post: bool, declared_length: Option<&str>) -> Result<AdmissionTicket, AdmissionRefusal> {
        let body_bytes = if !is_post {
            0
        } else {
            match declared_length {
                None => self.max_body_bytes,
                Some(value) => {
                    let value = value.trim();
                    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                        return Err(AdmissionRefusal::PayloadTooLarge);
                    }
                    value.parse::<u64>().map_err(|_| AdmissionRefusal::PayloadTooLarge)?
                }
            }
        };
        if body_bytes > self.max_body_bytes {
            return Err(AdmissionRefusal::PayloadTooLarge);
        }
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let overflow = state.concurrent >= self.max_concurrent;
        if overflow && (state.concurrent >= self.max_concurrent + CONTROL_RESERVE_SLOTS || body_bytes > CONTROL_RESERVE_BODY_BYTES) {
            return Err(AdmissionRefusal::ConcurrencyLimit);
        }
        if body_bytes > self.aggregate_body_bytes.saturating_sub(state.reserved_body_bytes) {
            return Err(AdmissionRefusal::BodyCapacityLimit);
        }
        state.concurrent += 1;
        state.reserved_body_bytes += body_bytes;
        Ok(AdmissionTicket { state: Arc::clone(&self.state), body_bytes, overflow, released: false })
    }
}

#[derive(Debug, Clone, Copy)]
struct Window {
    minute: u64,
    count: u64,
}

/// Fixed one-minute request windows by key (an address or a principal).
#[derive(Debug)]
pub struct RateWindows {
    limit: u64,
    windows: Mutex<(u64, BTreeMap<String, Window>)>,
}

impl RateWindows {
    pub fn new(limit: u64) -> Self {
        Self { limit, windows: Mutex::new((u64::MAX, BTreeMap::new())) }
    }

    /// Counts one request; false when the key has gone over the limit this minute.
    pub fn hit(&self, key: &str, now_ms: u64) -> bool {
        let minute = now_ms / 60_000;
        let mut guard = self.windows.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (last_prune, windows) = &mut *guard;
        if *last_prune != minute {
            windows.retain(|_, window| window.minute >= minute);
            *last_prune = minute;
        }
        let window = windows.entry(key.to_owned()).or_insert(Window { minute, count: 0 });
        if window.minute != minute {
            *window = Window { minute, count: 0 };
        }
        window.count += 1;
        window.count <= self.limit
    }

    pub fn tracked(&self) -> usize {
        self.windows.lock().map(|guard| guard.1.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/unit/http-client-address.test.ts.
    #[test]
    fn client_address_uses_the_socket_unless_a_trusted_proxy_forwards() {
        let trusted = vec!["10.0.0.1".to_owned(), "10.0.0.2".to_owned()];
        assert_eq!(rate_limit_client_address("203.0.113.5", Some("1.2.3.4"), &trusted).as_deref(), Some("203.0.113.5"));
        assert_eq!(rate_limit_client_address("10.0.0.1", Some("1.2.3.4, 198.51.100.7, 10.0.0.2"), &trusted).as_deref(), Some("198.51.100.7"));
        assert_eq!(rate_limit_client_address("10.0.0.1", Some("not-an-address"), &trusted), None);
        assert_eq!(rate_limit_client_address("10.0.0.1", None, &trusted), None);
        assert_eq!(rate_limit_client_address("10.0.0.1", Some("10.0.0.2"), &trusted), None);
        assert_eq!(rate_limit_client_address("::ffff:10.0.0.1", Some("198.51.100.7"), &trusted).as_deref(), Some("198.51.100.7"));
    }

    fn config(max_concurrent: u64, max_body: u64) -> HttpConfig {
        HttpConfig::from_json(&json!({ "maxConcurrentRequests": max_concurrent, "maxBodyBytes": max_body })).unwrap()
    }

    #[test]
    fn admission_refuses_bad_lengths_and_oversized_bodies() {
        let admission = Admission::new(&config(4, 2048));
        assert_eq!(admission.admit(true, Some("4096")).unwrap_err(), AdmissionRefusal::PayloadTooLarge);
        assert_eq!(admission.admit(true, Some("-1")).unwrap_err(), AdmissionRefusal::PayloadTooLarge);
        assert_eq!(admission.admit(true, Some("1e3")).unwrap_err(), AdmissionRefusal::PayloadTooLarge);
        assert_eq!(admission.admit(true, Some("99999999999999999999999")).unwrap_err(), AdmissionRefusal::PayloadTooLarge);
        assert!(admission.admit(true, Some("2048")).is_ok());
        assert!(admission.admit(false, Some("999999")).is_ok());
    }

    #[test]
    fn overflow_admits_only_small_bodies_into_a_bounded_reserve() {
        let admission = Admission::new(&config(1, 1_048_576));
        let _first = admission.admit(true, Some("10")).unwrap();
        assert_eq!(admission.admit(true, Some("70000")).unwrap_err(), AdmissionRefusal::ConcurrencyLimit);
        let reserve: Vec<_> = (0..CONTROL_RESERVE_SLOTS).map(|_| admission.admit(true, Some("100")).unwrap()).collect();
        assert!(reserve.iter().all(|ticket| ticket.overflow));
        assert_eq!(admission.admit(true, Some("100")).unwrap_err(), AdmissionRefusal::ConcurrencyLimit);
        drop(reserve);
        assert!(admission.admit(true, Some("100")).unwrap().overflow);
    }

    #[test]
    fn aggregate_body_budget_is_reserved_and_released() {
        let admission = Admission::with_aggregate(&config(8, 4096), 6000);
        let first = admission.admit(true, None).unwrap();
        assert_eq!(admission.admit(true, Some("2000")).unwrap_err(), AdmissionRefusal::BodyCapacityLimit);
        drop(first);
        assert!(admission.admit(true, Some("2000")).is_ok());
    }

    #[test]
    fn control_methods_are_the_reserve_allowlist() {
        for method in [None, Some("ping"), Some("notifications/cancelled"), Some("tools/list"), Some("prompts/list")] {
            assert!(is_control_method(method), "{method:?}");
        }
        assert!(!is_control_method(Some("tools/call")));
        assert!(!is_control_method(Some("initialize")));
    }

    #[test]
    fn rate_windows_count_per_key_and_reset_each_minute() {
        let windows = RateWindows::new(2);
        assert!(windows.hit("a", 0));
        assert!(windows.hit("a", 1));
        assert!(!windows.hit("a", 2));
        assert!(windows.hit("b", 3));
        assert!(windows.hit("a", 60_000));
        assert_eq!(windows.tracked(), 1, "stale windows are pruned when the minute turns");
    }
}
