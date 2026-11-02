//! The in-game orthogonal connector model ("O1"), ported from
//! `src/hoi4_agent_tools/focus/quality/orthogonal.ts` of hoi4-agent-tools (branch
//! `claude/focus-layout-quality`, commit 2fa0f3a; bar placement updated from branch
//! `claude/connector-bar-placement`, commit e43a44a).
//!
//! A connector leaves the bottom centre of the parent plaque in a short stem, runs along a
//! horizontal bar just under the parent's row, and drops in the child's column into the top of the
//! child's icon. A plaque is centred on its focus, 1.61 columns wide and 0.28 rows high, and its
//! icon reaches 0.66 rows above the focus's row. This placement was confirmed by the in-game run of
//! 2026-11-02 on game 1.19.4.1 at the default UI scale and zoom; other scales are unverified.
//! Defects:
//!
//! - crossing: the child's vertical passes through the bar of another connector whose parent is on
//!   a row strictly between its own parent and child, strictly inside that bar;
//! - stem through a plaque: the child's vertical passes closer than 0.805 columns to the centre of
//!   another focus on such a row;
//! - merged bar: two bars under one row share at least half a column, or two vertical segments of
//!   one column share more than 0.3 rows.
//!
//! Connectors with the same parent or the same child, or inside one all-to-all bundle (at least two
//! parents that are each a prerequisite of the same two or more children), are drawn as one bar
//! and never counted against each other.
//!
//! Coordinates are integers, so every comparison is done exactly in integers: columns for `x`,
//! hundredths of a column for the plaque width and hundredths of a row for vertical extents
//! (0.14, 0.28 and 0.66 rows are exact there). No floating point reaches a decision.

use std::collections::{BTreeMap, BTreeSet};

/// Hundredths per grid row or column: the unit of every vertical extent and of the plaque width.
pub const UNIT: i64 = 100;
/// Plaque width in hundredths of a column (1.61 columns).
pub const PLAQUE_WIDTH_HUNDREDTHS: i64 = 161;
/// Plaque height in hundredths of a row (0.28 rows); the parent stem leaves at half of it.
pub const PLAQUE_HEIGHT_HUNDREDTHS: i64 = 28;
/// Bar distance below the parent's row in hundredths of a row (0.28 rows).
pub const BAR_OFFSET_HUNDREDTHS: i64 = 28;
/// Height of the top of a focus's icon above its row in hundredths of a row (0.66 rows: icon and
/// plaque span 0.8 rows and the plaque's bottom is 0.14 rows below the row).
pub const ICON_TOP_HUNDREDTHS: i64 = 66;
/// Two bars merge when they share at least this many hundredths of a column (0.5 columns).
pub const MINIMUM_SHARED_BAR_HUNDREDTHS: i64 = 50;
/// Two vertical segments merge when they share more than this many hundredths of a row (0.3 rows).
pub const MINIMUM_SHARED_STEM_HUNDREDTHS: i64 = 30;
/// Only the first this many parents with two or more children are bundle candidates, as in the
/// TypeScript model.
pub const BUNDLE_CANDIDATE_PARENT_MAX: usize = 800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connector {
    pub parent: usize,
    pub child: usize,
    pub parent_x: i64,
    pub parent_y: i64,
    pub child_x: i64,
    pub child_y: i64,
}

impl Connector {
    pub fn bar_from(&self) -> i64 {
        self.parent_x.min(self.child_x)
    }

    pub fn bar_to(&self) -> i64 {
        self.parent_x.max(self.child_x)
    }

    /// Top of the parent stem (the bottom of the parent's plaque) in hundredths of a row.
    pub fn stem_from(&self) -> i64 {
        UNIT * self.parent_y + PLAQUE_HEIGHT_HUNDREDTHS / 2
    }

    /// Bar height in hundredths of a row: just under the parent's row.
    pub fn bar_y(&self) -> i64 {
        UNIT * self.parent_y + BAR_OFFSET_HUNDREDTHS
    }

    /// Bottom of the child's vertical (the top of the child's icon) in hundredths of a row.
    pub fn drop_to(&self) -> i64 {
        UNIT * self.child_y - ICON_TOP_HUNDREDTHS
    }

    /// The drawn polyline in grid units: parent plaque bottom, bar start, bar end, child icon top.
    pub fn polyline(&self) -> [(f64, f64); 4] {
        let unit = UNIT as f64;
        let bar = self.bar_y() as f64 / unit;
        let top = self.stem_from() as f64 / unit;
        let bottom = self.drop_to() as f64 / unit;
        [(self.parent_x as f64, top), (self.parent_x as f64, bar), (self.child_x as f64, bar), (self.child_x as f64, bottom)]
    }

    pub fn horizontal_length(&self) -> i64 {
        (self.parent_x - self.child_x).abs()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub parents: Vec<usize>,
    pub children: Vec<usize>,
}

fn intersection(left: &[usize], right: &[usize]) -> Vec<usize> {
    left.iter().copied().filter(|v| right.binary_search(v).is_ok()).collect()
}

/// Sets of at least two parents and two children with every parent a prerequisite of every child.
/// `children` lists are sorted; indices are in id order.
pub fn detect_bundles(children: &[Vec<usize>]) -> Vec<Bundle> {
    let candidates: Vec<usize> = (0..children.len()).filter(|&v| children[v].len() >= 2).take(BUNDLE_CANDIDATE_PARENT_MAX).collect();
    let mut found: BTreeSet<(Vec<usize>, Vec<usize>)> = BTreeSet::new();
    for (index, &first) in candidates.iter().enumerate() {
        for &second in &candidates[index + 1..] {
            let common = intersection(&children[first], &children[second]);
            if common.len() < 2 {
                continue;
            }
            let parents: Vec<usize> = candidates.iter().copied().filter(|&c| common.iter().all(|x| children[c].binary_search(x).is_ok())).collect();
            let mut shared = common;
            for &p in &parents {
                shared = intersection(&shared, &children[p]);
            }
            if parents.len() < 2 || shared.len() < 2 {
                continue;
            }
            found.insert((parents, shared));
        }
    }
    found.into_iter().map(|(parents, children)| Bundle { parents, children }).collect()
}

/// Bundles of a tree and the lookups the measurement needs.
pub struct Bundles {
    pub list: Vec<Bundle>,
    /// Bundle ids of each (parent, child) link.
    edge: BTreeMap<(usize, usize), Vec<usize>>,
    /// Bundle ids each focus belongs to (as parent or child).
    member: Vec<Vec<usize>>,
}

impl Bundles {
    pub fn new(children: &[Vec<usize>]) -> Bundles {
        let list = detect_bundles(children);
        let mut edge: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
        let mut member = vec![Vec::new(); children.len()];
        for (b, bundle) in list.iter().enumerate() {
            for &p in &bundle.parents {
                member[p].push(b);
                for &c in &bundle.children {
                    edge.entry((p, c)).or_default().push(b);
                }
            }
            for &c in &bundle.children {
                member[c].push(b);
            }
        }
        for m in &mut member {
            m.sort_unstable();
            m.dedup();
        }
        Bundles { list, edge, member }
    }

    fn of_edge(&self, c: &Connector) -> &[usize] {
        self.edge.get(&(c.parent, c.child)).map_or(&[], Vec::as_slice)
    }
}

fn share(a: &[usize], b: &[usize]) -> bool {
    a.iter().any(|x| b.binary_search(x).is_ok())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Measurement {
    pub crossings: usize,
    pub stems_through_plaques: usize,
    pub merged_bars: usize,
}

/// The connectors of every link whose two ends have coordinates.
pub fn connectors(edges: &[(usize, usize)], position: &[Option<(i64, i64)>]) -> Vec<Connector> {
    edges
        .iter()
        .filter_map(|&(p, c)| {
            let (px, py) = position[p]?;
            let (cx, cy) = position[c]?;
            Some(Connector { parent: p, child: c, parent_x: px, parent_y: py, child_x: cx, child_y: cy })
        })
        .collect()
}

/// Counts the defects of the orthogonal model. With `new`, only defects that involve at least one
/// new focus (a connector with a new end, or a new plaque) are counted.
pub fn measure(position: &[Option<(i64, i64)>], connectors: &[Connector], bundles: &Bundles, new: Option<&[bool]>) -> Measurement {
    let is_new_node = |v: usize| new.is_none_or(|n| n[v]);
    let edge_new: Vec<bool> = connectors.iter().map(|c| is_new_node(c.parent) || is_new_node(c.child)).collect();
    let edge_bundles: Vec<&[usize]> = connectors.iter().map(|c| bundles.of_edge(c)).collect();
    let exempt = |i: usize, j: usize| -> bool {
        let (a, b) = (&connectors[i], &connectors[j]);
        a.parent == b.parent || a.child == b.child || share(edge_bundles[i], edge_bundles[j])
    };
    let counted = |i: usize, j: usize| edge_new[i] || edge_new[j];

    // Every bar runs just under its parent's row.
    let mut bars_by_row: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
    for (i, c) in connectors.iter().enumerate() {
        bars_by_row.entry(c.parent_y).or_default().push(i);
    }
    let mut nodes_by_row: BTreeMap<i64, Vec<(i64, usize)>> = BTreeMap::new();
    for (v, p) in position.iter().enumerate() {
        if let Some((x, y)) = p {
            nodes_by_row.entry(*y).or_default().push((*x, v));
        }
    }
    for row in nodes_by_row.values_mut() {
        row.sort_unstable();
    }

    let mut m = Measurement::default();
    for (i, c) in connectors.iter().enumerate() {
        if c.child_y - c.parent_y < 2 {
            continue;
        }
        // The child's vertical runs from the bar under the parent's row to the child's icon, past
        // every row strictly between the two and the bars under those rows.
        let rows = (c.parent_y + 1)..c.child_y;
        for (_, bars) in bars_by_row.range(rows.clone()) {
            for &j in bars {
                if j == i || !counted(i, j) {
                    continue;
                }
                let o = &connectors[j];
                if o.bar_from() < c.child_x && c.child_x < o.bar_to() && !exempt(i, j) {
                    m.crossings += 1;
                }
            }
        }
        for (_, nodes) in nodes_by_row.range(rows) {
            // |x - child_x| * 100 * 2 < plaque width in hundredths: with integers, x == child_x.
            let reach = (PLAQUE_WIDTH_HUNDREDTHS - 1) / (2 * UNIT);
            let start = nodes.partition_point(|&(x, _)| x < c.child_x - reach);
            for &(x, v) in &nodes[start..] {
                if x > c.child_x + reach {
                    break;
                }
                if (x - c.child_x).abs() * UNIT * 2 >= PLAQUE_WIDTH_HUNDREDTHS || v == c.parent || v == c.child {
                    continue;
                }
                if !(edge_new[i] || is_new_node(v)) {
                    continue;
                }
                if !share(edge_bundles[i], &bundles.member[v]) {
                    m.stems_through_plaques += 1;
                }
            }
        }
    }

    let mut merged: BTreeSet<(usize, usize)> = BTreeSet::new();
    let add = |i: usize, j: usize, merged: &mut BTreeSet<(usize, usize)>| {
        if i != j && counted(i, j) && !exempt(i, j) {
            merged.insert((i.min(j), i.max(j)));
        }
    };
    for bars in bars_by_row.values() {
        let mut spans: Vec<(i64, i64, usize)> = bars.iter().map(|&i| (connectors[i].bar_from(), connectors[i].bar_to(), i)).collect();
        spans.sort_unstable();
        for (k, &(_, to, i)) in spans.iter().enumerate() {
            for &(from_b, to_b, j) in &spans[k + 1..] {
                // Shared length (to.min(to_b) - from_b) columns must reach 0.5 columns.
                if (to - from_b) * UNIT < MINIMUM_SHARED_BAR_HUNDREDTHS {
                    break;
                }
                if (to.min(to_b) - from_b) * UNIT >= MINIMUM_SHARED_BAR_HUNDREDTHS {
                    add(i, j, &mut merged);
                }
            }
        }
    }
    let mut verticals: BTreeMap<i64, Vec<(i64, i64, usize)>> = BTreeMap::new();
    for (i, c) in connectors.iter().enumerate() {
        let (top, bar, bottom) = (c.stem_from(), c.bar_y(), c.drop_to());
        if bar > top {
            verticals.entry(c.parent_x).or_default().push((top, bar, i));
        }
        if bottom > bar {
            verticals.entry(c.child_x).or_default().push((bar, bottom, i));
        }
    }
    for group in verticals.values_mut() {
        group.sort_unstable();
        for k in 0..group.len() {
            let (_, to, i) = group[k];
            for &(from_b, to_b, j) in &group[k + 1..] {
                // Shared hundredths of a row merge when they exceed 0.3 rows.
                if to - from_b <= MINIMUM_SHARED_STEM_HUNDREDTHS {
                    break;
                }
                if to.min(to_b) - from_b > MINIMUM_SHARED_STEM_HUNDREDTHS {
                    add(i, j, &mut merged);
                }
            }
        }
    }
    m.merged_bars = merged.len();
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(points: &[(i64, i64)]) -> Vec<Option<(i64, i64)>> {
        points.iter().map(|&p| Some(p)).collect()
    }

    #[test]
    fn a_long_vertical_through_a_bar_is_one_crossing() {
        // 0 -> 3 drops down column 4 from under row 0 to row 2; 1 -> 2 has its bar under row 1
        // from x 2 to x 6, crossed at x 4.
        let position = pos(&[(0, 0), (2, 1), (6, 2), (4, 2)]);
        let edges = [(0, 3), (1, 2)];
        let children = vec![vec![3], vec![2], vec![], vec![]];
        let c = connectors(&edges, &position);
        let m = measure(&position, &c, &Bundles::new(&children), None);
        assert_eq!(m.crossings, 1);
        assert_eq!(m.stems_through_plaques, 0);
    }

    #[test]
    fn parents_on_one_row_share_the_bar_height() {
        // The earlier model read this as a crossing; both bars now run under row 0 and overlap.
        let position = pos(&[(0, 0), (-2, 0), (2, 1), (4, 2)]);
        let edges = [(0, 3), (1, 2)];
        let children = vec![vec![3], vec![2], vec![], vec![]];
        let m = measure(&position, &connectors(&edges, &position), &Bundles::new(&children), None);
        assert_eq!(m, Measurement { crossings: 0, stems_through_plaques: 0, merged_bars: 1 });
    }

    #[test]
    fn a_long_vertical_through_a_plaque_is_counted() {
        let position = pos(&[(0, 0), (0, 1), (0, 2)]);
        let edges = [(0, 2)];
        let children = vec![vec![2], vec![], vec![]];
        let m = measure(&position, &connectors(&edges, &position), &Bundles::new(&children), None);
        assert_eq!(m.stems_through_plaques, 1);
    }

    #[test]
    fn all_to_all_links_form_one_bundle_and_never_cross() {
        // Parents 0 and 1, children 2 and 3, every parent linked to every child.
        let children = vec![vec![2, 3], vec![2, 3], vec![], vec![]];
        let bundles = Bundles::new(&children);
        assert_eq!(bundles.list, vec![Bundle { parents: vec![0, 1], children: vec![2, 3] }]);
        let position = pos(&[(-1, 0), (1, 0), (-1, 1), (1, 1)]);
        let edges = [(0, 2), (1, 2), (0, 3), (1, 3)];
        let m = measure(&position, &connectors(&edges, &position), &bundles, None);
        assert_eq!(m, Measurement::default());
    }

    #[test]
    fn overlapping_bars_of_one_row_merge() {
        // 0 -> 2 bar from -2 to 1, 1 -> 3 bar from 0 to 3: share one column.
        let position = pos(&[(-2, 0), (3, 0), (1, 1), (0, 1)]);
        let edges = [(0, 2), (1, 3)];
        let children = vec![vec![2], vec![3], vec![], vec![]];
        let m = measure(&position, &connectors(&edges, &position), &Bundles::new(&children), None);
        assert_eq!(m.merged_bars, 1);
        let only_new = measure(&position, &connectors(&edges, &position), &Bundles::new(&children), Some(&[false, false, false, false]));
        assert_eq!(only_new, Measurement::default());
    }

    #[test]
    fn polyline_follows_the_model() {
        let c = Connector { parent: 0, child: 1, parent_x: 0, parent_y: 0, child_x: 2, child_y: 1 };
        assert_eq!(c.polyline(), [(0.0, 0.14), (0.0, 0.28), (2.0, 0.28), (2.0, 0.34)]);
    }
}
