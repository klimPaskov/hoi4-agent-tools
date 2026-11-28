//! Unified text diffs and binary diffs, byte-equal to the TypeScript ones.
//!
//! Ported from `src/hoi4_agent_tools/core/diff.ts` (`unifiedTextDiff`, `diffHunks`, `lcsDiff`,
//! `matrixDiff`, `patienceDiff`, `binaryDiff`), commit `9b7dc80d`. The line split, the matrix tie
//! break and the patience anchors follow the TypeScript code step by step, because the diff text
//! is stored in artifacts and compared by hash.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// Matrix threshold before the exact linear-memory patience algorithm is used.
pub const DEFAULT_MAX_MATRIX_CELLS: u64 = 16_000_000;
/// The most matrix cells a caller may ask for (four bytes each); a larger request is refused
/// instead of letting a hostile option allocate until the process aborts.
pub const MAX_MATRIX_CELLS_CEILING: u64 = 64_000_000;
/// Unchanged lines a source writer shows around each change in its preview.
pub const DIFF_CONTEXT_LINES: usize = 3;

#[derive(Clone, Debug, Default)]
pub struct TextDiffOptions {
    pub max_matrix_cells: Option<u64>,
    /// Unchanged lines kept around each change; `None` gives one hunk holding the whole file.
    pub context: Option<usize>,
}

/// Refuses options that would make the diff allocate without bound.
pub fn check_options(options: &TextDiffOptions) -> Result<(), crate::error::StoreError> {
    match options.max_matrix_cells {
        Some(cells) if cells > MAX_MATRIX_CELLS_CEILING => Err(crate::error::StoreError::with_details(
            "DIFF_OPTIONS_INVALID",
            "maxMatrixCells exceeds the fixed ceiling",
            serde_json::json!({ "maximum": MAX_MATRIX_CELLS_CEILING }),
        )),
        _ => Ok(()),
    }
}

/// Lines with their terminators, as the TypeScript `splitLines` regex cuts them.
fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                index += if bytes.get(index + 1) == Some(&b'\n') { 2 } else { 1 };
                lines.push(&text[start..index]);
                start = index;
            }
            b'\n' => {
                index += 1;
                lines.push(&text[start..index]);
                start = index;
            }
            _ => index += 1,
        }
    }
    if start < bytes.len() {
        lines.push(&text[start..]);
    }
    lines
}

fn line_content(line: &str) -> &str {
    line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\r')).or_else(|| line.strip_suffix('\n')).unwrap_or(line)
}

/// The unified diff of two texts, or an empty string when they are equal.
pub fn unified_text_diff(old_text: &str, new_text: &str, old_name: &str, new_name: &str, options: &TextDiffOptions) -> String {
    if old_text == new_text {
        return String::new();
    }
    let old_lines = split_lines(old_text);
    let new_lines = split_lines(new_text);
    let rows = lcs_diff(&old_lines, &new_lines, options);
    let mut out: Vec<String> = vec![format!("--- {old_name}"), format!("+++ {new_name}")];
    match options.context {
        Some(context) => out.extend(diff_hunks(&rows, context)),
        None => {
            out.push(format!("@@ -1,{} +1,{} @@", old_lines.len(), new_lines.len()));
            out.extend(rows);
        }
    }
    out.join("\n")
}

/// The diff rows cut into hunks of changed rows with `context` unchanged rows on each side.
fn diff_hunks(rows: &[String], context: usize) -> Vec<String> {
    let mut old_before = Vec::with_capacity(rows.len());
    let mut new_before = Vec::with_capacity(rows.len());
    let (mut old_count, mut new_count) = (0usize, 0usize);
    let mut changed = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        old_before.push(old_count);
        new_before.push(new_count);
        if row.starts_with('-') {
            old_count += 1;
        } else if row.starts_with('+') {
            new_count += 1;
        } else {
            old_count += 1;
            new_count += 1;
        }
        if !row.starts_with(' ') {
            changed.push(index);
        }
    }
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for index in changed {
        let start = index.saturating_sub(context);
        let end = index.saturating_add(context).min(rows.len() - 1);
        match groups.last_mut() {
            Some(last) if start <= last.1 + 1 => last.1 = end,
            _ => groups.push((start, end)),
        }
    }
    let mut out = Vec::new();
    for (start, end) in groups {
        let slice = &rows[start..=end];
        let removed = slice.iter().filter(|row| !row.starts_with('+')).count();
        let added = slice.iter().filter(|row| !row.starts_with('-')).count();
        let old_start = old_before[start] + usize::from(removed > 0);
        let new_start = new_before[start] + usize::from(added > 0);
        out.push(format!("@@ -{old_start},{removed} +{new_start},{added} @@"));
        out.extend(slice.iter().cloned());
    }
    out
}

fn lcs_diff(old_lines: &[&str], new_lines: &[&str], options: &TextDiffOptions) -> Vec<String> {
    let cells = (old_lines.len() as u64 + 1).checked_mul(new_lines.len() as u64 + 1);
    let max = options.max_matrix_cells.unwrap_or(DEFAULT_MAX_MATRIX_CELLS).min(MAX_MATRIX_CELLS_CEILING);
    match cells {
        Some(cells) if cells <= max => matrix_diff(old_lines, new_lines),
        _ => patience_diff(old_lines, new_lines, max),
    }
}

fn row(marker: char, line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 1);
    out.push(marker);
    out.push_str(line_content(line));
    out
}

fn matrix_diff(old_lines: &[&str], new_lines: &[&str]) -> Vec<String> {
    let columns = new_lines.len() + 1;
    let mut table = vec![0u32; (old_lines.len() + 1) * columns];
    for old_index in (0..old_lines.len()).rev() {
        for new_index in (0..new_lines.len()).rev() {
            let current = old_index * columns + new_index;
            table[current] = if old_lines[old_index] == new_lines[new_index] {
                table[(old_index + 1) * columns + new_index + 1] + 1
            } else {
                table[(old_index + 1) * columns + new_index].max(table[old_index * columns + new_index + 1])
            };
        }
    }
    let mut result = Vec::new();
    let (mut old_index, mut new_index) = (0, 0);
    while old_index < old_lines.len() || new_index < new_lines.len() {
        if old_index < old_lines.len() && new_index < new_lines.len() && old_lines[old_index] == new_lines[new_index] {
            result.push(row(' ', old_lines[old_index]));
            old_index += 1;
            new_index += 1;
        } else if new_index < new_lines.len()
            && (old_index == old_lines.len() || table[old_index * columns + new_index + 1] >= table[(old_index + 1) * columns + new_index])
        {
            result.push(row('+', new_lines[new_index]));
            new_index += 1;
        } else {
            result.push(row('-', old_lines[old_index]));
            old_index += 1;
        }
    }
    result
}

#[derive(Clone, Copy)]
struct Range {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Same,
    Delete,
    Add,
}

enum Task {
    Range(Range),
    Emit { kind: Kind, start: usize, end: usize },
}

fn unique_line_indexes<'a>(lines: &[&'a str], start: usize, end: usize) -> HashMap<&'a str, usize> {
    let mut indexes: HashMap<&str, usize> = HashMap::new();
    let mut repeated: HashSet<&str> = HashSet::new();
    for (index, line) in lines.iter().enumerate().take(end).skip(start) {
        if repeated.contains(line) {
            continue;
        }
        if indexes.contains_key(line) {
            indexes.remove(line);
            repeated.insert(line);
        } else {
            indexes.insert(line, index);
        }
    }
    indexes
}

fn patience_anchors(old_lines: &[&str], new_lines: &[&str], range: Range) -> Vec<(usize, usize)> {
    let old_unique = unique_line_indexes(old_lines, range.old_start, range.old_end);
    let new_unique = unique_line_indexes(new_lines, range.new_start, range.new_end);
    let mut candidates: Vec<(usize, usize)> =
        old_unique.iter().filter_map(|(line, old_index)| new_unique.get(line).map(|new_index| (*old_index, *new_index))).collect();
    candidates.sort_by_key(|candidate| candidate.0);
    if candidates.len() <= 1 {
        return candidates;
    }
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![usize::MAX; candidates.len()];
    for index in 0..candidates.len() {
        let new_index = candidates[index].1;
        let (mut low, mut high) = (0, tails.len());
        while low < high {
            let middle = (low + high) >> 1;
            if candidates[tails[middle]].1 < new_index {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        if low > 0 {
            previous[index] = tails[low - 1];
        }
        if low == tails.len() {
            tails.push(index);
        } else {
            tails[low] = index;
        }
    }
    let mut anchors = vec![(0, 0); tails.len()];
    let mut current = *tails.last().unwrap();
    for slot in (0..anchors.len()).rev() {
        anchors[slot] = candidates[current];
        current = previous[current];
    }
    anchors
}

fn patience_diff(old_lines: &[&str], new_lines: &[&str], matrix_threshold: u64) -> Vec<String> {
    let mut result = Vec::new();
    let mut tasks = vec![Task::Range(Range { old_start: 0, old_end: old_lines.len(), new_start: 0, new_end: new_lines.len() })];
    while let Some(task) = tasks.pop() {
        let range = match task {
            Task::Emit { kind, start, end } => {
                let (lines, marker) = match kind {
                    Kind::Add => (new_lines, '+'),
                    Kind::Same => (old_lines, ' '),
                    Kind::Delete => (old_lines, '-'),
                };
                for line in &lines[start..end] {
                    result.push(row(marker, line));
                }
                continue;
            }
            Task::Range(range) => range,
        };
        let Range { mut old_start, mut old_end, mut new_start, mut new_end } = range;
        while old_start < old_end && new_start < new_end && old_lines[old_start] == new_lines[new_start] {
            result.push(row(' ', old_lines[old_start]));
            old_start += 1;
            new_start += 1;
        }
        let mut common_suffix = 0;
        while old_start + common_suffix < old_end
            && new_start + common_suffix < new_end
            && old_lines[old_end - common_suffix - 1] == new_lines[new_end - common_suffix - 1]
        {
            common_suffix += 1;
        }
        old_end -= common_suffix;
        new_end -= common_suffix;
        if common_suffix > 0 {
            tasks.push(Task::Emit { kind: Kind::Same, start: old_end, end: old_end + common_suffix });
        }
        if old_start == old_end {
            if new_start < new_end {
                tasks.push(Task::Emit { kind: Kind::Add, start: new_start, end: new_end });
            }
            continue;
        }
        if new_start == new_end {
            tasks.push(Task::Emit { kind: Kind::Delete, start: old_start, end: old_end });
            continue;
        }
        let range_cells = ((old_end - old_start + 1) as u64).checked_mul((new_end - new_start + 1) as u64);
        if matches!(range_cells, Some(cells) if cells <= matrix_threshold) {
            result.extend(matrix_diff(&old_lines[old_start..old_end], &new_lines[new_start..new_end]));
            continue;
        }
        let range = Range { old_start, old_end, new_start, new_end };
        let anchors = patience_anchors(old_lines, new_lines, range);
        if anchors.is_empty() {
            tasks.push(Task::Emit { kind: Kind::Add, start: new_start, end: new_end });
            tasks.push(Task::Emit { kind: Kind::Delete, start: old_start, end: old_end });
            continue;
        }
        let mut ordered = Vec::new();
        let (mut previous_old, mut previous_new) = (old_start, new_start);
        for (anchor_old, anchor_new) in anchors {
            if previous_old < anchor_old || previous_new < anchor_new {
                ordered.push(Task::Range(Range { old_start: previous_old, old_end: anchor_old, new_start: previous_new, new_end: anchor_new }));
            }
            ordered.push(Task::Emit { kind: Kind::Same, start: anchor_old, end: anchor_old + 1 });
            previous_old = anchor_old + 1;
            previous_new = anchor_new + 1;
        }
        if previous_old < old_end || previous_new < new_end {
            ordered.push(Task::Range(Range { old_start: previous_old, old_end, new_start: previous_new, new_end }));
        }
        tasks.extend(ordered.into_iter().rev());
    }
    result
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDiff {
    pub old_size: u64,
    pub new_size: u64,
    pub changed_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_changed_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_changed_offset: Option<u64>,
}

/// Counts the differing bytes of two buffers; a missing byte differs from any present byte.
pub fn binary_diff(old_bytes: &[u8], new_bytes: &[u8]) -> BinaryDiff {
    let length = old_bytes.len().max(new_bytes.len());
    let (mut changed, mut first, mut last) = (0u64, None, None);
    for index in 0..length {
        if old_bytes.get(index) != new_bytes.get(index) {
            changed += 1;
            first.get_or_insert(index as u64);
            last = Some(index as u64);
        }
    }
    BinaryDiff {
        old_size: old_bytes.len() as u64,
        new_size: new_bytes.len() as u64,
        changed_bytes: changed,
        first_changed_offset: first,
        last_changed_offset: last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(old: &str, new: &str, context: Option<usize>) -> String {
        unified_text_diff(old, new, "a/f", "b/f", &TextDiffOptions { context, ..Default::default() })
    }

    #[test]
    fn equal_texts_give_nothing() {
        assert_eq!(diff("a\nb\n", "a\nb\n", None), "");
    }

    #[test]
    fn whole_file_hunk_keeps_every_row() {
        assert_eq!(diff("a\nb\nc\n", "a\nx\nc\n", None), "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n+x\n-b\n c");
    }

    #[test]
    fn context_hunks_split_far_changes() {
        let old: String = (1..=20).map(|n| format!("l{n}\n")).collect();
        let new = old.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
        let text = diff(&old, &new, Some(1));
        assert!(text.contains("@@ -1,3 +1,3 @@"), "{text}");
        assert!(text.contains("@@ -18,3 +18,3 @@"), "{text}");
    }

    #[test]
    fn creating_a_file_has_a_zero_old_start() {
        assert_eq!(diff("", "a\n", Some(3)), "--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+a");
    }

    #[test]
    fn keeps_line_endings_out_of_the_rows_but_in_the_comparison() {
        assert_eq!(diff("a\r\nb\n", "a\nb\n", None), "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n+a\n-a\n b");
        assert_eq!(split_lines("a\rb\r\nc"), vec!["a\r", "b\r\n", "c"]);
    }

    #[test]
    fn patience_path_matches_the_matrix_on_a_small_edit() {
        let old: String = (0..60).map(|n| format!("line {n}\n")).collect();
        let new = old.replace("line 30\n", "changed\n");
        let options = TextDiffOptions { max_matrix_cells: Some(10), context: Some(2) };
        let patience = unified_text_diff(&old, &new, "a", "b", &options);
        let matrix = unified_text_diff(&old, &new, "a", "b", &TextDiffOptions { context: Some(2), ..Default::default() });
        assert_eq!(patience, matrix);
    }

    #[test]
    fn binary_diff_counts_changes_and_length() {
        let diff = binary_diff(&[1, 2, 3], &[1, 9, 3, 4]);
        assert_eq!((diff.changed_bytes, diff.first_changed_offset, diff.last_changed_offset), (2, Some(1), Some(3)));
        assert_eq!(binary_diff(&[1], &[1]).first_changed_offset, None);
    }

    #[test]
    fn a_hostile_context_does_not_overflow() {
        let old: String = (0..20).map(|n| format!("line {n}\n")).collect();
        let new = old.replace("line 10", "changed");
        let options = TextDiffOptions { context: Some(usize::MAX), ..Default::default() };
        let diff = unified_text_diff(&old, &new, "a", "b", &options);
        assert!(diff.contains("-line 10") && diff.contains("+changed"));
    }

    #[test]
    fn a_matrix_ceiling_above_the_fixed_one_is_refused() {
        let too_big = TextDiffOptions { max_matrix_cells: Some(MAX_MATRIX_CELLS_CEILING + 1), ..Default::default() };
        assert_eq!(check_options(&too_big).unwrap_err().code, "DIFF_OPTIONS_INVALID");
        assert!(check_options(&TextDiffOptions { max_matrix_cells: Some(MAX_MATRIX_CELLS_CEILING), ..Default::default() }).is_ok());
        assert!(check_options(&TextDiffOptions::default()).is_ok());
        // Even an unchecked caller cannot make the diff allocate past the ceiling.
        let lines: String = (0..30).map(|n| format!("{n}\n")).collect();
        let unchecked = TextDiffOptions { max_matrix_cells: Some(u64::MAX), context: Some(1) };
        assert!(!unified_text_diff(&lines, &lines.replace("5\n", "five\n"), "a", "b", &unchecked).is_empty());
    }
}
