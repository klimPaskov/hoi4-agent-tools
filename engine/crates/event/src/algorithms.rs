//! Bounded traces, shortest paths, strongly connected components and reachability over the
//! event graph.
//!
//! Adapted from `src/hoi4_agent_tools/event/algorithms.ts` (`eventFlowEdges`, `traceEventGraph`,
//! `shortestEventPath`, `eventStronglyConnectedComponents`, `reachableEventNodeIds`, the lazy
//! helper collapse) and `scc.ts` (`iterativeStronglyConnectedComponents`) at the port branch.
//! Issue 278 is fixed here: a path search over a graph with helper nodes and no derived edge
//! collapses helpers lazily, as the trace does, instead of dropping every route through a helper.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use hoi4_core::canonical::{compare_code_units, hash_canonical};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::graph::{Edge, Graph, Node};

/// The fixed work ceiling of one analysis (`EVENT_GRAPH_WORK_LIMIT`).
pub const WORK_LIMIT: u64 = 10_000_000;
/// The longest helper chain a collapsed edge may cross.
const MAX_COLLAPSE_PATH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upstream,
    Downstream,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub max_depth: u64,
    pub max_nodes: usize,
    pub max_edges: usize,
    pub direction: Direction,
    pub expand_helpers: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub depth: u64,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub start_node_ids: Vec<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub layers: Vec<Layer>,
    pub boundary: Boundary,
    pub boundary_node_ids: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub node_ids: Vec<String>,
    pub cyclic: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    pub node_ids: Vec<String>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Copy)]
pub struct PathOptions {
    pub expand_helpers: bool,
    pub max_depth: u64,
    pub max_nodes: usize,
}

/// `EVENT_ANALYSIS_WORK_BLOCKED`: the fixed work ceiling was passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkBlocked {
    pub label: &'static str,
    pub spent: u64,
}

fn sort_ids(ids: &mut [String]) {
    ids.sort_by(|a, b| compare_code_units(a, b));
}

fn sorted_unique(values: &[String]) -> Vec<String> {
    let set: BTreeSet<&String> = values.iter().collect();
    let mut out: Vec<String> = set.into_iter().cloned().collect();
    sort_ids(&mut out);
    out
}

fn node_map(graph: &Graph) -> HashMap<&str, &Node> {
    graph.nodes.iter().map(|node| (node.id.as_str(), node)).collect()
}

fn layers(depth_by_node: &HashMap<String, u64>) -> Vec<Layer> {
    let mut by_depth: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    for (id, depth) in depth_by_node {
        by_depth.entry(*depth).or_default().push(id.clone());
    }
    by_depth
        .into_iter()
        .map(|(depth, mut node_ids)| {
            sort_ids(&mut node_ids);
            Layer { depth, node_ids }
        })
        .collect()
}

/// The structural helper graph or its event-to-event projection (`eventFlowEdges`). Direct,
/// option, entry, unresolved and terminal edges stay visible in both.
pub fn flow_edges(graph: &Graph, expand_helpers: bool) -> Vec<&Edge> {
    let nodes = node_map(graph);
    let helper = |id: &str| nodes.get(id).is_some_and(|node| node.is_helper());
    let mut out: Vec<&Edge> =
        graph.edges.iter().filter(|edge| if expand_helpers { !edge.derived } else { edge.derived || (!helper(&edge.from) && !helper(&edge.to)) }).collect();
    out.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    out
}

struct EdgeMaps<'a> {
    outgoing: HashMap<&'a str, Vec<&'a Edge>>,
    incoming: HashMap<&'a str, Vec<&'a Edge>>,
}

fn edge_maps<'a>(edges: impl IntoIterator<Item = &'a Edge>) -> EdgeMaps<'a> {
    let mut outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
    let mut incoming: HashMap<&str, Vec<&Edge>> = HashMap::new();
    for edge in edges {
        outgoing.entry(edge.from.as_str()).or_default().push(edge);
        incoming.entry(edge.to.as_str()).or_default().push(edge);
    }
    for list in outgoing.values_mut().chain(incoming.values_mut()) {
        list.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    }
    EdgeMaps { outgoing, incoming }
}

fn helper_name(node: &Node) -> String {
    if let Some(Value::String(name)) = node.metadata.get("name") {
        return name.clone();
    }
    if !node.label.is_empty() {
        return node.label.clone();
    }
    node.id.strip_prefix("helper:").unwrap_or(&node.id).to_string()
}

fn collapsed_helper_edge<'a>(path: &[&'a Edge], helper_stack: &[String], from: &str, to: &str) -> Cow<'a, Edge> {
    let first = path[0];
    let last = path[path.len() - 1];
    if helper_stack.is_empty() {
        return Cow::Borrowed(first);
    }
    let ids: Vec<&str> = path.iter().map(|edge| edge.id.as_str()).collect();
    let digest = hash_canonical(&json!({ "from": from, "to": to, "edges": ids }));
    let structural: Vec<Value> = ids.iter().map(|id| Value::String((*id).to_string())).collect();
    let mut metadata = serde_json::Map::new();
    metadata.insert("structuralEdgeIds".to_string(), Value::Array(structural));
    let mut rest = serde_json::Map::new();
    if let Some(location) = first.rest.get("location") {
        rest.insert("location".to_string(), location.clone());
    }
    Cow::Owned(Edge {
        id: format!("edge:lazy-helper-projection:{}", &digest[..32]),
        from: from.to_string(),
        to: to.to_string(),
        reason: "scripted_effect_expansion".to_string(),
        conditions: path.iter().flat_map(|edge| edge.conditions.iter().cloned()).collect(),
        helper_stack: helper_stack.to_vec(),
        provenance: path.iter().flat_map(|edge| edge.provenance.iter().cloned()).collect(),
        confidence: last.confidence.clone(),
        derived: true,
        timing: last.timing.clone(),
        weight: last.weight.clone(),
        scope: last.scope.clone(),
        metadata,
        rest,
    })
}

struct Collapse<'a, 'g> {
    nodes: &'g HashMap<&'a str, &'a Node>,
    maps: &'g EdgeMaps<'a>,
    node_id: &'g str,
    maximum_paths: usize,
    path_visits: usize,
    retained: BTreeMap<String, Cow<'a, Edge>>,
}

impl<'a> Collapse<'a, '_> {
    fn downstream(&mut self, edge: &'a Edge, path: &mut Vec<&'a Edge>, stack: &mut Vec<String>, visited: &mut Vec<&'a str>) {
        self.path_visits += 1;
        if self.path_visits > self.maximum_paths || path.len() > MAX_COLLAPSE_PATH {
            return;
        }
        let target = self.nodes.get(edge.to.as_str()).copied();
        let Some(target) = target.filter(|node| node.is_helper()) else {
            let collapsed = collapsed_helper_edge(path, stack, self.node_id, &edge.to);
            self.retained.insert(collapsed.id.clone(), collapsed);
            return;
        };
        if visited.contains(&target.id.as_str()) {
            return;
        }
        let nexts: Vec<&'a Edge> = self.maps.outgoing.get(target.id.as_str()).cloned().unwrap_or_default();
        for next in nexts {
            path.push(next);
            stack.push(helper_name(target));
            visited.push(target.id.as_str());
            self.downstream(next, path, stack, visited);
            visited.pop();
            stack.pop();
            path.pop();
        }
    }

    fn upstream(&mut self, edge: &'a Edge, path: &mut Vec<&'a Edge>, stack: &mut Vec<String>, visited: &mut Vec<&'a str>) {
        self.path_visits += 1;
        if self.path_visits > self.maximum_paths || path.len() > MAX_COLLAPSE_PATH {
            return;
        }
        let source = self.nodes.get(edge.from.as_str()).copied();
        let Some(source) = source.filter(|node| node.is_helper()) else {
            let forward: Vec<&'a Edge> = path.iter().rev().copied().collect();
            let forward_stack: Vec<String> = stack.iter().rev().cloned().collect();
            let collapsed = collapsed_helper_edge(&forward, &forward_stack, &edge.from, self.node_id);
            self.retained.insert(collapsed.id.clone(), collapsed);
            return;
        };
        if visited.contains(&source.id.as_str()) {
            return;
        }
        let previous: Vec<&'a Edge> = self.maps.incoming.get(source.id.as_str()).cloned().unwrap_or_default();
        for prev in previous {
            path.push(prev);
            stack.push(helper_name(source));
            visited.push(source.id.as_str());
            self.upstream(prev, path, stack, visited);
            visited.pop();
            stack.pop();
            path.pop();
        }
    }
}

/// Builds only the helper projections one bounded trace reaches (`lazyCollapsedEdges`).
fn lazy_collapsed_edges<'a>(
    nodes: &HashMap<&'a str, &'a Node>,
    node_id: &str,
    direction: Direction,
    maps: &EdgeMaps<'a>,
    maximum_paths: usize,
) -> Vec<Cow<'a, Edge>> {
    let mut collapse = Collapse { nodes, maps, node_id, maximum_paths, path_visits: 0, retained: BTreeMap::new() };
    if direction != Direction::Upstream {
        for edge in maps.outgoing.get(node_id).cloned().unwrap_or_default() {
            collapse.downstream(edge, &mut vec![edge], &mut Vec::new(), &mut Vec::new());
        }
    }
    if direction != Direction::Downstream {
        for edge in maps.incoming.get(node_id).cloned().unwrap_or_default() {
            collapse.upstream(edge, &mut vec![edge], &mut Vec::new(), &mut Vec::new());
        }
    }
    let mut out: Vec<Cow<'a, Edge>> = collapse.retained.into_values().collect();
    out.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    out
}

struct Walk {
    depth_by_node: HashMap<String, u64>,
    queue: Vec<String>,
    retained_edges: HashMap<String, Edge>,
    boundary_nodes: BTreeSet<String>,
    truncated: bool,
}

impl Walk {
    fn new(starts: &[String]) -> Self {
        Walk {
            depth_by_node: starts.iter().map(|id| (id.clone(), 0)).collect(),
            queue: starts.to_vec(),
            retained_edges: HashMap::new(),
            boundary_nodes: BTreeSet::new(),
            truncated: false,
        }
    }
}

fn finish(graph: &Graph, starts: Vec<String>, boundary: &Boundary, walk: Walk) -> Trace {
    let by_id = node_map(graph);
    let mut nodes: Vec<Node> = walk.depth_by_node.keys().filter_map(|id| by_id.get(id.as_str()).map(|n| (*n).clone())).collect();
    nodes.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    let layers = layers(&walk.depth_by_node);
    let mut edges: Vec<Edge> = walk.retained_edges.into_values().collect();
    edges.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    let mut boundary_node_ids: Vec<String> = walk.boundary_nodes.into_iter().collect();
    sort_ids(&mut boundary_node_ids);
    Trace { start_node_ids: starts, nodes, edges, layers, boundary: boundary.clone(), boundary_node_ids, truncated: walk.truncated }
}

fn edges_for_direction<'a>(node_id: &str, direction: Direction, maps: &EdgeMaps<'a>) -> Vec<(&'a Edge, &'a str)> {
    let mut results: Vec<(&Edge, &str)> = Vec::new();
    if direction != Direction::Upstream {
        for edge in maps.outgoing.get(node_id).into_iter().flatten() {
            results.push((edge, edge.to.as_str()));
        }
    }
    if direction != Direction::Downstream {
        for edge in maps.incoming.get(node_id).into_iter().flatten() {
            results.push((edge, edge.from.as_str()));
        }
    }
    results.sort_by(|a, b| compare_code_units(a.1, b.1).then_with(|| compare_code_units(&a.0.id, &b.0.id)));
    results
}

fn trace_collapsed(graph: &Graph, starts: Vec<String>, boundary: &Boundary) -> Trace {
    let by_id = node_map(graph);
    let maps = edge_maps(graph.edges.iter().filter(|edge| !edge.derived));
    let mut edge_cache: HashMap<String, Vec<Cow<'_, Edge>>> = HashMap::new();
    let maximum_paths = 256.max(boundary.max_edges.saturating_mul(2));
    let mut walk = Walk::new(&starts);
    let mut cursor = 0;
    while cursor < walk.queue.len() {
        let current = walk.queue[cursor].clone();
        cursor += 1;
        let depth = walk.depth_by_node.get(&current).copied().unwrap_or(0);
        let next_edges = edge_cache.entry(current.clone()).or_insert_with(|| lazy_collapsed_edges(&by_id, &current, boundary.direction, &maps, maximum_paths));
        if depth >= boundary.max_depth {
            if !next_edges.is_empty() {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
            }
            continue;
        }
        for edge in next_edges.iter() {
            if walk.retained_edges.len() >= boundary.max_edges {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
                break;
            }
            let next = match boundary.direction {
                Direction::Upstream => &edge.from,
                Direction::Downstream => &edge.to,
                Direction::Both => {
                    if edge.from == current {
                        &edge.to
                    } else {
                        &edge.from
                    }
                }
            };
            let known = walk.depth_by_node.contains_key(next);
            if !known && walk.depth_by_node.len() >= boundary.max_nodes {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
                continue;
            }
            walk.retained_edges.insert(edge.id.clone(), edge.as_ref().clone());
            if !known {
                walk.depth_by_node.insert(next.clone(), depth + 1);
                walk.queue.push(next.clone());
            }
        }
    }
    finish(graph, starts, boundary, walk)
}

/// A bounded breadth-first trace from the start nodes (`traceEventGraph`).
pub fn trace(graph: &Graph, start_node_ids: &[String], boundary: &Boundary) -> Trace {
    let by_id = node_map(graph);
    let resolved: Vec<String> = sorted_unique(start_node_ids).into_iter().filter(|id| by_id.contains_key(id.as_str())).collect();
    let starts: Vec<String> = resolved.iter().take(boundary.max_nodes).cloned().collect();
    if !boundary.expand_helpers
        && !graph.edges.iter().any(|edge| edge.derived)
        && starts.iter().all(|id| by_id.get(id.as_str()).is_none_or(|node| !node.is_helper()))
    {
        return trace_collapsed(graph, starts, boundary);
    }
    let edges = flow_edges(graph, boundary.expand_helpers);
    let maps = edge_maps(edges.iter().copied());
    let mut walk = Walk::new(&starts);
    if resolved.len() > starts.len() {
        walk.boundary_nodes = starts.iter().cloned().collect();
        walk.truncated = true;
    }
    let mut cursor = 0;
    while cursor < walk.queue.len() {
        let current = walk.queue[cursor].clone();
        cursor += 1;
        let depth = walk.depth_by_node.get(&current).copied().unwrap_or(0);
        let next_edges = edges_for_direction(&current, boundary.direction, &maps);
        if depth >= boundary.max_depth {
            if !next_edges.is_empty() {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
            }
            continue;
        }
        for (edge, next) in next_edges {
            if walk.retained_edges.len() >= boundary.max_edges {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
                break;
            }
            let known = walk.depth_by_node.contains_key(next);
            if !known && walk.depth_by_node.len() >= boundary.max_nodes {
                walk.boundary_nodes.insert(current.clone());
                walk.truncated = true;
                continue;
            }
            walk.retained_edges.insert(edge.id.clone(), edge.clone());
            if !known {
                walk.depth_by_node.insert(next.to_string(), depth + 1);
                walk.queue.push(next.to_string());
            }
        }
    }
    finish(graph, starts, boundary, walk)
}

/// The shortest route between two node sets (`shortestEventPath`), or `None`.
pub fn shortest_path(graph: &Graph, from: &[String], to: &[String], options: PathOptions) -> Option<PathResult> {
    let nodes = node_map(graph);
    let starts: Vec<String> = sorted_unique(from).into_iter().filter(|id| nodes.contains_key(id.as_str())).collect();
    let targets: HashSet<&str> = to.iter().map(String::as_str).filter(|id| nodes.contains_key(id)).collect();
    // Issue 278: a focused graph has helper nodes and no derived edge, so the collapsed
    // projection is built lazily per node, as the trace does.
    let lazy = !options.expand_helpers && !graph.edges.iter().any(|edge| edge.derived) && graph.nodes.iter().any(Node::is_helper);
    let structural = lazy.then(|| edge_maps(graph.edges.iter().filter(|edge| !edge.derived)));
    let flow = if lazy { Vec::new() } else { flow_edges(graph, options.expand_helpers) };
    let flow_maps = edge_maps(flow.iter().copied());
    let maximum_paths = 256.max(options.max_nodes.saturating_mul(2));
    let outgoing = |node_id: &str| -> Vec<Cow<'_, Edge>> {
        match &structural {
            Some(maps) => lazy_collapsed_edges(&nodes, node_id, Direction::Downstream, maps, maximum_paths),
            None => flow_maps.outgoing.get(node_id).into_iter().flatten().map(|edge| Cow::Borrowed(*edge)).collect(),
        }
    };
    let mut queue: VecDeque<(String, u64)> = starts.iter().map(|id| (id.clone(), 0)).collect();
    let mut visited: HashSet<String> = starts.iter().cloned().collect();
    let mut predecessor: HashMap<String, (String, Edge)> = HashMap::new();
    let mut found: Option<String> = starts.iter().find(|id| targets.contains(id.as_str())).cloned();
    while found.is_none() {
        let Some((current, depth)) = queue.pop_front() else { break };
        if depth >= options.max_depth {
            continue;
        }
        for edge in outgoing(&current) {
            if visited.contains(&edge.to) {
                continue;
            }
            if visited.len() >= options.max_nodes {
                return None;
            }
            visited.insert(edge.to.clone());
            predecessor.insert(edge.to.clone(), (current.clone(), edge.as_ref().clone()));
            if targets.contains(edge.to.as_str()) {
                found = Some(edge.to.clone());
                break;
            }
            queue.push_back((edge.to.clone(), depth + 1));
        }
    }
    let found = found?;
    let mut node_ids = vec![found.clone()];
    let mut edges = Vec::new();
    let mut cursor = found;
    while !starts.contains(&cursor) {
        let (previous, edge) = predecessor.get(&cursor)?;
        edges.push(edge.clone());
        cursor = previous.clone();
        node_ids.push(cursor.clone());
    }
    node_ids.reverse();
    edges.reverse();
    Some(PathResult { node_ids, edges })
}

struct Frame {
    node: String,
    neighbours: Vec<String>,
    cursor: usize,
}

/// Deterministic, non-recursive Tarjan traversal (`iterativeStronglyConnectedComponents`).
/// `spend` runs for every discovered node, inspected edge and popped component member.
pub fn strongly_connected(
    node_ids: &[String],
    outgoing: &HashMap<String, Vec<String>>,
    spend: &mut dyn FnMut() -> Result<(), WorkBlocked>,
) -> Result<Vec<Vec<String>>, WorkBlocked> {
    let ordered = sorted_unique(node_ids);
    let retained: HashSet<&str> = ordered.iter().map(String::as_str).collect();
    let neighbours_for = |node: &str| -> Vec<String> {
        let unique: BTreeSet<&String> = outgoing.get(node).into_iter().flatten().filter(|n| retained.contains(n.as_str())).collect();
        let mut list: Vec<String> = unique.into_iter().cloned().collect();
        sort_ids(&mut list);
        list
    };
    let mut next_index = 0usize;
    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut low: HashMap<String, usize> = HashMap::new();
    let mut stack: Vec<String> = Vec::new();
    let mut on_stack: HashSet<String> = HashSet::new();
    let mut components: Vec<Vec<String>> = Vec::new();
    for root in &ordered {
        if indexes.contains_key(root) {
            continue;
        }
        let mut frames: Vec<Frame> = Vec::new();
        macro_rules! enter {
            ($node:expr) => {{
                let node: &str = $node;
                spend()?;
                indexes.insert(node.to_string(), next_index);
                low.insert(node.to_string(), next_index);
                next_index += 1;
                stack.push(node.to_string());
                on_stack.insert(node.to_string());
                frames.push(Frame { node: node.to_string(), neighbours: neighbours_for(node), cursor: 0 });
            }};
        }
        enter!(root);
        while let Some(frame) = frames.last_mut() {
            if let Some(target) = frame.neighbours.get(frame.cursor).cloned() {
                frame.cursor += 1;
                spend()?;
                if !indexes.contains_key(&target) {
                    enter!(&target);
                    continue;
                }
                if on_stack.contains(&target) {
                    let node = frame.node.clone();
                    let value = low[&node].min(indexes[&target]);
                    low.insert(node, value);
                }
                continue;
            }
            let finished = frames.pop().expect("a frame was just read");
            if let Some(parent) = frames.last() {
                let value = low[&parent.node].min(low[&finished.node]);
                low.insert(parent.node.clone(), value);
            }
            if low[&finished.node] != indexes[&finished.node] {
                continue;
            }
            let mut component = Vec::new();
            loop {
                spend()?;
                let Some(member) = stack.pop() else { break };
                on_stack.remove(&member);
                let done = member == finished.node;
                component.push(member);
                if done {
                    break;
                }
            }
            sort_ids(&mut component);
            components.push(component);
        }
    }
    Ok(components)
}

/// Stable, bounded SCCs over the selected flow projection (`eventStronglyConnectedComponents`).
pub fn components(graph: &Graph, expand_helpers: bool, selected: Option<&HashSet<String>>) -> Result<Vec<Component>, WorkBlocked> {
    let mut retained_nodes: Vec<String> = graph.nodes.iter().filter(|n| selected.is_none_or(|s| s.contains(&n.id))).map(|n| n.id.clone()).collect();
    sort_ids(&mut retained_nodes);
    let retained: HashSet<&str> = retained_nodes.iter().map(String::as_str).collect();
    let edges: Vec<&Edge> =
        flow_edges(graph, expand_helpers).into_iter().filter(|e| retained.contains(e.from.as_str()) && retained.contains(e.to.as_str())).collect();
    let maps = edge_maps(edges.iter().copied());
    let adjacency: HashMap<String, Vec<String>> =
        maps.outgoing.iter().map(|(id, list)| ((*id).to_string(), list.iter().map(|e| e.to.clone()).collect())).collect();
    let mut spent = 0u64;
    let mut spend = || {
        spent += 1;
        if spent > WORK_LIMIT { Err(WorkBlocked { label: "strongly_connected_components", spent }) } else { Ok(()) }
    };
    let found = strongly_connected(&retained_nodes, &adjacency, &mut spend)?;
    let self_loops: HashSet<&str> = edges.iter().filter(|e| e.from == e.to).map(|e| e.from.as_str()).collect();
    let mut out: Vec<Component> = found
        .into_iter()
        .map(|node_ids| {
            let cyclic = node_ids.len() > 1 || node_ids.iter().any(|id| self_loops.contains(id.as_str()));
            Component { id: format!("scc:{}", node_ids.join("|")), node_ids, cyclic }
        })
        .collect();
    out.sort_by(|a, b| compare_code_units(&a.id, &b.id));
    Ok(out)
}

/// Every node a trace reaches in one direction (`reachableEventNodeIds`).
pub fn reachable(graph: &Graph, start_node_ids: &[String], direction: Direction, expand_helpers: bool) -> Vec<String> {
    let boundary = Boundary { max_depth: u64::MAX, max_nodes: graph.nodes.len().max(1), max_edges: graph.edges.len().max(1), direction, expand_helpers };
    trace(graph, start_node_ids, &boundary).nodes.into_iter().map(|node| node.id).collect()
}
