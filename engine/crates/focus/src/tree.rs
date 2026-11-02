//! The validated focus graph: focuses indexed in UTF-16 id order, prerequisites, exclusions,
//! lanes, resolved fixed and relative coordinates, and rows (longest-path layering).
//!
//! Every index is the position of the focus in id order, so sorting indices sorts by id and the
//! input order of focuses never reaches the output.

use std::collections::{BTreeSet, HashMap};

use serde_json::json;

use crate::canonical::cmp_utf16;
use crate::model::{Diagnostic, Invalid, Position, Request, Severity};

pub const MAX_FOCUSES: usize = 20_000;
pub const MAX_COORDINATE: i64 = 100_000;
pub const MAX_NODE_SPACING: i64 = 64;
pub const MAX_LANE_SPACING: i64 = 1_000;

#[derive(Debug, Clone)]
pub struct LaneInfo {
    pub id: String,
    pub minimum_x: Option<i64>,
    pub maximum_x: Option<i64>,
}

#[derive(Debug)]
pub struct Tree {
    pub ids: Vec<String>,
    pub lookup: HashMap<String, usize>,
    pub position: Vec<Position>,
    pub pinned: Vec<bool>,
    /// Prerequisite groups as declared (ids, including ones outside the request).
    pub declared_groups: Vec<Vec<Vec<String>>>,
    pub declared_exclusive: Vec<Vec<String>>,
    /// Unique parents and children inside the request, sorted by index.
    pub parents: Vec<Vec<usize>>,
    pub children: Vec<Vec<usize>>,
    /// The first parent inside the request in declared order.
    pub first_parent: Vec<Option<usize>>,
    /// Symmetric, unique, sorted.
    pub exclusive: Vec<Vec<usize>>,
    /// Lane index of each focus; lanes are sorted by (order, id), unlisted lanes after them by id.
    pub lane: Vec<usize>,
    pub lanes: Vec<LaneInfo>,
    pub spacing: i64,
    pub lane_spacing: i64,
    /// Unique (parent, child) links, sorted by child then parent.
    pub edges: Vec<(usize, usize)>,
    pub warnings: Vec<Diagnostic>,
}

impl Tree {
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn names(&self, indices: impl IntoIterator<Item = usize>) -> Vec<String> {
        let mut set: Vec<usize> = indices.into_iter().collect();
        set.sort_unstable();
        set.dedup();
        set.into_iter().map(|i| self.ids[i].clone()).collect()
    }
}

fn check_coordinate(id: &str, value: i64) -> Result<(), Invalid> {
    if value.abs() > MAX_COORDINATE {
        return Err(Invalid::new("FOCUS_ENGINE_LIMIT_EXCEEDED", format!("focus {id} has a coordinate {value} outside -{MAX_COORDINATE}..{MAX_COORDINATE}")));
    }
    Ok(())
}

pub fn build(request: &Request) -> Result<Tree, Invalid> {
    let focuses = &request.focuses;
    if focuses.len() > MAX_FOCUSES {
        return Err(Invalid::new("FOCUS_ENGINE_LIMIT_EXCEEDED", format!("{} focuses; at most {MAX_FOCUSES} are accepted", focuses.len())));
    }
    let spacing = request.options.node_spacing;
    let lane_spacing = request.options.lane_spacing;
    if !(1..=MAX_NODE_SPACING).contains(&spacing) {
        return Err(Invalid::new("FOCUS_ENGINE_OPTION_INVALID", format!("nodeSpacing must be 1..{MAX_NODE_SPACING}, not {spacing}")));
    }
    if !(0..=MAX_LANE_SPACING).contains(&lane_spacing) {
        return Err(Invalid::new("FOCUS_ENGINE_OPTION_INVALID", format!("laneSpacing must be 0..{MAX_LANE_SPACING}, not {lane_spacing}")));
    }

    let mut order: Vec<usize> = (0..focuses.len()).collect();
    order.sort_by(|&a, &b| cmp_utf16(&focuses[a].id, &focuses[b].id));
    let ids: Vec<String> = order.iter().map(|&i| focuses[i].id.clone()).collect();
    for (i, id) in ids.iter().enumerate() {
        if id.is_empty() {
            return Err(Invalid::new("FOCUS_ENGINE_REQUEST_INVALID", "a focus has an empty id"));
        }
        if i > 0 && ids[i - 1] == *id {
            return Err(Invalid::new("FOCUS_ENGINE_DUPLICATE_FOCUS", format!("focus {id} is listed twice")));
        }
    }
    let lookup: HashMap<String, usize> = ids.iter().enumerate().map(|(i, id)| (id.clone(), i)).collect();
    let n = ids.len();

    // Lanes.
    let mut configured: Vec<(i64, String, Option<i64>, Option<i64>)> = Vec::new();
    for lane in &request.lanes {
        if lane.id.is_empty() {
            return Err(Invalid::new("FOCUS_ENGINE_LANE_INVALID", "a lane has an empty id"));
        }
        if configured.iter().any(|(_, id, _, _)| *id == lane.id) {
            return Err(Invalid::new("FOCUS_ENGINE_LANE_INVALID", format!("lane {} is listed twice", lane.id)));
        }
        for v in [lane.minimum_x, lane.maximum_x].into_iter().flatten() {
            check_coordinate(&lane.id, v)?;
        }
        if let (Some(lo), Some(hi)) = (lane.minimum_x, lane.maximum_x)
            && lo > hi
        {
            return Err(Invalid::new("FOCUS_ENGINE_LANE_INVALID", format!("lane {} has minimumX {lo} greater than maximumX {hi}", lane.id)));
        }
        configured.push((lane.order, lane.id.clone(), lane.minimum_x, lane.maximum_x));
    }
    configured.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| cmp_utf16(&a.1, &b.1)));
    let mut lanes: Vec<LaneInfo> = configured.into_iter().map(|(_, id, minimum_x, maximum_x)| LaneInfo { id, minimum_x, maximum_x }).collect();
    let mut unlisted: Vec<String> = Vec::new();
    for &i in &order {
        let lane = focuses[i].lane_id.clone().unwrap_or_else(|| "default".to_string());
        if !lanes.iter().any(|l| l.id == lane) && !unlisted.contains(&lane) {
            unlisted.push(lane);
        }
    }
    unlisted.sort_by(|a, b| cmp_utf16(a, b));
    lanes.extend(unlisted.into_iter().map(|id| LaneInfo { id, minimum_x: None, maximum_x: None }));
    let lane_index: HashMap<&str, usize> = lanes.iter().enumerate().map(|(i, l)| (l.id.as_str(), i)).collect();

    let mut position = Vec::with_capacity(n);
    let mut pinned = Vec::with_capacity(n);
    let mut lane = Vec::with_capacity(n);
    let mut declared_groups = Vec::with_capacity(n);
    let mut declared_exclusive = Vec::with_capacity(n);
    let mut parents = vec![Vec::new(); n];
    let mut children = vec![Vec::new(); n];
    let mut first_parent = vec![None; n];
    let mut exclusive = vec![Vec::new(); n];
    let mut missing_parents: BTreeSet<String> = BTreeSet::new();
    let mut missing_parent_focuses: Vec<usize> = Vec::new();
    let mut missing_exclusive: BTreeSet<String> = BTreeSet::new();
    let mut missing_exclusive_focuses: Vec<usize> = Vec::new();

    for (index, &source) in order.iter().enumerate() {
        let focus = &focuses[source];
        match &focus.position {
            Position::Fixed { x, y } | Position::Relative { x, y, .. } => {
                check_coordinate(&focus.id, *x)?;
                check_coordinate(&focus.id, *y)?;
            }
            Position::Auto { preferred_x, preferred_y } => {
                for v in [preferred_x, preferred_y].into_iter().flatten() {
                    check_coordinate(&focus.id, *v)?;
                }
            }
        }
        position.push(focus.position.clone());
        pinned.push(focus.pinned);
        let lane_id = focus.lane_id.as_deref().unwrap_or("default");
        lane.push(lane_index[lane_id]);
        declared_groups.push(focus.prerequisites.clone());
        declared_exclusive.push(focus.mutually_exclusive.clone());
        let mut missing = false;
        for group in &focus.prerequisites {
            for parent in group {
                match lookup.get(parent) {
                    Some(&p) if p == index => {
                        return Err(Invalid::new("FOCUS_ENGINE_PREREQUISITE_CYCLE", format!("focus {} is its own prerequisite", focus.id)));
                    }
                    Some(&p) => {
                        if first_parent[index].is_none() {
                            first_parent[index] = Some(p);
                        }
                        parents[index].push(p);
                    }
                    None => {
                        missing = true;
                        missing_parents.insert(parent.clone());
                    }
                }
            }
        }
        if missing {
            missing_parent_focuses.push(index);
        }
        let mut missing = false;
        for other in &focus.mutually_exclusive {
            match lookup.get(other) {
                Some(&o) if o != index => {
                    exclusive[index].push(o);
                    exclusive[o].push(index);
                }
                Some(_) => {}
                None => {
                    missing = true;
                    missing_exclusive.insert(other.clone());
                }
            }
        }
        if missing {
            missing_exclusive_focuses.push(index);
        }
    }
    for list in parents.iter_mut().chain(exclusive.iter_mut()) {
        list.sort_unstable();
        list.dedup();
    }
    let mut edges = Vec::new();
    for (child, ps) in parents.iter().enumerate() {
        for &p in ps {
            children[p].push(child);
            edges.push((p, child));
        }
    }

    let mut warnings = Vec::new();
    if !missing_parent_focuses.is_empty() {
        let missing: Vec<&String> = sorted_utf16(&missing_parents);
        warnings.push(Diagnostic {
            code: "FOCUS_ENGINE_PREREQUISITE_OUTSIDE_REQUEST",
            severity: Severity::Warning,
            focus_ids: missing_parent_focuses.iter().map(|&i| ids[i].clone()).collect(),
            message: "Prerequisites name focuses that are not in the request; they are ignored for placement".into(),
            details: json!({ "missing": missing }),
        });
    }
    if !missing_exclusive_focuses.is_empty() {
        let missing: Vec<&String> = sorted_utf16(&missing_exclusive);
        warnings.push(Diagnostic {
            code: "FOCUS_ENGINE_EXCLUSION_OUTSIDE_REQUEST",
            severity: Severity::Warning,
            focus_ids: missing_exclusive_focuses.iter().map(|&i| ids[i].clone()).collect(),
            message: "mutuallyExclusive names focuses that are not in the request; they are ignored for placement".into(),
            details: json!({ "missing": missing }),
        });
    }

    let tree = Tree {
        ids,
        lookup,
        position,
        pinned,
        declared_groups,
        declared_exclusive,
        parents,
        children,
        first_parent,
        exclusive,
        lane,
        lanes,
        spacing,
        lane_spacing,
        edges,
        warnings,
    };
    check_prerequisite_cycles(&tree)?;
    Ok(tree)
}

fn sorted_utf16(set: &BTreeSet<String>) -> Vec<&String> {
    let mut v: Vec<&String> = set.iter().collect();
    v.sort_by(|a, b| cmp_utf16(a, b));
    v
}

fn check_prerequisite_cycles(tree: &Tree) -> Result<(), Invalid> {
    let n = tree.len();
    let mut indegree: Vec<usize> = tree.parents.iter().map(Vec::len).collect();
    let mut stack: Vec<usize> = (0..n).filter(|&i| indegree[i] == 0).collect();
    let mut seen = 0;
    while let Some(v) = stack.pop() {
        seen += 1;
        for &c in &tree.children[v] {
            indegree[c] -= 1;
            if indegree[c] == 0 {
                stack.push(c);
            }
        }
    }
    if seen < n {
        let cyclic: Vec<usize> = (0..n).filter(|&i| indegree[i] > 0).take(10).collect();
        return Err(Invalid::new("FOCUS_ENGINE_PREREQUISITE_CYCLE", format!("prerequisites form a cycle through {}", tree.names(cyclic).join(", "))));
    }
    Ok(())
}

/// Coordinates known before placement, and the focuses whose coordinates depend on it.
pub struct Resolved {
    /// Fixed focuses and relative chains that end at a fixed focus.
    pub known: Vec<Option<(i64, i64)>>,
    /// Relative focuses whose chain ends at a focus this call places.
    pub attached: Vec<bool>,
}

/// Resolves fixed and relative coordinates; `placed` focuses are computed by the call.
pub fn resolve(tree: &Tree, placed: &[bool]) -> Result<Resolved, Invalid> {
    let n = tree.len();
    // 0 = unvisited, 1 = on the current chain, 2 = done.
    let mut state = vec![0u8; n];
    let mut known: Vec<Option<(i64, i64)>> = vec![None; n];
    let mut attached = vec![false; n];
    for start in 0..n {
        if state[start] == 2 {
            continue;
        }
        let mut chain = Vec::new();
        let mut v = start;
        // Walk to a focus whose state is settled.
        let base: Option<(i64, i64)>;
        let mut base_attached = false;
        loop {
            if state[v] == 2 {
                base = known[v];
                base_attached = attached[v] || placed[v];
                break;
            }
            if state[v] == 1 {
                return Err(Invalid::new("FOCUS_ENGINE_RELATIVE_CYCLE", format!("relative positions form a cycle through {}", tree.ids[v])));
            }
            if placed[v] {
                state[v] = 2;
                base = None;
                base_attached = true;
                break;
            }
            match &tree.position[v] {
                Position::Fixed { x, y } => {
                    state[v] = 2;
                    known[v] = Some((*x, *y));
                    base = known[v];
                    break;
                }
                Position::Auto { .. } => {
                    state[v] = 2;
                    base = None;
                    break;
                }
                Position::Relative { relative_to, .. } => {
                    let Some(&anchor) = tree.lookup.get(relative_to) else {
                        return Err(Invalid::new(
                            "FOCUS_ENGINE_UNKNOWN_ANCHOR",
                            format!("focus {} is relative to {relative_to}, which is not in the request", tree.ids[v]),
                        ));
                    };
                    state[v] = 1;
                    chain.push(v);
                    v = anchor;
                }
            }
        }
        let mut current = base;
        for &w in chain.iter().rev() {
            let Position::Relative { x, y, .. } = &tree.position[w] else { unreachable!() };
            current = current.map(|(bx, by)| (bx + x, by + y));
            known[w] = current;
            attached[w] = current.is_none() && base_attached;
            state[w] = 2;
        }
    }
    Ok(Resolved { known, attached })
}

/// Rows for placed and attached focuses: a placed focus sits one row below its lowest parent (row 0
/// without parents) or on its `preferredY` when that is lower down; an attached focus keeps its
/// offset from its anchor. Returns the rows and the order in which attached focuses resolve.
pub fn layer(tree: &Tree, placed: &[bool], resolved: &Resolved) -> Result<(Vec<Option<i64>>, Vec<usize>), Invalid> {
    let n = tree.len();
    let mut y: Vec<Option<i64>> = resolved.known.iter().map(|p| p.map(|(_, y)| y)).collect();
    let in_set = |v: usize| placed[v] || resolved.attached[v];
    let anchor_of = |v: usize| -> usize {
        match &tree.position[v] {
            Position::Relative { relative_to, .. } => tree.lookup[relative_to],
            _ => unreachable!(),
        }
    };
    // Dependents: parent -> placed child, anchor -> attached focus.
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut indegree = vec![0usize; n];
    for v in 0..n {
        if placed[v] {
            for &p in &tree.parents[v] {
                if in_set(p) {
                    dependents[p].push(v);
                    indegree[v] += 1;
                }
            }
        } else if resolved.attached[v] {
            let a = anchor_of(v);
            dependents[a].push(v);
            indegree[v] += 1;
        }
    }
    let mut ready: BTreeSet<usize> = (0..n).filter(|&v| in_set(v) && indegree[v] == 0).collect();
    let mut attached_order = Vec::new();
    let mut done = 0;
    let total = (0..n).filter(|&v| in_set(v)).count();
    while let Some(v) = ready.pop_first() {
        done += 1;
        if placed[v] {
            let lowest = tree.parents[v].iter().filter_map(|&p| y[p]).max();
            let base = lowest.map_or(0, |l| l + 1);
            y[v] = Some(base.max(tree.position[v].preferred_y().unwrap_or(i64::MIN)));
        } else {
            let a = anchor_of(v);
            let Position::Relative { y: dy, .. } = &tree.position[v] else { unreachable!() };
            y[v] = y[a].map(|ay| ay + dy);
            attached_order.push(v);
        }
        for &d in &dependents[v] {
            indegree[d] -= 1;
            if indegree[d] == 0 {
                ready.insert(d);
            }
        }
    }
    if done < total {
        let stuck: Vec<usize> = (0..n).filter(|&v| in_set(v) && indegree[v] > 0).take(10).collect();
        return Err(Invalid::new(
            "FOCUS_ENGINE_ANCHOR_CYCLE",
            format!("relative anchors and prerequisites depend on each other through {}", tree.names(stuck).join(", ")),
        ));
    }
    Ok((y, attached_order))
}
