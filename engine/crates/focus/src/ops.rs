//! The two operations, `layout` and `insert`, and the shared response assembly.

use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{Value, json};

use crate::band::{self, BandInput};
use crate::canonical::{cmp_utf16, hash_value};
use crate::geometry::{self, Bundles};
use crate::model::{
    Diagnostic, Direction, Hashes, Invalid, Metrics, NeedsRoom, NodeOut, Operation, Position, RESPONSE_SCHEMA, Request, Response, Severity, Shift, SourceOut,
    Status,
};
use crate::place::{Band, Mode, Occupancy, Search, propose_shift};
use crate::tree::{self, Tree};

/// Candidate offsets searched on each side of the preferred one.
pub const SEARCH_WINDOW: i64 = 64;

pub fn run(request: &Request, started: Instant) -> Result<Response, Invalid> {
    let tree = tree::build(request)?;
    match request.operation {
        Operation::Layout => {
            if request.insert.is_some() {
                return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", "insert is only allowed with operation insert"));
            }
            layout(request, &tree, started)
        }
        Operation::Insert => insert(request, &tree, started),
    }
}

struct Context<'a> {
    request: &'a Request,
    tree: &'a Tree,
    started: Instant,
    diagnostics: Vec<Diagnostic>,
}

fn diagnostic(
    code: &'static str,
    severity: Severity,
    tree: &Tree,
    focuses: impl IntoIterator<Item = usize>,
    message: impl Into<String>,
    details: Value,
) -> Diagnostic {
    Diagnostic { code, severity, focus_ids: tree.names(focuses), message: message.into(), details }
}

// ---------------------------------------------------------------------------------------------
// layout

fn layout(request: &Request, tree: &Tree, started: Instant) -> Result<Response, Invalid> {
    let n = tree.len();
    let placed: Vec<bool> = tree.position.iter().map(Position::is_auto).collect();
    if let Some(v) = (0..n).find(|&v| placed[v] && tree.pinned[v]) {
        return Err(Invalid::new("FOCUS_ENGINE_PINNED_AUTO", format!("focus {} is pinned but has no coordinates to keep (mode auto)", tree.ids[v])));
    }
    let resolved = tree::resolve(tree, &placed)?;
    let (rows, attached_order) = tree::layer(tree, &placed, &resolved)?;
    let mut ctx = Context { request, tree, started, diagnostics: tree.warnings.clone() };
    let bundles = Bundles::new(&tree.children);
    let sp = tree.spacing;

    let mut position: Vec<Option<(i64, i64)>> = resolved.known.clone();
    let mut any_bounds = false;
    for (lane_index, lane) in tree.lanes.iter().enumerate() {
        let members: Vec<usize> = (0..n).filter(|&v| placed[v] && tree.lane[v] == lane_index).collect();
        if members.is_empty() {
            continue;
        }
        any_bounds |= lane.minimum_x.is_some() || lane.maximum_x.is_some();
        let known_x: Vec<Option<i64>> = position.iter().map(|p| p.map(|(x, _)| x)).collect();
        let laid = band::layout(&BandInput { tree, members: &members, y: &rows, known_x: &known_x, spacing: sp });
        let band = Band { members: &members, x: &laid.x, y: members.iter().map(|&m| rows[m].expect("row")).collect() };
        let (blo, bhi) = band.extent();
        let occupancy = Occupancy::new(&position);
        let preferred = if laid.anchored {
            0
        } else {
            match occupancy.extent() {
                Some((_, hi)) => hi + sp + tree.lane_spacing - blo,
                None => -blo,
            }
        };
        let lo = lane.minimum_x.map(|m| m - blo);
        let hi = lane.maximum_x.map(|m| m - bhi);
        let feasible = match (lo, hi) {
            (Some(l), Some(h)) => l <= h,
            _ => true,
        };
        let search = Search { tree, bundles: &bundles, occupancy: &occupancy, position: &position, spacing: sp };
        let mode = if laid.anchored { Mode::Cost { side: crate::model::Side::Either, window: SEARCH_WINDOW } } else { Mode::Pack };
        let clamp = |o: i64| -> i64 {
            let o = lo.map_or(o, |l| o.max(l));
            hi.map_or(o, |h| o.min(h))
        };
        let mut chosen = None;
        if feasible {
            let start = clamp(preferred);
            chosen = search.choose(&band, start, (lo, hi), &mode);
            if chosen.is_none() && laid.anchored {
                chosen = search.nearest_free(&band, start, (lo, hi), false);
            }
        }
        let offset = match chosen {
            Some(o) => o,
            None => {
                let start = if feasible { clamp(preferred) } else { lo.or(hi).unwrap_or(preferred) };
                ctx.diagnostics.push(diagnostic(
                    "FOCUS_ENGINE_LANE_BOUNDS_UNSATISFIED",
                    Severity::Warning,
                    tree,
                    members.iter().copied(),
                    format!("Lane {} does not fit inside its bounds; it is placed as close to them as the other focuses allow", lane.id),
                    json!({ "laneId": lane.id, "minimumX": lane.minimum_x, "maximumX": lane.maximum_x, "bandWidth": bhi - blo + 1 }),
                ));
                search.nearest_free(&band, start, (None, None), true).expect("a free offset always exists without bounds")
            }
        };
        for (i, &m) in members.iter().enumerate() {
            position[m] = Some((laid.x[i] + offset, band.y[i]));
        }
    }

    // Centre a tree that is all auto (and has no lane bounds) on x = 0.
    if n > 0 && placed.iter().all(|&p| p) && !any_bounds {
        let lo = position.iter().flatten().map(|p| p.0).min().unwrap_or(0);
        let hi = position.iter().flatten().map(|p| p.0).max().unwrap_or(0);
        let shift = -(lo + hi + 1).div_euclid(2);
        for p in position.iter_mut().flatten() {
            p.0 += shift;
        }
    }

    for &v in &attached_order {
        let Position::Relative { x, y, relative_to } = &tree.position[v] else { unreachable!() };
        let anchor = tree.lookup[relative_to];
        position[v] = position[anchor].map(|(ax, ay)| (ax + x, ay + y));
    }
    let moved: Vec<bool> = (0..n).map(|v| placed[v] || resolved.attached[v]).collect();

    // Source: the topmost placed focus of each lane is written fixed, the rest relative to it.
    let mut source = Vec::with_capacity(n);
    let mut lane_root: BTreeMap<usize, usize> = BTreeMap::new();
    for v in 0..n {
        if placed[v] {
            let lane = tree.lane[v];
            let better = match lane_root.get(&lane) {
                Some(&r) => position[v].unwrap().1 < position[r].unwrap().1,
                None => true,
            };
            if better {
                lane_root.insert(lane, v);
            }
        }
    }
    let all: Vec<(i64, i64)> = position.iter().map(|p| p.expect("every focus has coordinates")).collect();
    for v in 0..n {
        let (x, y) = all[v];
        let entry = if placed[v] {
            let root = lane_root[&tree.lane[v]];
            if root == v {
                SourceOut { id: tree.ids[v].clone(), relative_to: None, x, y }
            } else {
                let (rx, ry) = all[root];
                SourceOut { id: tree.ids[v].clone(), relative_to: Some(tree.ids[root].clone()), x: x - rx, y: y - ry }
            }
        } else {
            echo(tree, v)
        };
        source.push(entry);
    }
    Ok(finish(&mut ctx, &bundles, &all, &moved, source, Vec::new()))
}

fn echo(tree: &Tree, v: usize) -> SourceOut {
    match &tree.position[v] {
        Position::Fixed { x, y } => SourceOut { id: tree.ids[v].clone(), relative_to: None, x: *x, y: *y },
        Position::Relative { x, y, relative_to } => SourceOut { id: tree.ids[v].clone(), relative_to: Some(relative_to.clone()), x: *x, y: *y },
        Position::Auto { .. } => unreachable!("auto focuses are placed"),
    }
}

// ---------------------------------------------------------------------------------------------
// insert

fn insert(request: &Request, tree: &Tree, started: Instant) -> Result<Response, Invalid> {
    let n = tree.len();
    let spec = request.insert.as_ref().ok_or_else(|| Invalid::new("FOCUS_ENGINE_INSERT_INVALID", "operation insert needs an insert object"))?;
    if spec.focus_ids.is_empty() {
        return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", "insert.focusIds is empty"));
    }
    let mut placed = vec![false; n];
    for id in &spec.focus_ids {
        let Some(&v) = tree.lookup.get(id) else {
            return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", format!("insert.focusIds names {id}, which is not in focuses")));
        };
        if placed[v] {
            return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", format!("insert.focusIds lists {id} twice")));
        }
        if tree.pinned[v] {
            return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", format!("focus {id} is pinned and cannot be placed")));
        }
        placed[v] = true;
    }
    let anchor = match &spec.anchor_id {
        Some(id) => match tree.lookup.get(id) {
            Some(&v) if placed[v] => Some(v),
            _ => return Err(Invalid::new("FOCUS_ENGINE_INSERT_INVALID", format!("insert.anchorId {id} is not one of insert.focusIds"))),
        },
        None => None,
    };
    let resolved = tree::resolve(tree, &placed)?;
    for v in (0..n).filter(|&v| !placed[v]) {
        if resolved.attached[v] {
            return Err(Invalid::new(
                "FOCUS_ENGINE_INSERT_ANCHOR_INVALID",
                format!("focus {} is relative to a focus being inserted; list it in insert.focusIds or give it coordinates", tree.ids[v]),
            ));
        }
        if resolved.known[v].is_none() {
            return Err(Invalid::new(
                "FOCUS_ENGINE_INSERT_UNPLACED_FOCUS",
                format!("focus {} has no coordinates; insert keeps every focus outside insert.focusIds where it is", tree.ids[v]),
            ));
        }
    }
    let (rows, _) = tree::layer(tree, &placed, &resolved)?;
    let mut ctx = Context { request, tree, started, diagnostics: tree.warnings.clone() };
    let bundles = Bundles::new(&tree.children);
    let sp = tree.spacing;

    // A new focus must sit above its existing children; columns cannot fix rows.
    let bad_rows: Vec<(usize, usize)> =
        tree.edges.iter().copied().filter(|&(p, c)| (placed[p] || placed[c]) && rows[p].zip(rows[c]).is_some_and(|(py, cy)| py >= cy)).collect();
    if !bad_rows.is_empty() {
        let focuses: Vec<usize> = bad_rows.iter().flat_map(|&(p, c)| [p, c]).collect();
        let pairs: Vec<Value> = bad_rows.iter().map(|&(p, c)| json!({ "parentId": tree.ids[p], "childId": tree.ids[c] })).collect();
        ctx.diagnostics.push(diagnostic(
            "FOCUS_ENGINE_PARENT_NOT_ABOVE",
            Severity::Error,
            tree,
            focuses,
            "An inserted focus cannot be placed above its existing children; move the children down or insert them too",
            json!({ "pairs": pairs }),
        ));
        return Ok(blocked(&mut ctx, &resolved.known, &placed, None));
    }

    let members: Vec<usize> = (0..n).filter(|&v| placed[v]).collect();
    let mut position: Vec<Option<(i64, i64)>> = resolved.known.clone();
    let known_x: Vec<Option<i64>> = position.iter().map(|p| p.map(|(x, _)| x)).collect();
    let laid = band::layout(&BandInput { tree, members: &members, y: &rows, known_x: &known_x, spacing: sp });
    let band = Band { members: &members, x: &laid.x, y: members.iter().map(|&m| rows[m].expect("row")).collect() };
    let (blo, bhi) = band.extent();
    let occupancy = Occupancy::new(&position);
    let preferred = if laid.anchored {
        0
    } else {
        match (occupancy.extent(), spec.prefer_side) {
            (Some((lo, _)), crate::model::Side::Left) => lo - sp - tree.lane_spacing - bhi,
            (Some((_, hi)), _) => hi + sp + tree.lane_spacing - blo,
            (None, _) => -(blo + bhi + 1).div_euclid(2),
        }
    };
    let search = Search { tree, bundles: &bundles, occupancy: &occupancy, position: &position, spacing: sp };
    let mut shifted = Vec::new();
    let mut moved = placed.clone();
    let offset = match search.cheapest(&band, preferred, (None, None), spec.prefer_side, SEARCH_WINDOW) {
        Some(o) => o,
        None => {
            let anchors: Vec<usize> = members.iter().flat_map(|&m| tree.parents[m].iter().copied()).filter(|&p| !placed[p]).collect();
            let plan = propose_shift(&occupancy, &band, preferred, sp, spec.prefer_side, &anchors).expect("a conflict exists when no offset is free");
            let shift = Shift { from_x: plan.from_x, columns: plan.columns, direction: plan.direction, focus_ids: tree.names(plan.moved.iter().copied()) };
            if !spec.allow_shift {
                ctx.diagnostics.push(diagnostic(
                    "FOCUS_ENGINE_NO_CORRIDOR",
                    Severity::Error,
                    tree,
                    band.conflicting(&occupancy, preferred, sp),
                    format!(
                        "No free place within {SEARCH_WINDOW} columns; shifting {} focuses {} columns {} from column {} makes room (allowShift)",
                        plan.moved.len(),
                        plan.columns,
                        direction_name(plan.direction),
                        plan.from_x
                    ),
                    json!({ "window": SEARCH_WINDOW }),
                ));
                return Ok(blocked(&mut ctx, &resolved.known, &placed, Some(NeedsRoom { shift: vec![shift] })));
            }
            let delta = match plan.direction {
                Direction::Right => plan.columns,
                Direction::Left => -plan.columns,
            };
            for &v in &plan.moved {
                if let Some(p) = position[v].as_mut() {
                    p.0 += delta;
                }
                moved[v] = true;
            }
            ctx.diagnostics.push(diagnostic(
                "FOCUS_ENGINE_SHIFTED",
                Severity::Info,
                tree,
                plan.moved.iter().copied(),
                format!(
                    "Shifted {} focuses {} columns {} from column {} to make room",
                    plan.moved.len(),
                    plan.columns,
                    direction_name(plan.direction),
                    plan.from_x
                ),
                json!({}),
            ));
            shifted.push(shift);
            plan.band_offset
        }
    };
    for (i, &m) in members.iter().enumerate() {
        position[m] = Some((laid.x[i] + offset, band.y[i]));
    }
    let all: Vec<(i64, i64)> = position.iter().map(|p| p.expect("every focus has coordinates")).collect();

    // Source: the branch root relative to its first existing parent, the rest relative to the root.
    let root = anchor.unwrap_or_else(|| *members.iter().min_by(|&&a, &&b| all[a].1.cmp(&all[b].1).then(a.cmp(&b))).expect("members"));
    let root_parent = tree.declared_groups[root].iter().flatten().filter_map(|id| tree.lookup.get(id).copied()).find(|&p| !placed[p]);
    let mut source = Vec::with_capacity(n);
    for v in 0..n {
        let (x, y) = all[v];
        let entry = if v == root {
            match root_parent {
                Some(p) => SourceOut { id: tree.ids[v].clone(), relative_to: Some(tree.ids[p].clone()), x: x - all[p].0, y: y - all[p].1 },
                None => SourceOut { id: tree.ids[v].clone(), relative_to: None, x, y },
            }
        } else if placed[v] {
            SourceOut { id: tree.ids[v].clone(), relative_to: Some(tree.ids[root].clone()), x: x - all[root].0, y: y - all[root].1 }
        } else {
            match &tree.position[v] {
                Position::Relative { relative_to, .. } => {
                    let a = tree.lookup[relative_to];
                    if moved[v] || moved[a] {
                        SourceOut { id: tree.ids[v].clone(), relative_to: Some(relative_to.clone()), x: x - all[a].0, y: y - all[a].1 }
                    } else {
                        echo(tree, v)
                    }
                }
                Position::Fixed { .. } if moved[v] => SourceOut { id: tree.ids[v].clone(), relative_to: None, x, y },
                _ => echo(tree, v),
            }
        };
        source.push(entry);
    }
    Ok(finish(&mut ctx, &bundles, &all, &moved, source, shifted))
}

fn direction_name(d: Direction) -> &'static str {
    match d {
        Direction::Right => "right",
        Direction::Left => "left",
    }
}

// ---------------------------------------------------------------------------------------------
// response

fn relation_hashes(tree: &Tree) -> (String, String) {
    let prerequisites: Vec<Value> = (0..tree.len())
        .map(|v| {
            let mut groups: Vec<Vec<String>> = tree.declared_groups[v]
                .iter()
                .map(|g| {
                    let mut g = g.clone();
                    g.sort_by(|a, b| cmp_utf16(a, b));
                    g.dedup();
                    g
                })
                .collect();
            groups.sort_by(|a, b| {
                for (x, y) in a.iter().zip(b) {
                    let o = cmp_utf16(x, y);
                    if o.is_ne() {
                        return o;
                    }
                }
                a.len().cmp(&b.len())
            });
            groups.dedup();
            json!({ "id": tree.ids[v], "groups": groups })
        })
        .collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for v in 0..tree.len() {
        for other in &tree.declared_exclusive[v] {
            let a = &tree.ids[v];
            if a == other {
                continue;
            }
            let (x, y) = if cmp_utf16(a, other).is_lt() { (a.clone(), other.clone()) } else { (other.clone(), a.clone()) };
            pairs.push((x, y));
        }
    }
    pairs.sort_by(|a, b| cmp_utf16(&a.0, &b.0).then_with(|| cmp_utf16(&a.1, &b.1)));
    pairs.dedup();
    let exclusions: Vec<Value> = pairs.into_iter().map(|(a, b)| json!([a, b])).collect();
    (hash_value(&Value::Array(prerequisites)), hash_value(&Value::Array(exclusions)))
}

fn untouched_hash(tree: &Tree, position: &[Option<(i64, i64)>], touched: &[bool]) -> String {
    let list: Vec<Value> =
        (0..tree.len()).filter(|&v| !touched[v]).filter_map(|v| position[v].map(|(x, y)| json!({ "id": tree.ids[v], "x": x, "y": y }))).collect();
    hash_value(&Value::Array(list))
}

fn lane_id(tree: &Tree, v: usize) -> &str {
    &tree.lanes[tree.lane[v]].id
}

fn blocked(ctx: &mut Context, known: &[Option<(i64, i64)>], placed: &[bool], needs_room: Option<NeedsRoom>) -> Response {
    let tree = ctx.tree;
    let (prerequisites, exclusions) = relation_hashes(tree);
    Response {
        schema: RESPONSE_SCHEMA,
        status: Status::Blocked,
        operation: ctx.request.operation,
        tree_id: ctx.request.tree_id.clone(),
        nodes: Vec::new(),
        source: Vec::new(),
        diagnostics: std::mem::take(&mut ctx.diagnostics),
        metrics: None,
        hashes: Hashes { layout: None, untouched: untouched_hash(tree, known, placed), prerequisites, exclusions },
        needs_room,
        shifted: Vec::new(),
    }
}

/// Checks the invariants, measures the result and assembles the response.
fn finish(ctx: &mut Context, bundles: &Bundles, all: &[(i64, i64)], moved: &[bool], source: Vec<SourceOut>, shifted: Vec<Shift>) -> Response {
    let tree = ctx.tree;
    let n = tree.len();
    let sp = tree.spacing;
    let mut by_row: BTreeMap<i64, Vec<(i64, usize)>> = BTreeMap::new();
    for (v, &(x, y)) in all.iter().enumerate() {
        by_row.entry(y).or_default().push((x, v));
    }
    let mut spacing_pairs: Vec<(usize, usize, i64)> = Vec::new();
    for (&y, row) in by_row.iter_mut() {
        row.sort_unstable();
        for w in row.windows(2) {
            if w[1].0 - w[0].0 < sp {
                spacing_pairs.push((w[0].1, w[1].1, y));
            }
        }
    }
    let row_pairs: Vec<(usize, usize)> = tree.edges.iter().copied().filter(|&(p, c)| all[p].1 >= all[c].1).collect();
    let mut blocking = false;
    for touched in [true, false] {
        let spacing: Vec<&(usize, usize, i64)> = spacing_pairs.iter().filter(|(a, b, _)| (moved[*a] || moved[*b]) == touched).collect();
        let rows: Vec<&(usize, usize)> = row_pairs.iter().filter(|(p, c)| (moved[*p] || moved[*c]) == touched).collect();
        if spacing.is_empty() && rows.is_empty() {
            continue;
        }
        let pair_details: Vec<Value> = spacing.iter().take(50).map(|&&(a, b, y)| json!({ "leftId": tree.ids[a], "rightId": tree.ids[b], "y": y })).collect();
        let row_details: Vec<Value> = rows.iter().take(50).map(|&&(p, c)| json!({ "parentId": tree.ids[p], "childId": tree.ids[c] })).collect();
        let focuses: Vec<usize> = spacing.iter().flat_map(|&&(a, b, _)| [a, b]).chain(rows.iter().flat_map(|&&(p, c)| [p, c])).collect();
        if touched {
            blocking = true;
            if !spacing.is_empty() {
                ctx.diagnostics.push(diagnostic(
                    "FOCUS_ENGINE_SPACING_CONFLICT",
                    Severity::Error,
                    tree,
                    spacing.iter().flat_map(|&&(a, b, _)| [a, b]),
                    format!("Placed focuses would be closer than {sp} columns to another focus of their row"),
                    json!({ "pairs": pair_details }),
                ));
            }
            if !rows.is_empty() {
                ctx.diagnostics.push(diagnostic(
                    "FOCUS_ENGINE_PARENT_NOT_ABOVE",
                    Severity::Error,
                    tree,
                    rows.iter().flat_map(|&&(p, c)| [p, c]),
                    "A placed focus would not be below every prerequisite",
                    json!({ "pairs": row_details }),
                ));
            }
        } else {
            ctx.diagnostics.push(diagnostic(
                "FOCUS_ENGINE_EXISTING_CONFLICT",
                Severity::Warning,
                tree,
                focuses,
                "Focuses this call did not move already overlap or sit above a prerequisite; they are left as they are",
                json!({ "spacing": pair_details, "parentNotAbove": row_details }),
            ));
        }
    }
    let position: Vec<Option<(i64, i64)>> = all.iter().map(|&p| Some(p)).collect();
    if blocking {
        let placed: Vec<bool> = moved.to_vec();
        return blocked(ctx, &position, &placed, None);
    }

    let connectors = geometry::connectors(&tree.edges, &position);
    let m = geometry::measure(&position, &connectors, bundles, None);
    let (columns, rows) = if n == 0 {
        (0, 0)
    } else {
        let (xlo, xhi) = (all.iter().map(|p| p.0).min().unwrap(), all.iter().map(|p| p.0).max().unwrap());
        let (ylo, yhi) = (all.iter().map(|p| p.1).min().unwrap(), all.iter().map(|p| p.1).max().unwrap());
        (xhi - xlo + 1, yhi - ylo + 1)
    };
    let nodes: Vec<NodeOut> =
        (0..n).map(|v| NodeOut { id: tree.ids[v].clone(), x: all[v].0, y: all[v].1, lane_id: lane_id(tree, v).to_string(), moved: moved[v] }).collect();
    let layout_list: Vec<Value> = nodes.iter().map(|o| json!({ "id": o.id, "laneId": o.lane_id, "x": o.x, "y": o.y })).collect();
    let (prerequisites, exclusions) = relation_hashes(tree);
    let duration_micros = ctx.started.elapsed().as_micros() as u64;
    Response {
        schema: RESPONSE_SCHEMA,
        status: Status::Ok,
        operation: ctx.request.operation,
        tree_id: ctx.request.tree_id.clone(),
        nodes,
        source,
        diagnostics: std::mem::take(&mut ctx.diagnostics),
        metrics: Some(Metrics {
            columns,
            rows,
            orthogonal_crossings: m.crossings,
            stems_through_plaques: m.stems_through_plaques,
            merged_bars: m.merged_bars,
            duration_micros,
        }),
        hashes: Hashes { layout: Some(hash_value(&Value::Array(layout_list))), untouched: untouched_hash(tree, &position, moved), prerequisites, exclusions },
        needs_room: None,
        shifted,
    }
}
