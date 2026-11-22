//! A bounded, per-session store of server-sent events for `Last-Event-ID` resumption, with a
//! byte budget shared by every session of one server.
//!
//! Adapted from `src/hoi4_agent_tools/mcp/transports/event-store.ts` (`BoundedEventStore`,
//! `SharedEventStoreBudget`), commit 9b7dc80d.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::random::random_uuid;

/// The aggregate byte budget of every event store of one server.
#[derive(Debug, Clone)]
pub struct SharedEventStoreBudget {
    max_bytes: u64,
    bytes: Arc<Mutex<u64>>,
}

impl SharedEventStoreBudget {
    pub fn new(max_bytes: u64) -> Self {
        Self { max_bytes, bytes: Arc::default() }
    }

    pub fn reserve(&self, bytes: u64) -> bool {
        let mut used = self.bytes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if bytes > self.max_bytes || *used > self.max_bytes - bytes {
            return false;
        }
        *used += bytes;
        true
    }

    pub fn release(&self, bytes: u64) {
        let mut used = self.bytes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *used = used.saturating_sub(bytes);
    }

    pub fn used(&self) -> u64 {
        *self.bytes.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Debug, Clone)]
struct StoredEvent {
    event_id: String,
    stream_id: String,
    message: Value,
    created_at_ms: u64,
    size: u64,
}

/// One session's events, bounded by count, age and bytes.
#[derive(Debug)]
pub struct BoundedEventStore {
    events: VecDeque<StoredEvent>,
    bytes: u64,
    max_events: usize,
    ttl_ms: u64,
    max_bytes: u64,
    budget: Option<SharedEventStoreBudget>,
}

impl BoundedEventStore {
    pub fn new(max_events: usize, ttl_ms: u64, max_bytes: u64, budget: Option<SharedEventStoreBudget>) -> Self {
        Self { events: VecDeque::new(), bytes: 0, max_events, ttl_ms, max_bytes, budget }
    }

    /// Stores an event and returns its id. An event over the per-session or shared budget gets an
    /// id but is not kept, so it cannot be replayed.
    pub fn store_event(&mut self, stream_id: &str, message: &Value, now_ms: u64) -> String {
        self.prune(now_ms);
        let event_id = random_uuid();
        let size = serde_json::to_vec(message).map_or(u64::MAX, |bytes| bytes.len() as u64);
        if size > self.max_bytes || self.budget.as_ref().is_some_and(|budget| !budget.reserve(size)) {
            return event_id;
        }
        self.events.push_back(StoredEvent { event_id: event_id.clone(), stream_id: stream_id.to_owned(), message: message.clone(), created_at_ms: now_ms, size });
        self.bytes += size;
        while self.events.len() > self.max_events || self.bytes > self.max_bytes {
            match self.events.pop_front() {
                Some(removed) => self.release(&removed),
                None => break,
            }
        }
        event_id
    }

    pub fn stream_id_for_event_id(&mut self, event_id: &str, now_ms: u64) -> Option<String> {
        self.prune(now_ms);
        self.events.iter().find(|event| event.event_id == event_id).map(|event| event.stream_id.clone())
    }

    /// The stream of `last_event_id` and the events after it on that stream, in order.
    pub fn replay_events_after(&mut self, last_event_id: &str, now_ms: u64) -> Result<(String, Vec<(String, Value)>), &'static str> {
        self.prune(now_ms);
        let index = self.events.iter().position(|event| event.event_id == last_event_id).ok_or("Event ID is unknown or expired")?;
        let stream_id = self.events[index].stream_id.clone();
        let replay = self.events.iter().skip(index + 1).filter(|event| event.stream_id == stream_id).map(|event| (event.event_id.clone(), event.message.clone())).collect();
        Ok((stream_id, replay))
    }

    fn prune(&mut self, now_ms: u64) {
        let minimum = now_ms.saturating_sub(self.ttl_ms);
        while self.events.front().is_some_and(|event| event.created_at_ms < minimum) {
            if let Some(removed) = self.events.pop_front() {
                self.release(&removed);
            }
        }
    }

    fn release(&mut self, event: &StoredEvent) {
        self.bytes -= event.size;
        if let Some(budget) = &self.budget {
            budget.release(event.size);
        }
    }

    /// Drops every event and returns their bytes to the shared budget.
    pub fn clear(&mut self) {
        if let Some(budget) = &self.budget {
            for event in &self.events {
                budget.release(event.size);
            }
        }
        self.events.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

impl Drop for BoundedEventStore {
    fn drop(&mut self) {
        self.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/unit/event-store.test.ts.
    #[test]
    fn replays_only_the_same_stream_after_the_given_event() {
        let mut store = BoundedEventStore::new(10, 60_000, 1_000_000, None);
        let first = store.store_event("a", &json!({ "n": 1 }), 0);
        store.store_event("b", &json!({ "n": 2 }), 1);
        let third = store.store_event("a", &json!({ "n": 3 }), 2);
        let (stream, replay) = store.replay_events_after(&first, 3).unwrap();
        assert_eq!(stream, "a");
        assert_eq!(replay, vec![(third, json!({ "n": 3 }))]);
        assert!(store.replay_events_after("unknown", 3).is_err());
        assert_eq!(store.stream_id_for_event_id(&first, 3).as_deref(), Some("a"));
    }

    #[test]
    fn bounds_count_age_and_bytes() {
        let mut store = BoundedEventStore::new(2, 1000, 1_000_000, None);
        let first = store.store_event("a", &json!(1), 0);
        store.store_event("a", &json!(2), 0);
        store.store_event("a", &json!(3), 0);
        assert_eq!(store.len(), 2);
        assert!(store.stream_id_for_event_id(&first, 0).is_none());
        store.store_event("a", &json!(4), 5000);
        assert_eq!(store.len(), 1, "events older than the TTL are pruned");
        let mut small = BoundedEventStore::new(10, 1000, 8, None);
        let id = small.store_event("a", &json!("far too large for eight bytes"), 0);
        assert!(!id.is_empty());
        assert!(small.is_empty(), "an oversized event gets an id but is not stored");
    }

    #[test]
    fn shares_one_budget_and_returns_bytes_on_clear_and_drop() {
        let budget = SharedEventStoreBudget::new(10);
        let mut first = BoundedEventStore::new(10, 1000, 1000, Some(budget.clone()));
        let mut second = BoundedEventStore::new(10, 1000, 1000, Some(budget.clone()));
        first.store_event("a", &json!("123456"), 0);
        assert_eq!(budget.used(), 8);
        second.store_event("a", &json!("123456"), 0);
        assert!(second.is_empty(), "the shared budget refuses the second session's event");
        first.clear();
        assert_eq!(budget.used(), 0);
        second.store_event("a", &json!("123456"), 0);
        drop(second);
        assert_eq!(budget.used(), 0);
        assert!(!budget.reserve(11));
    }
}
