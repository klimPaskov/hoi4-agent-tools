//! Placing a laid-out band among focuses that already have coordinates: conflict checks, the
//! horizontal offset search with its connector cost, and the smallest corridor shift.

use std::collections::BTreeMap;

use crate::geometry::{self, Bundles, Connector};
use crate::model::{Direction, Side};
use crate::tree::Tree;

/// Focuses with coordinates, by row, sorted by column.
pub struct Occupancy {
    rows: BTreeMap<i64, Vec<(i64, usize)>>,
}

impl Occupancy {
    pub fn new(position: &[Option<(i64, i64)>]) -> Occupancy {
        let mut rows: BTreeMap<i64, Vec<(i64, usize)>> = BTreeMap::new();
        for (v, p) in position.iter().enumerate() {
            if let Some((x, y)) = p {
                rows.entry(*y).or_default().push((*x, v));
            }
        }
        for row in rows.values_mut() {
            row.sort_unstable();
        }
        Occupancy { rows }
    }

    /// Focuses of row `y` closer than `sp` columns to `x`.
    pub fn near(&self, x: i64, y: i64, sp: i64) -> &[(i64, usize)] {
        let Some(row) = self.rows.get(&y) else { return &[] };
        let start = row.partition_point(|&(ox, _)| ox <= x - sp);
        let end = row.partition_point(|&(ox, _)| ox < x + sp);
        &row[start..end]
    }

    pub fn extent(&self) -> Option<(i64, i64)> {
        let mut out: Option<(i64, i64)> = None;
        for row in self.rows.values() {
            if let (Some(first), Some(last)) = (row.first(), row.last()) {
                out = Some(match out {
                    Some((lo, hi)) => (lo.min(first.0), hi.max(last.0)),
                    None => (first.0, last.0),
                });
            }
        }
        out
    }

    pub fn all(&self) -> impl Iterator<Item = (i64, i64, usize)> + '_ {
        self.rows.iter().flat_map(|(&y, row)| row.iter().map(move |&(x, v)| (x, y, v)))
    }
}

/// A band laid out at offset 0.
pub struct Band<'a> {
    pub members: &'a [usize],
    pub x: &'a [i64],
    pub y: Vec<i64>,
}

impl Band<'_> {
    pub fn extent(&self) -> (i64, i64) {
        let lo = self.x.iter().copied().min().unwrap_or(0);
        let hi = self.x.iter().copied().max().unwrap_or(0);
        (lo, hi)
    }

    pub fn conflicts(&self, occupancy: &Occupancy, offset: i64, sp: i64) -> bool {
        self.x.iter().zip(&self.y).any(|(&x, &y)| !occupancy.near(x + offset, y, sp).is_empty())
    }

    pub fn conflicting(&self, occupancy: &Occupancy, offset: i64, sp: i64) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        for (&x, &y) in self.x.iter().zip(&self.y) {
            out.extend(occupancy.near(x + offset, y, sp).iter().map(|&(_, v)| v));
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Cost {
    crossings: usize,
    stems: usize,
    side_penalty: u8,
    horizontal_length: i64,
    distance: i64,
    side_tie: u8,
}

pub enum Mode {
    /// First conflict-free offset by distance, right before left.
    Pack,
    /// Least connector cost within `window` columns of the preferred offset.
    Cost { side: Side, window: i64 },
}

pub struct Search<'a> {
    pub tree: &'a Tree,
    pub bundles: &'a Bundles,
    pub occupancy: &'a Occupancy,
    /// Coordinates of every focus outside the band that has them.
    pub position: &'a [Option<(i64, i64)>],
    pub spacing: i64,
}

impl Search<'_> {
    /// Distance from `preferred` beyond which the band clears every occupied column.
    fn reach(&self, band: &Band, preferred: i64) -> i64 {
        let Some((lo, hi)) = self.occupancy.extent() else { return 0 };
        let (blo, bhi) = band.extent();
        let right = hi + self.spacing - blo;
        let left = lo - self.spacing - bhi;
        (right - preferred).abs().max((left - preferred).abs()) + 1
    }

    fn in_bounds(offset: i64, bounds: (Option<i64>, Option<i64>)) -> bool {
        bounds.0.is_none_or(|lo| offset >= lo) && bounds.1.is_none_or(|hi| offset <= hi)
    }

    /// The first conflict-free offset in order of distance from `preferred` (ties: `right_first`).
    pub fn nearest_free(&self, band: &Band, preferred: i64, bounds: (Option<i64>, Option<i64>), right_first: bool) -> Option<i64> {
        let reach = self.reach(band, preferred);
        for d in 0..=reach {
            let pair = if right_first { [d, -d] } else { [-d, d] };
            for step in pair {
                let offset = preferred + step;
                if Self::in_bounds(offset, bounds) && !band.conflicts(self.occupancy, offset, self.spacing) {
                    return Some(offset);
                }
                if d == 0 {
                    break;
                }
            }
        }
        None
    }

    pub fn choose(&self, band: &Band, preferred: i64, bounds: (Option<i64>, Option<i64>), mode: &Mode) -> Option<i64> {
        match mode {
            Mode::Pack => self.nearest_free(band, preferred, bounds, true),
            Mode::Cost { side, window } => self.cheapest(band, preferred, bounds, *side, *window),
        }
    }

    /// The conflict-free offset within `window` with the least cost, or None.
    pub fn cheapest(&self, band: &Band, preferred: i64, bounds: (Option<i64>, Option<i64>), side: Side, window: i64) -> Option<i64> {
        let n = self.tree.len();
        let mut is_member = vec![false; n];
        for &m in band.members {
            is_member[m] = true;
        }
        let old: Vec<Connector> =
            geometry::connectors(&self.tree.edges, self.position).into_iter().filter(|c| !is_member[c.parent] && !is_member[c.child]).collect();
        let incident: Vec<(usize, usize)> = self.tree.edges.iter().copied().filter(|&(p, c)| is_member[p] || is_member[c]).collect();
        let mut position = self.position.to_vec();
        let mut best: Option<(Cost, i64)> = None;
        for d in -window..=window {
            let offset = preferred + d;
            if !Self::in_bounds(offset, bounds) || band.conflicts(self.occupancy, offset, self.spacing) {
                continue;
            }
            for (i, &m) in band.members.iter().enumerate() {
                position[m] = Some((band.x[i] + offset, band.y[i]));
            }
            let new_connectors = geometry::connectors(&incident, &position);
            let horizontal_length = new_connectors.iter().map(Connector::horizontal_length).sum();
            let mut all = old.clone();
            all.extend(new_connectors);
            let m = geometry::measure(&position, &all, self.bundles, Some(&is_member));
            let (side_penalty, side_tie) = match side {
                Side::Left => (u8::from(d > 0), u8::from(d > 0)),
                Side::Right => (u8::from(d < 0), u8::from(d < 0)),
                Side::Either => (0, u8::from(d > 0)),
            };
            let cost = Cost { crossings: m.crossings, stems: m.stems_through_plaques, side_penalty, horizontal_length, distance: d.abs(), side_tie };
            if best.is_none_or(|(b, _)| cost < b) {
                best = Some((cost, offset));
            }
        }
        best.map(|(_, offset)| offset)
    }
}

/// The smallest shift of existing focuses that opens a corridor for `band` at `offset`.
pub struct ShiftPlan {
    pub from_x: i64,
    pub columns: i64,
    pub direction: Direction,
    pub moved: Vec<usize>,
}

pub fn propose_shift(occupancy: &Occupancy, band: &Band, offset: i64, sp: i64, side: Side) -> Option<ShiftPlan> {
    let cells: Vec<(i64, i64)> = band.x.iter().zip(&band.y).map(|(&x, &y)| (x + offset, y)).collect();
    let conflicting = band.conflicting(occupancy, offset, sp);
    if conflicting.is_empty() {
        return None;
    }
    let (blo, bhi) = band.extent();
    let (blo, bhi) = (blo + offset, bhi + offset);
    let mut right_most: BTreeMap<i64, i64> = BTreeMap::new();
    let mut left_most: BTreeMap<i64, i64> = BTreeMap::new();
    for &(x, y) in &cells {
        right_most.entry(y).and_modify(|v| *v = (*v).max(x)).or_insert(x);
        left_most.entry(y).and_modify(|v| *v = (*v).min(x)).or_insert(x);
    }
    let existing: Vec<(i64, i64, usize)> = occupancy.all().collect();
    let conflict_x: Vec<i64> = existing.iter().filter(|e| conflicting.binary_search(&e.2).is_ok()).map(|e| e.0).collect();
    let min_conflict = *conflict_x.iter().min().expect("conflicts");
    let max_conflict = *conflict_x.iter().max().expect("conflicts");
    // (columns, moved count, direction rank, cut) -> plan
    let mut best: Option<((i64, usize, u8, i64), ShiftPlan)> = None;
    let rank = |d: Direction| -> u8 {
        match (side, d) {
            (Side::Left, Direction::Left) | (Side::Right | Side::Either, Direction::Right) => 0,
            _ => 1,
        }
    };
    for c in (blo - sp + 1)..=(bhi + sp).min(min_conflict) {
        let mut columns = 0;
        let mut moved = Vec::new();
        for &(x, y, v) in &existing {
            if x >= c {
                moved.push(v);
                if let Some(&r) = right_most.get(&y) {
                    columns = columns.max(r + sp - x);
                }
            }
        }
        let key = (columns, moved.len(), rank(Direction::Right), -c);
        if columns > 0 && best.as_ref().is_none_or(|(b, _)| key < *b) {
            moved.sort_unstable();
            best = Some((key, ShiftPlan { from_x: c, columns, direction: Direction::Right, moved }));
        }
    }
    for c in (blo - sp).max(max_conflict)..=(bhi + sp - 1) {
        let mut columns = 0;
        let mut moved = Vec::new();
        for &(x, y, v) in &existing {
            if x <= c {
                moved.push(v);
                if let Some(&l) = left_most.get(&y) {
                    columns = columns.max(x - (l - sp));
                }
            }
        }
        let key = (columns, moved.len(), rank(Direction::Left), c);
        if columns > 0 && best.as_ref().is_none_or(|(b, _)| key < *b) {
            moved.sort_unstable();
            best = Some((key, ShiftPlan { from_x: c, columns, direction: Direction::Left, moved }));
        }
    }
    best.map(|(_, plan)| plan)
}
