//! The edit behind `hoi4.common_write` (operation `common.block_write`): add, replace or remove one
//! definition of a `common/<folder>/*.txt` file and nothing else, for every kind a descriptor
//! names (balance of power, AI strategy, AI strategy plan, on_action).
//!
//! New in the tutorial-path packet T3; adapted from no TypeScript file. The write path is generic:
//! it finds the container (the file's top level or the descriptor's wrapper block), places or
//! swaps one block, checks that the file parses and every other definition is byte for byte as it
//! was, and runs the kind's check on the written block. The body is raw script: it must parse
//! as the content of one block and is written byte for byte (re-indented, never reformatted).

pub mod checks;
pub mod descriptor;

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value as Json, json};

use self::checks::{CheckContext, Finding, References};
use self::descriptor::{KindDescriptor, Merge, NameRule, descriptor, kinds};
use crate::idea::{Operation, assert_body_is_one_block, id_is_valid, remove_edit};
use crate::source::{
    Block, Decoded, Entry, Item, Replacement, Source, WriteResult, apply_replacements, assignments, blank, block_of, fail, indented_body, key_of, line_indent,
    line_start, probe_one_block,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommonWriteInput {
    pub kind: String,
    pub operation: Operation,
    /// The definition: a top-level key, or the key inside the wrapper (an on_action name).
    pub id: String,
    /// The text between the braces of the definition (or, for a keyed kind, of the key).
    pub body: Option<String>,
    /// Keyed kinds only: the child block of the key that replace or remove acts on, counted from 0.
    pub block_index: Option<usize>,
    /// The strategy tokens the game documents, read by the caller from the reference index.
    pub known_tokens: Option<Vec<String>>,
    /// The on_action names the game documents, read by the caller from the reference index.
    pub known_names: Option<Vec<String>>,
}

#[derive(Debug)]
pub struct CommonWritePlan {
    pub operation: Operation,
    pub kind: String,
    pub id: String,
    pub path: String,
    pub text: String,
    pub bytes: Vec<u8>,
    pub edit: Replacement,
    pub untouched_definitions: usize,
    pub findings: Vec<Finding>,
    pub references: References,
}

impl CommonWritePlan {
    pub fn to_json(&self) -> Json {
        json!({
            "operation": self.operation.name(),
            "kind": self.kind,
            "id": self.id,
            "path": self.path,
            "edit": self.edit.to_json(),
            "untouchedDefinitions": self.untouched_definitions,
            "findings": self.findings.iter().map(Finding::to_json).collect::<Vec<_>>(),
            "references": self.references.to_json(),
        })
    }
}

/// `on_daily_TAG`, `on_weekly_TAG`, `on_monthly_TAG`.
fn is_periodic_name(name: &str) -> bool {
    ["on_daily_", "on_weekly_", "on_monthly_"]
        .iter()
        .any(|prefix| name.strip_prefix(prefix).is_some_and(|tag| tag.len() == 3 && tag.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())))
}

fn lookup(kind: &str) -> WriteResult<&'static KindDescriptor> {
    match descriptor(kind) {
        Some(found) => Ok(found),
        None => fail("COMMON_WRITE_KIND_UNKNOWN", format!("{kind} is not a kind this writer knows"), json!({ "kind": kind, "kinds": kinds() })),
    }
}

/// A path segment the mod may hold on every platform: no empty or dot segment, no NTFS stream or
/// drive (`:`), no control or wildcard character, no trailing dot or space, no reserved device name.
fn is_plain_segment(part: &str) -> bool {
    if part.is_empty() || part == "." || part == ".." || part.ends_with(['.', ' ']) {
        return false;
    }
    if part.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return false;
    }
    let stem = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    !reserved
}

fn check_path(desc: &KindDescriptor, path: &str) -> WriteResult<()> {
    let inside = path.strip_prefix(desc.folder).is_some_and(|rest| rest.starts_with('/'));
    let clean = path.split('/').all(is_plain_segment) && !path.contains('\\');
    if !inside || !clean || !path.ends_with(".txt") {
        return fail(
            "COMMON_WRITE_PATH_OUTSIDE_FOLDER",
            format!("A {} lives in a .txt file under {}/, and {path} is not one", desc.noun, desc.folder),
            json!({ "path": path, "folder": desc.folder }),
        );
    }
    Ok(())
}

fn check_request(desc: &KindDescriptor, path: &str, input: &CommonWriteInput) -> WriteResult<()> {
    check_path(desc, path)?;
    if !id_is_valid(&input.id) {
        return fail("COMMON_WRITE_ID_INVALID", format!("{} is not a valid {} name", json!(input.id), desc.noun), json!({ "id": input.id }));
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("COMMON_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove && input.body.as_deref().is_none_or(|b| b.trim().is_empty()) {
        return fail("COMMON_WRITE_BODY_REQUIRED", format!("{} needs the body of the {}", input.operation.name(), desc.noun), json!({}));
    }
    if input.block_index.is_some() && (desc.merge != Merge::KeyedChildren || input.operation == Operation::Add) {
        return fail(
            "COMMON_WRITE_BLOCK_INDEX_UNEXPECTED",
            format!("blockIndex picks a child block of an existing {} key, so only replace and remove of a keyed kind take it", desc.noun),
            json!({ "kind": desc.kind }),
        );
    }
    Ok(())
}

/// The block-valued children of the container, with their keys; every wrapper block is included.
fn container_children<'b, 't>(root: &'b Block<'t>, desc: &KindDescriptor) -> Vec<&'b Entry<'t>> {
    let only_blocks = |block: &'b Block<'t>| assignments(block, None).into_iter().filter(|e| block_of(e).is_some()).collect::<Vec<_>>();
    match desc.wrapper {
        None => only_blocks(root),
        Some(wrapper) => assignments(root, Some(wrapper)).into_iter().filter_map(|e| block_of(e)).flat_map(only_blocks).collect(),
    }
}

fn detect_unit(source: &Source<'_>, candidates: &[&Entry<'_>]) -> String {
    for entry in candidates {
        let Some(block) = block_of(entry) else { continue };
        let Some(first) = block.entries.first() else { continue };
        let outer = line_indent(source.bytes(), source.entry_range(entry).start);
        let inner = line_indent(source.bytes(), Source::item_start(first));
        if inner.len() > outer.len() && inner.starts_with(&outer) {
            return inner[outer.len()..].to_string();
        }
    }
    "\t".to_string()
}

fn definition_texts(source: &Source<'_>, desc: &KindDescriptor, skip: Option<usize>) -> BTreeMap<String, Vec<String>> {
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in container_children(&source.document.root, desc) {
        let range = source.entry_range(entry);
        if Some(range.start) == skip {
            continue;
        }
        by_key.entry(key_of(entry)).or_default().push(source.text()[range].to_string());
    }
    by_key
}

/// `{indent}{id} = {` newline, the body one unit deeper, newline `{indent}}` (no trailing newline).
fn definition_text(id: &str, body: &str, indent: &str, unit: &str, newline: &str) -> String {
    format!("{indent}{id} = {{{newline}{}{newline}{indent}}}", indented_body(body, &format!("{indent}{unit}"), newline))
}

fn layout_unsupported(message: String, details: Json) -> WriteResult<usize> {
    fail("COMMON_WRITE_LAYOUT_UNSUPPORTED", message, details)
}

/// The start of the line the closing brace of `block` is on, when that line holds nothing else.
fn close_line(source: &Source<'_>, block: &Block<'_>, what: &str) -> WriteResult<usize> {
    let text = source.bytes();
    let Some(close) = source.close_range(block) else {
        return layout_unsupported(format!("{what} has no closing brace"), json!({}));
    };
    let at = line_start(text, close.start);
    if !blank(&text[at..close.start]) {
        return layout_unsupported(
            format!("The closing brace of {what} shares its line with other text, so the new block has no line to go on"),
            json!({ "line": source.line_of(close.start) }),
        );
    }
    Ok(at)
}

/// The text of a replacement that starts at a key: the first line has no indent.
fn from_key(text: String, indent: &str) -> String {
    text.strip_prefix(indent).map_or_else(|| text.clone(), str::to_string)
}

/// `planNewCommonFile` and `planCommonWrite` in one: the edit of one definition of an existing
/// file, or, for `new_file`, the creation of a file holding it (add only).
pub fn plan_common_write(bytes: &[u8], path: &str, input: &CommonWriteInput, new_file: bool) -> WriteResult<CommonWritePlan> {
    let desc = lookup(&input.kind)?;
    check_request(desc, path, input)?;
    if new_file && input.operation != Operation::Add {
        return fail("COMMON_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let decoded = Decoded::new(bytes);
    let source = Source::new(&decoded, path);
    if source.has_blocking() {
        return fail(
            "COMMON_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": source.diagnostic_codes() }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    let root = &source.document.root;
    let id = input.id.as_str();
    let body = input.body.as_deref().unwrap_or_default();
    let keyed = desc.merge == Merge::KeyedChildren;

    // The container: the top level, or the one wrapper block.
    let wrappers: Vec<&Entry> = desc.wrapper.map(|w| assignments(root, Some(w))).unwrap_or_default();
    if let Some(wrapper) = desc.wrapper {
        if wrappers.iter().any(|e| block_of(e).is_none()) {
            return fail("COMMON_WRITE_LAYOUT_UNSUPPORTED", format!("{wrapper} is not a block in this file"), json!({ "wrapper": wrapper }));
        }
        if wrappers.len() > 1 {
            return fail(
                "COMMON_WRITE_LAYOUT_UNSUPPORTED",
                format!("The file has {} {wrapper} blocks, so there is no one place for the edit", wrappers.len()),
                json!({ "wrapper": wrapper, "lines": wrappers.iter().map(|e| e.key.line).collect::<Vec<_>>() }),
            );
        }
    }
    let wrapper_entry = wrappers.first().copied();
    let container: Option<&Block> = match desc.wrapper {
        None => Some(root),
        Some(_) => wrapper_entry.and_then(|e| block_of(e)),
    };
    let children: Vec<&Entry> = container_children(root, desc);
    let existing: Vec<&Entry> = children.iter().copied().filter(|e| e.key.value == id).collect();

    if desc.name_rule == NameRule::DocumentedOrPattern
        && input.operation != Operation::Remove
        && existing.is_empty()
        && !is_periodic_name(id)
        && !input.known_names.as_deref().unwrap_or_default().iter().any(|n| n == id)
    {
        let mut known: Vec<&str> = input.known_names.as_deref().unwrap_or_default().iter().map(String::as_str).collect();
        known.sort_unstable();
        let why = if known.is_empty() { ", and the game documentation of the on_action names was not found, so no other name can be checked" } else { "" };
        return fail(
            "COMMON_WRITE_NAME_UNKNOWN",
            format!("{id} is not a documented {} name, an on_daily_TAG, on_weekly_TAG or on_monthly_TAG name, or a name already in this file{why}", desc.noun),
            json!({ "id": id, "known": known, "documentationFound": !known.is_empty() }),
        );
    }
    if existing.len() > 1 {
        return fail(
            "COMMON_WRITE_DUPLICATE_ID",
            format!("{id} is defined {} times in this file", existing.len()),
            json!({ "id": id, "lines": existing.iter().map(|e| e.key.line).collect::<Vec<_>>() }),
        );
    }
    let mut unit_candidates: Vec<&Entry> = children.clone();
    unit_candidates.extend(wrapper_entry);
    let unit = detect_unit(&source, &unit_candidates);
    let container_indent = wrapper_entry.map_or_else(String::new, |e| line_indent(text, source.entry_range(e).start));
    let child_indent = match children.first() {
        Some(first) => line_indent(text, source.entry_range(first).start),
        None if desc.wrapper.is_some() => format!("{container_indent}{unit}"),
        None => String::new(),
    };
    let missing_end = |newline: &str| if text.is_empty() { String::new() } else { format!("{}{newline}", if text.ends_with(b"\n") { "" } else { newline }) };

    let edit: Replacement;
    let mut skip = None;
    let body_checked = |code: &str| assert_body_is_one_block(id, body, code, desc.noun);
    match input.operation {
        Operation::Add => {
            body_checked("COMMON_WRITE_BODY_INVALID")?;
            if let Some(found) = existing.first() {
                if !keyed {
                    return fail("COMMON_WRITE_DUPLICATE_ID", format!("{id} is already defined in this file"), json!({ "id": id, "line": found.key.line }));
                }
                // Keyed: the body's entries join the key's block.
                let block = block_of(found).expect("children are blocks");
                let at = close_line(&source, block, &format!("the {id} block"))?;
                let inner = format!("{}{unit}", line_indent(text, source.entry_range(found).start));
                skip = Some(source.entry_range(found).start);
                edit =
                    Replacement { start: at, end: at, text: format!("{}{newline}", indented_body(body, &inner, newline)), description: format!("add to {id}") };
            } else if let Some(block) = container.filter(|_| wrapper_entry.is_some()) {
                let at = close_line(&source, block, &format!("the {} block", desc.wrapper.unwrap_or_default()))?;
                let sep = if block.entries.is_empty() { "" } else { newline };
                edit = Replacement {
                    start: at,
                    end: at,
                    text: format!("{sep}{}{newline}", definition_text(id, body, &child_indent, &unit, newline)),
                    description: format!("add {id}"),
                };
            } else {
                let lead = missing_end(newline);
                let def = match desc.wrapper {
                    Some(wrapper) => format!("{wrapper} = {{{newline}{}{newline}}}", definition_text(id, body, &unit, &unit, newline)),
                    None => definition_text(id, body, "", &unit, newline),
                };
                edit = Replacement { start: text.len(), end: text.len(), text: format!("{lead}{def}{newline}"), description: format!("add {id}") };
            }
        }
        Operation::Replace | Operation::Remove => {
            let Some(found) = existing.first() else {
                return fail("COMMON_WRITE_NOT_FOUND", format!("{id} is not defined in this file"), json!({ "id": id }));
            };
            let range = source.entry_range(found);
            skip = Some(range.start);
            let indent = line_indent(text, range.start);
            if let Some(index) = input.block_index {
                let key_block = block_of(found).expect("children are blocks");
                let parts: Vec<&Entry> = assignments(key_block, None).into_iter().filter(|e| block_of(e).is_some()).collect();
                let Some(part) = parts.get(index) else {
                    return fail(
                        "COMMON_WRITE_BLOCK_INDEX_OUT_OF_RANGE",
                        format!("{id} has {} child block(s), so blockIndex {index} does not exist", parts.len()),
                        json!({ "id": id, "blockCount": parts.len() }),
                    );
                };
                let part_range = source.entry_range(part);
                let part_indent = line_indent(text, part_range.start);
                edit = if input.operation == Operation::Replace {
                    let one_block = |b: &Block<'_>| matches!(b.entries.as_slice(), [Item::Assignment(entry)] if block_of(entry).is_some());
                    if !matches!(probe_one_block(id, body, one_block), Ok(true)) {
                        return fail("COMMON_WRITE_BODY_INVALID", "A block replacement takes exactly one block entry (key = { ... }) as its body", json!({}));
                    }
                    Replacement {
                        start: part_range.start,
                        end: part_range.end,
                        text: from_key(indented_body(body, &part_indent, newline), &part_indent),
                        description: format!("replace block {index} of {id}"),
                    }
                } else {
                    remove_edit(&source, &format!("block {index} of {id}"), part_range.start, part_range.end, false)
                };
            } else if input.operation == Operation::Replace {
                body_checked("COMMON_WRITE_BODY_INVALID")?;
                edit = Replacement {
                    start: range.start,
                    end: range.end,
                    text: from_key(definition_text(id, body, &indent, &unit, newline), &indent),
                    description: format!("replace {id}"),
                };
            } else {
                edit = remove_edit(&source, id, range.start, range.end, false);
            }
        }
    }

    let (after_text, new_bytes) = apply_replacements(&source, std::slice::from_ref(&edit))?;
    let written_decoded = Decoded::new(&new_bytes);
    let written = Source::new(&written_decoded, path);
    if written.has_blocking() {
        return fail(
            "COMMON_WRITE_RESULT_INVALID",
            "The edit would leave the file with syntax errors",
            json!({ "diagnosticCodes": written.diagnostic_codes() }),
        );
    }
    let before = definition_texts(&source, desc, skip);
    let after = definition_texts(&written, desc, None);
    let mut untouched = 0;
    for (key, texts) in &before {
        let now = after.get(key).map(Vec::as_slice).unwrap_or_default();
        for definition in texts {
            if now.contains(definition) {
                untouched += 1;
            } else {
                return fail("COMMON_WRITE_RESULT_INVALID", format!("The edit would change {key}, which it must not touch"), json!({ "key": key }));
            }
        }
    }
    if written.text() != after_text {
        return fail("COMMON_WRITE_RESULT_INVALID", "The written file does not match the planned edit", json!({}));
    }

    let mut findings = Vec::new();
    let mut references = References::default();
    if input.operation != Operation::Remove || input.block_index.is_some() {
        let target = container_children(&written.document.root, desc).into_iter().find(|e| e.key.value == id).and_then(|e| block_of(e));
        if let Some(block) = target {
            let outcome = (desc.check)(&CheckContext { id, known_tokens: input.known_tokens.as_deref() }, block);
            findings = outcome.findings;
            references = outcome.references;
        }
    }
    if findings.iter().any(|f| f.severity == "error") {
        let errors: Vec<Json> = findings.iter().filter(|f| f.severity == "error").map(Finding::to_json).collect();
        let first = findings.iter().find(|f| f.severity == "error").map(|f| f.message.clone()).unwrap_or_default();
        return fail("COMMON_WRITE_CHECK_FAILED", format!("The {} would not be valid: {first}", desc.noun), json!({ "id": id, "errors": errors }));
    }
    Ok(CommonWritePlan {
        operation: input.operation,
        kind: input.kind.clone(),
        id: id.to_string(),
        path: path.to_string(),
        text: after_text,
        bytes: new_bytes,
        edit,
        untouched_definitions: untouched,
        findings,
        references,
    })
}

#[cfg(test)]
mod tests;
