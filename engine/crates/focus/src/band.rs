//! Layered placement of one band (the auto focuses of one lane, or an inserted branch).
//!
//! Rows are fixed before this runs. Each pass visits the rows in order:
//!
//! - down: a focus wants the median of its parents' columns (the midpoint of the two middle values
//!   for an even count); focuses with the same parents and the same median form a cohort spread
//!   symmetrically around it, `spacing` apart. Rows are ordered by that median (the barycenter
//!   heuristic), then by cohort and id. Focuses without placed parents keep their column from an
//!   earlier pass, or use `preferredX`, or follow the others.
//! - up: a focus with children in the band wants the median of its children's columns, so parents
//!   are centred over the subtrees and convergence focuses pull their parents together.
//!
//! After each row the wanted columns are projected onto the nearest order-preserving positions with
//! the required gaps (least squares, pool-adjacent-violators), rounded half toward +infinity.
//! Mutually exclusive focuses of one row are kept next to each other exactly `spacing` apart.
//! The passes are down, up, down, up. All arithmetic is in integers (half columns and exact
//! rationals), so the result is the same on every platform.

use crate::tree::Tree;

pub struct BandInput<'a> {
    pub tree: &'a Tree,
    /// Sorted global indices of the focuses to place.
    pub members: &'a [usize],
    pub y: &'a [Option<i64>],
    /// Columns already known for focuses outside the band.
    pub known_x: &'a [Option<i64>],
    pub spacing: i64,
}

pub struct BandLayout {
    /// Column of each member, in `members` order.
    pub x: Vec<i64>,
    /// True when a member has a placed parent outside the band or a `preferredX`, so its columns
    /// are absolute rather than relative to the band.
    pub anchored: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    Down,
    Up,
}

const PASSES: [Pass; 4] = [Pass::Down, Pass::Up, Pass::Down, Pass::Up];

/// Median in half columns: twice the middle value, or the sum of the two middle values.
fn median_half(values: &mut [i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let n = values.len();
    Some(if n % 2 == 1 { 2 * values[n / 2] } else { values[n / 2 - 1] + values[n / 2] })
}

struct Local {
    y: i64,
    band_parents: Vec<usize>,
    external_parent_x: Vec<i64>,
    band_children: Vec<usize>,
    exclusive: Vec<usize>,
    preferred_x: Option<i64>,
    /// Global ids of the parents, for cohort grouping.
    cohort: Vec<usize>,
}

pub fn layout(input: &BandInput) -> BandLayout {
    let tree = input.tree;
    let members = input.members;
    let sp = input.spacing;
    let mut local_of = std::collections::HashMap::with_capacity(members.len());
    for (l, &g) in members.iter().enumerate() {
        local_of.insert(g, l);
    }
    let mut anchored = false;
    let mut locals: Vec<Local> = Vec::with_capacity(members.len());
    for &g in members {
        let mut band_parents = Vec::new();
        let mut external_parent_x = Vec::new();
        let mut cohort = Vec::new();
        for &p in &tree.parents[g] {
            if let Some(&l) = local_of.get(&p) {
                band_parents.push(l);
                cohort.push(p);
            } else if let Some(x) = input.known_x[p] {
                external_parent_x.push(x);
                cohort.push(p);
            }
        }
        let band_children = tree.children[g].iter().filter_map(|c| local_of.get(c).copied()).collect();
        let preferred_x = tree.position[g].preferred_x();
        anchored |= !external_parent_x.is_empty() || preferred_x.is_some();
        let y = input.y[g].expect("band member has a row");
        let exclusive = tree.exclusive[g].iter().filter_map(|o| local_of.get(o).copied()).collect();
        locals.push(Local { y, band_parents, external_parent_x, band_children, exclusive, preferred_x, cohort });
    }
    // Exclusive partners only count inside one row.
    for l in 0..locals.len() {
        let y = locals[l].y;
        let kept: Vec<usize> = locals[l].exclusive.iter().copied().filter(|&o| locals[o].y == y).collect();
        locals[l].exclusive = kept;
    }

    let mut rows: Vec<(i64, Vec<usize>)> = Vec::new();
    {
        let mut by_row: Vec<usize> = (0..locals.len()).collect();
        by_row.sort_by_key(|&l| (locals[l].y, l));
        for l in by_row {
            match rows.last_mut() {
                Some((y, list)) if *y == locals[l].y => list.push(l),
                _ => rows.push((locals[l].y, vec![l])),
            }
        }
    }

    // Rows without any wanted column are centred on the median of the outside parents (so the
    // band moves with its anchors), or on 0 for a band that is placed as a whole afterwards.
    let mut outside: Vec<i64> = locals.iter().flat_map(|l| l.external_parent_x.iter().copied()).collect();
    let reference = median_half(&mut outside).unwrap_or(0);
    let mut x: Vec<Option<i64>> = vec![None; locals.len()];
    for pass in PASSES {
        match pass {
            Pass::Down => {
                for (_, row) in &rows {
                    down_row(&locals, row, &mut x, sp, reference);
                }
            }
            Pass::Up => {
                for (_, row) in rows.iter().rev() {
                    up_row(&locals, row, &mut x, sp);
                }
            }
        }
    }
    BandLayout { x: x.into_iter().map(|v| v.expect("placed")).collect(), anchored }
}

struct Item {
    local: usize,
    /// Ordering key in half columns (the cohort median, or the target for focuses without one).
    key: i64,
    target: i64,
}

fn down_row(locals: &[Local], row: &[usize], x: &mut [Option<i64>], sp: i64, reference: i64) {
    // Wanted centre per focus.
    let mut keyed: Vec<(i64, usize)> = Vec::new();
    let mut keyless: Vec<usize> = Vec::new();
    for &l in row {
        let node = &locals[l];
        let mut xs: Vec<i64> = node.band_parents.iter().map(|&p| x[p].expect("parent placed above")).collect();
        xs.extend_from_slice(&node.external_parent_x);
        let centre = median_half(&mut xs).or(node.preferred_x.map(|p| 2 * p)).or(x[l].map(|v| 2 * v));
        match centre {
            Some(c) => keyed.push((c, l)),
            None => keyless.push(l),
        }
    }
    // Cohorts: same centre and same parents, members in id order (local order is id order).
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| locals[a.1].cohort.cmp(&locals[b.1].cohort)).then(a.1.cmp(&b.1)));
    let mut items: Vec<Item> = Vec::with_capacity(row.len());
    let mut i = 0;
    while i < keyed.len() {
        let mut j = i + 1;
        while j < keyed.len() && keyed[j].0 == keyed[i].0 && locals[keyed[j].1].cohort == locals[keyed[i].1].cohort {
            j += 1;
        }
        let k = (j - i) as i64;
        for (m, &(centre, l)) in keyed[i..j].iter().enumerate() {
            let target = centre + (2 * m as i64 - (k - 1)) * sp;
            items.push(Item { local: l, key: centre, target });
        }
        i = j;
    }
    let k = keyless.len() as i64;
    let base = items.iter().map(|it| it.target).max();
    for (m, &l) in keyless.iter().enumerate() {
        let target = match base {
            Some(b) => b + 2 * sp * (m as i64 + 1),
            None => reference + (2 * m as i64 - (k - 1)) * sp,
        };
        items.push(Item { local: l, key: target, target });
    }
    items.sort_by(|a, b| a.key.cmp(&b.key).then_with(|| locals[a.local].cohort.cmp(&locals[b.local].cohort)).then(a.local.cmp(&b.local)));
    place_row(locals, items, x, sp);
}

fn up_row(locals: &[Local], row: &[usize], x: &mut [Option<i64>], sp: i64) {
    let mut items: Vec<Item> = row
        .iter()
        .map(|&l| {
            let current = 2 * x[l].expect("placed by the down pass");
            let mut xs: Vec<i64> = locals[l].band_children.iter().map(|&c| x[c].expect("child placed")).collect();
            let target = median_half(&mut xs).unwrap_or(current);
            Item { local: l, key: current, target }
        })
        .collect();
    items.sort_by_key(|it| (it.key, it.local));
    place_row(locals, items, x, sp);
}

/// Groups mutually exclusive focuses into rigid units, orders the units and projects them.
fn place_row(locals: &[Local], items: Vec<Item>, x: &mut [Option<i64>], sp: i64) {
    let position_in_row: std::collections::HashMap<usize, usize> = items.iter().enumerate().map(|(i, it)| (it.local, i)).collect();
    // Union-find over items.
    let mut parent: Vec<usize> = (0..items.len()).collect();
    fn find(parent: &mut [usize], mut v: usize) -> usize {
        while parent[v] != v {
            parent[v] = parent[parent[v]];
            v = parent[v];
        }
        v
    }
    for (i, it) in items.iter().enumerate() {
        for o in &locals[it.local].exclusive {
            if let Some(&j) = position_in_row.get(o) {
                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                if a != b {
                    parent[a.max(b)] = a.min(b);
                }
            }
        }
    }
    // Units keep the item order inside; a unit is ordered by the midpoint of its first and last key.
    let mut units: Vec<Vec<usize>> = Vec::new();
    let mut unit_of: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for i in 0..items.len() {
        let root = find(&mut parent, i);
        match unit_of.get(&root) {
            Some(&u) => units[u].push(i),
            None => {
                unit_of.insert(root, units.len());
                units.push(vec![i]);
            }
        }
    }
    units.sort_by(|a, b| {
        let ka = items[a[0]].key + items[*a.last().unwrap()].key;
        let kb = items[b[0]].key + items[*b.last().unwrap()].key;
        ka.cmp(&kb).then(a[0].cmp(&b[0]))
    });
    let unit_targets: Vec<Vec<(usize, i64)>> = units.iter().map(|u| u.iter().map(|&i| (items[i].local, items[i].target)).collect()).collect();
    for (local, column) in project(&unit_targets, sp) {
        x[local] = Some(column);
    }
}

/// Order-preserving least-squares projection. `units` are rigid groups in order; member `m` of a
/// unit sits `m * spacing` columns right of the unit's first member, and consecutive units are at
/// least `spacing` apart. Targets are in half columns. Returns whole columns, rounded half toward
/// +infinity.
pub fn project(units: &[Vec<(usize, i64)>], sp: i64) -> Vec<(usize, i64)> {
    struct Block {
        sum: i128,
        weight: i128,
        first: usize,
    }
    let mut offsets = Vec::with_capacity(units.len());
    let mut cumulative: i64 = 0;
    for u in units {
        offsets.push(cumulative);
        cumulative += u.len() as i64 * sp;
    }
    let mut blocks: Vec<Block> = Vec::new();
    for (i, u) in units.iter().enumerate() {
        let w = u.len() as i128;
        let mut sum: i128 = 0;
        for (m, &(_, t)) in u.iter().enumerate() {
            sum += (t - 2 * sp * m as i64) as i128;
        }
        sum -= w * 2 * offsets[i] as i128;
        blocks.push(Block { sum, weight: w, first: i });
        while blocks.len() >= 2 {
            let last = &blocks[blocks.len() - 1];
            let prev = &blocks[blocks.len() - 2];
            // Merge while prev mean > last mean.
            if prev.sum * last.weight > last.sum * prev.weight {
                let last = blocks.pop().unwrap();
                let prev = blocks.last_mut().unwrap();
                prev.sum += last.sum;
                prev.weight += last.weight;
            } else {
                break;
            }
        }
    }
    let mut out = Vec::new();
    let mut previous: Option<i64> = None;
    for (b, block) in blocks.iter().enumerate() {
        let end = blocks.get(b + 1).map_or(units.len(), |n| n.first);
        for i in block.first..end {
            for (m, &(local, _)) in units[i].iter().enumerate() {
                let c = (2 * offsets[i] + 2 * sp * m as i64) as i128;
                let w = block.weight;
                let mut column = (block.sum + c * w + w).div_euclid(2 * w) as i64;
                if let Some(p) = previous
                    && column < p + sp
                {
                    column = p + sp;
                }
                previous = Some(column);
                out.push((local, column));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_spreads_equal_targets_symmetrically() {
        let units = vec![vec![(0, 0)], vec![(1, 0)], vec![(2, 0)]];
        assert_eq!(project(&units, 2), vec![(0, -2), (1, 0), (2, 2)]);
        let units = vec![vec![(0, 0)], vec![(1, 0)]];
        assert_eq!(project(&units, 2), vec![(0, -1), (1, 1)]);
    }

    #[test]
    fn projection_rounds_half_up_and_keeps_rigid_units() {
        // Two focuses wanting 0 with spacing 3: -1.5 and 1.5, rounded to -1 and 2.
        assert_eq!(project(&[vec![(0, 0)], vec![(1, 0)]], 3), vec![(0, -1), (1, 2)]);
        // A rigid pair and a single focus that wants the same spot.
        assert_eq!(project(&[vec![(0, 0), (1, 0)], vec![(2, 8)]], 2), vec![(0, -1), (1, 1), (2, 4)]);
    }

    #[test]
    fn median_of_an_even_count_is_the_midpoint() {
        assert_eq!(median_half(&mut [1, -1]), Some(0));
        assert_eq!(median_half(&mut [3, 0, 1]), Some(2));
        assert_eq!(median_half(&mut []), None);
    }
}
