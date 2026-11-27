//! Streamable HTTP sessions: each one bound to the principal, client, credential and scopes that
//! created it, bounded in number per server and per principal, and expired by inactivity or by
//! the credential's expiry.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/http.ts` (`Session`,
//! `sessionAuthorizationMatches`, `boundedSessionExpiration`, `sessionExpired`, `findSession`,
//! `pruneExpiredSessions`, the session and stream limits of the POST and GET handlers),
//! commit 9b7dc80d.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::auth::{AuthenticatedPrincipal, BearerError};
use crate::config::HttpConfig;
use crate::event_store::{BoundedEventStore, SharedEventStoreBudget};
use crate::random::random_uuid;

/// The events one session keeps for resumption at most.
pub const SESSION_MAX_EVENTS: usize = 1000;

/// One live session. Everything the MCP service learns about its caller comes from here.
#[derive(Debug)]
pub struct Session {
    pub principal: String,
    pub client_id: String,
    pub credential_id: String,
    pub scopes: Vec<String>,
    pub protocol_version: String,
    pub expires_at_ms: u64,
    pub credential_expires_at_ms: Option<u64>,
    pub active_requests: u64,
    pub event_store: BoundedEventStore,
    /// True while the standalone GET stream of this session is open.
    pub standalone_stream: bool,
}

impl Session {
    fn expired(&self, now_ms: u64) -> bool {
        self.credential_expires_at_ms.is_some_and(|at| at <= now_ms) || (self.active_requests == 0 && self.expires_at_ms <= now_ms)
    }
}

/// True when a request's credential may use a session: same principal, client and credential,
/// and no scope of the session missing.
pub fn session_authorization_matches(session: &Session, principal: &AuthenticatedPrincipal) -> bool {
    session.principal == principal.principal
        && session.client_id == principal.client_id
        && session.credential_id == principal.credential_id
        && session.scopes.iter().all(|scope| principal.scopes.contains(scope))
}

fn credential_expiry_ms(principal: &AuthenticatedPrincipal) -> Option<u64> {
    principal.expires_at.map(|seconds| if seconds <= 0.0 { 0 } else { (seconds * 1000.0) as u64 })
}

/// The earlier of the inactivity expiry and the credential's own expiry.
pub fn bounded_session_expiration(principal: &AuthenticatedPrincipal, now_ms: u64, ttl_ms: u64) -> u64 {
    let inactivity = now_ms.saturating_add(ttl_ms);
    credential_expiry_ms(principal).map_or(inactivity, |credential| inactivity.min(credential))
}

/// A refused session lookup or creation, as the HTTP status and what the body says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRefusal {
    /// A JSON-RPC error body with this status and message.
    JsonRpc(u16, &'static str),
    /// A `{"error": code}` body with this status.
    Code(u16, &'static str),
    /// An authentication refusal with a bearer challenge.
    Auth { status: u16, code: &'static str, bearer_error: BearerError, required_scopes: Vec<String> },
}

#[derive(Debug, Default)]
struct Pending {
    total: u64,
    by_principal: BTreeMap<String, u64>,
}

#[derive(Debug, Default)]
struct Streams {
    total: u64,
    by_principal: BTreeMap<String, u64>,
}

/// Every session of one server.
#[derive(Debug)]
pub struct SessionStore {
    config: HttpConfig,
    sessions: Mutex<BTreeMap<String, Session>>,
    pending: Mutex<Pending>,
    streams: Arc<Mutex<Streams>>,
    budget: SharedEventStoreBudget,
}

/// A reserved slot for a session being initialized. Dropping it without [`SessionStore::open`]
/// gives the slot back.
#[derive(Debug)]
pub struct PendingSession<'a> {
    store: &'a SessionStore,
    principal: AuthenticatedPrincipal,
    initial_expiration_ms: u64,
    released: bool,
}

impl Drop for PendingSession<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.store.release_pending(&self.principal.principal);
        }
    }
}

/// An open standalone event stream. Dropping it frees its stream slots.
#[derive(Debug)]
pub struct StreamTicket {
    streams: Arc<Mutex<Streams>>,
    principal: String,
}

impl Drop for StreamTicket {
    fn drop(&mut self) {
        let mut streams = self.streams.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        streams.total = streams.total.saturating_sub(1);
        let remaining = streams.by_principal.get(&self.principal).copied().unwrap_or(1).saturating_sub(1);
        if remaining == 0 {
            streams.by_principal.remove(&self.principal);
        } else {
            streams.by_principal.insert(self.principal.clone(), remaining);
        }
    }
}

impl SessionStore {
    pub fn new(config: &HttpConfig) -> Self {
        Self {
            config: config.clone(),
            sessions: Mutex::default(),
            pending: Mutex::default(),
            streams: Arc::default(),
            budget: SharedEventStoreBudget::new(config.max_event_store_bytes),
        }
    }

    fn ttl_ms(&self) -> u64 {
        self.config.session_ttl_seconds * 1000
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub fn event_budget_used(&self) -> u64 {
        self.budget.used()
    }

    fn release_pending(&self, principal: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.total = pending.total.saturating_sub(1);
        let remaining = pending.by_principal.get(principal).copied().unwrap_or(1).saturating_sub(1);
        if remaining == 0 {
            pending.by_principal.remove(principal);
        } else {
            pending.by_principal.insert(principal.to_owned(), remaining);
        }
    }

    /// Removes expired sessions, returning their bytes to the shared event budget.
    pub fn prune(&self, now_ms: u64) {
        self.lock().retain(|_, session| !session.expired(now_ms));
    }

    /// Reserves a slot for a new session of `principal`, within the server and principal limits.
    pub fn reserve(&self, principal: &AuthenticatedPrincipal, required_scopes: &[String], now_ms: u64) -> Result<PendingSession<'_>, SessionRefusal> {
        self.prune(now_ms);
        let initial = bounded_session_expiration(principal, now_ms, self.ttl_ms());
        if initial <= now_ms {
            return Err(SessionRefusal::Auth {
                status: 401,
                code: "AUTH_INVALID",
                bearer_error: BearerError::InvalidToken,
                required_scopes: required_scopes.to_vec(),
            });
        }
        let sessions = self.lock();
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if sessions.len() as u64 + pending.total >= self.config.max_sessions {
            return Err(SessionRefusal::Code(429, "session_limit"));
        }
        let own = sessions.values().filter(|session| session.principal == principal.principal).count() as u64;
        let own_pending = pending.by_principal.get(&principal.principal).copied().unwrap_or(0);
        if own + own_pending >= self.config.max_sessions.min(self.config.max_sessions_per_principal) {
            return Err(SessionRefusal::Code(429, "principal_session_limit"));
        }
        pending.total += 1;
        pending.by_principal.insert(principal.principal.clone(), own_pending + 1);
        Ok(PendingSession { store: self, principal: principal.clone(), initial_expiration_ms: initial, released: false })
    }

    /// Opens the reserved session after a successful `initialize` and returns its new id.
    pub fn open(&self, mut pending: PendingSession<'_>, protocol_version: &str, now_ms: u64) -> String {
        let principal = pending.principal.clone();
        let id = random_uuid();
        let ttl = self.ttl_ms();
        let session = Session {
            principal: principal.principal.clone(),
            client_id: principal.client_id.clone(),
            credential_id: principal.credential_id.clone(),
            scopes: principal.scopes.clone(),
            protocol_version: protocol_version.to_owned(),
            expires_at_ms: pending.initial_expiration_ms.min(bounded_session_expiration(&principal, now_ms, ttl)),
            credential_expires_at_ms: credential_expiry_ms(&principal),
            active_requests: 0,
            event_store: BoundedEventStore::new(
                SESSION_MAX_EVENTS,
                ttl,
                self.config.max_session_event_bytes.min(self.config.max_event_store_bytes),
                Some(self.budget.clone()),
            ),
            standalone_stream: false,
        };
        self.lock().insert(id.clone(), session);
        pending.released = true;
        self.release_pending(&principal.principal);
        id
    }

    /// Finds a session for a request and checks that the request's credential may use it. On
    /// success the session's scopes grow to the credential's, its expiry is renewed, and it
    /// counts one more active request until [`SessionStore::finish`].
    pub fn begin(&self, id: Option<&str>, principal: &AuthenticatedPrincipal, now_ms: u64) -> Result<String, SessionRefusal> {
        let Some(id) = id else { return Err(SessionRefusal::JsonRpc(400, "Missing MCP session ID")) };
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(id) else { return Err(SessionRefusal::JsonRpc(404, "Unknown or expired MCP session")) };
        if session.expired(now_ms) {
            sessions.remove(id);
            return Err(SessionRefusal::JsonRpc(404, "Unknown or expired MCP session"));
        }
        if session.principal != principal.principal {
            return Err(SessionRefusal::JsonRpc(403, "MCP session belongs to another principal"));
        }
        if session.client_id != principal.client_id || session.credential_id != principal.credential_id {
            return Err(SessionRefusal::JsonRpc(403, "MCP session authorization context does not match"));
        }
        if session.scopes.iter().any(|scope| !principal.scopes.contains(scope)) {
            return Err(SessionRefusal::Auth {
                status: 403,
                code: "AUTH_SCOPE_INSUFFICIENT",
                bearer_error: BearerError::InsufficientScope,
                required_scopes: session.scopes.clone(),
            });
        }
        for scope in &principal.scopes {
            if !session.scopes.contains(scope) {
                session.scopes.push(scope.clone());
            }
        }
        session.expires_at_ms = bounded_session_expiration(principal, now_ms, self.ttl_ms());
        session.credential_expires_at_ms = credential_expiry_ms(principal);
        session.active_requests += 1;
        Ok(id.to_owned())
    }

    /// Ends one request of a session and restarts its inactivity clock.
    pub fn finish(&self, id: &str, now_ms: u64) {
        let ttl = self.ttl_ms();
        if let Some(session) = self.lock().get_mut(id) {
            session.active_requests = session.active_requests.saturating_sub(1);
            let renewed = now_ms.saturating_add(ttl);
            session.expires_at_ms = session.credential_expires_at_ms.map_or(renewed, |credential| renewed.min(credential));
        }
    }

    /// Runs `action` on a live session.
    pub fn with_session<T>(&self, id: &str, action: impl FnOnce(&mut Session) -> T) -> Option<T> {
        self.lock().get_mut(id).map(action)
    }

    /// Closes a session; its events are dropped and their bytes returned.
    pub fn remove(&self, id: &str) -> bool {
        self.lock().remove(id).is_some()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }

    /// Takes a standalone event-stream slot within the server and principal limits.
    pub fn open_stream(&self, principal: &str) -> Result<StreamTicket, SessionRefusal> {
        let mut streams = self.streams.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let own = streams.by_principal.get(principal).copied().unwrap_or(0);
        if streams.total >= self.config.max_event_streams {
            return Err(SessionRefusal::Code(429, "event_stream_limit"));
        }
        if own >= self.config.max_event_streams_per_principal {
            return Err(SessionRefusal::Code(429, "principal_event_stream_limit"));
        }
        streams.total += 1;
        streams.by_principal.insert(principal.to_owned(), own + 1);
        Ok(StreamTicket { streams: Arc::clone(&self.streams), principal: principal.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn principal(name: &str, credential: &str, scopes: &[&str], expires_at: Option<f64>) -> AuthenticatedPrincipal {
        AuthenticatedPrincipal {
            principal: name.to_owned(),
            client_id: name.to_owned(),
            credential_id: credential.to_owned(),
            scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
            expires_at,
        }
    }

    fn store(extra: serde_json::Value) -> SessionStore {
        let mut value = json!({ "sessionTtlSeconds": 60 });
        if let (Some(target), Some(source)) = (value.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
        SessionStore::new(&HttpConfig::from_json(&value).unwrap())
    }

    fn open(store: &SessionStore, who: &AuthenticatedPrincipal, now: u64) -> String {
        let pending = store.reserve(who, &[], now).unwrap();
        store.open(pending, "2025-11-25", now)
    }

    #[test]
    fn a_session_is_bound_to_its_principal_client_credential_and_scopes() {
        let store = store(json!({}));
        let alice = principal("alice", "sha256:a", &["hoi4:read", "hoi4:write"], None);
        let id = open(&store, &alice, 0);
        assert_eq!(store.begin(None, &alice, 1), Err(SessionRefusal::JsonRpc(400, "Missing MCP session ID")));
        assert_eq!(store.begin(Some("forged"), &alice, 1), Err(SessionRefusal::JsonRpc(404, "Unknown or expired MCP session")));
        let bob = principal("bob", "sha256:a", &["hoi4:read", "hoi4:write"], None);
        assert_eq!(store.begin(Some(&id), &bob, 1), Err(SessionRefusal::JsonRpc(403, "MCP session belongs to another principal")));
        let other_credential = principal("alice", "sha256:b", &["hoi4:read", "hoi4:write"], None);
        assert_eq!(store.begin(Some(&id), &other_credential, 1), Err(SessionRefusal::JsonRpc(403, "MCP session authorization context does not match")));
        let reduced = principal("alice", "sha256:a", &["hoi4:read"], None);
        assert!(matches!(store.begin(Some(&id), &reduced, 1), Err(SessionRefusal::Auth { status: 403, code: "AUTH_SCOPE_INSUFFICIENT", .. })));
        assert_eq!(store.begin(Some(&id), &alice, 1).as_deref(), Ok(id.as_str()));
        store.finish(&id, 2);
    }

    #[test]
    fn sessions_expire_by_inactivity_and_by_credential() {
        let store = store(json!({}));
        let alice = principal("alice", "sha256:a", &["hoi4:read"], None);
        let id = open(&store, &alice, 0);
        assert!(store.begin(Some(&id), &alice, 59_999).is_ok());
        store.finish(&id, 59_999);
        assert!(store.begin(Some(&id), &alice, 119_998).is_ok(), "a request renews the inactivity clock");
        // An active request keeps an idle-expired session alive.
        assert!(store.begin(Some(&id), &alice, 500_000).is_ok());
        store.finish(&id, 500_000);
        store.finish(&id, 500_000);
        assert!(store.begin(Some(&id), &alice, 560_001).is_err());
        assert!(!store.contains(&id));

        let expiring = principal("carol", "sha256:c", &["hoi4:read"], Some(10.0));
        let id = open(&store, &expiring, 0);
        assert!(store.begin(Some(&id), &expiring, 9_000).is_ok());
        assert!(store.begin(Some(&id), &expiring, 10_000).is_err(), "credential expiry ends even an active session");
        let expired = principal("dave", "sha256:d", &["hoi4:read"], Some(1.0));
        assert!(matches!(store.reserve(&expired, &[], 1_000), Err(SessionRefusal::Auth { status: 401, .. })));
    }

    #[test]
    fn session_counts_are_bounded_per_server_and_per_principal() {
        let store = store(json!({ "maxSessions": 3, "maxSessionsPerPrincipal": 2 }));
        let alice = principal("alice", "sha256:a", &["hoi4:read"], None);
        let bob = principal("bob", "sha256:b", &["hoi4:read"], None);
        open(&store, &alice, 0);
        let pending = store.reserve(&alice, &[], 0).unwrap();
        assert_eq!(store.reserve(&alice, &[], 0).unwrap_err(), SessionRefusal::Code(429, "principal_session_limit"));
        drop(pending);
        open(&store, &alice, 0);
        open(&store, &bob, 0);
        assert_eq!(store.reserve(&bob, &[], 0).unwrap_err(), SessionRefusal::Code(429, "session_limit"));
    }

    #[test]
    fn event_streams_are_bounded_and_released() {
        let store = store(json!({ "maxEventStreams": 2, "maxEventStreamsPerPrincipal": 1 }));
        let first = store.open_stream("alice").unwrap();
        assert_eq!(store.open_stream("alice").unwrap_err(), SessionRefusal::Code(429, "principal_event_stream_limit"));
        let _second = store.open_stream("bob").unwrap();
        assert_eq!(store.open_stream("carol").unwrap_err(), SessionRefusal::Code(429, "event_stream_limit"));
        drop(first);
        assert!(store.open_stream("alice").is_ok());
    }

    #[test]
    fn removing_a_session_returns_its_event_bytes() {
        let store = store(json!({}));
        let alice = principal("alice", "sha256:a", &["hoi4:read"], None);
        let id = open(&store, &alice, 0);
        store.with_session(&id, |session| session.event_store.store_event("s", &json!({ "x": 1 }), 0));
        assert!(store.event_budget_used() > 0);
        assert!(store.remove(&id));
        assert_eq!(store.event_budget_used(), 0);
    }
}
