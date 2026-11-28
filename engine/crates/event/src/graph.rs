//! The event graph snapshot, in its TypeScript wire shape.
//!
//! Adapted from `src/hoi4_agent_tools/event/model.ts` (`EventGraphNode`, `EventGraphEdge`) at
//! the port branch. Only the fields the algorithms read are typed; every other field is kept in
//! `rest`, so a node or an edge serializes back unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub reason: String,
    #[serde(default)]
    pub conditions: Vec<Value>,
    #[serde(default)]
    pub helper_stack: Vec<String>,
    #[serde(default)]
    pub provenance: Vec<Value>,
    pub confidence: String,
    #[serde(default)]
    pub derived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Value>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// The parts of `EventGraphSnapshot` the algorithms need.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Node {
    pub fn is_helper(&self) -> bool {
        self.kind == "helper"
    }
}
