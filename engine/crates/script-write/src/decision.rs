//! The edit behind `hoi4.decision_write`: add, replace or remove one decision of a
//! `common/decisions/*.txt` file and nothing else.
//!
//! Ported from `src/hoi4_agent_tools/decision/write-plan.ts` (`planDecisionWrite`,
//! `planNewDecisionFile`, `decisionCategories` and their helpers), commit `ef3d2215`.

use std::collections::BTreeMap;

use hoi4_syntax::{Document, Entry};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::idea::{Operation, assert_body_is_one_block, id_is_valid, remove_edit};
use crate::source::{Replacement, Source, WriteResult, apply_replacements, assignments, blank, block_of, diagnostic_codes, fail, indented_body, line_indent, line_start};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionWriteInput {
    pub operation: Operation,
    pub id: String,
    pub category: Option<String>,
    pub create_category: Option<bool>,
    pub body: Option<String>,
}

#[derive(Debug)]
pub struct DecisionWritePlan {
    pub operation: Operation,
    pub id: String,
    pub category: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub edit: Replacement,
    pub untouched_definitions: usize,
}

impl DecisionWritePlan {
    pub fn to_json(&self) -> Json {
        json!({
            "operation": self.operation.name(),
            "id": self.id,
            "category": self.category,
            "path": self.path,
            "edit": self.edit.to_json(),
            "untouchedDefinitions": self.untouched_definitions,
        })
    }
}

struct Located<'a> {
    decision: &'a Entry,
    category: &'a Entry,
}

/// The top-level category blocks of a decisions file.
fn category_blocks<'a>(source: &Source, document: &'a Document) -> Vec<&'a Entry> {
    assignments(source, &document.root, None).into_iter().filter(|e| block_of(e).is_some()).collect()
}

/// Every `<category> = { <decision> = { ... } }` definition of the document.
fn definitions<'a>(source: &Source, document: &'a Document) -> Vec<Located<'a>> {
    category_blocks(source, document)
        .into_iter()
        .flat_map(|category| {
            let block = block_of(category).expect("filtered to blocks");
            assignments(source, block, None).into_iter().filter(|e| block_of(e).is_some()).map(move |decision| Located { decision, category }).collect::<Vec<_>>()
        })
        .collect()
}

fn indent_unit(source: &Source, located: &[Located]) -> String {
    for Located { decision, category } in located {
        let outer = line_indent(source.bytes(), source.entry_range(category).start);
        let inner = line_indent(source.bytes(), source.entry_range(decision).start);
        if inner.len() > outer.len() && inner.starts_with(&outer) {
            return inner[outer.len()..].to_string();
        }
    }
    "\t".to_string()
}

fn definition_texts(source: &Source, document: &Document, skip: Option<usize>) -> BTreeMap<String, Vec<Vec<u8>>> {
    let mut by_key: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    for Located { decision, category } in definitions(source, document) {
        let range = source.entry_range(decision);
        if Some(range.start) == skip {
            continue;
        }
        by_key.entry(format!("{}:{}", source.key(category), source.key(decision))).or_default().push(source.bytes()[range].to_vec());
    }
    by_key
}

fn check_request(input: &DecisionWriteInput) -> WriteResult<()> {
    if !id_is_valid(&input.id) {
        return fail("DECISION_WRITE_ID_INVALID", format!("{} is not a valid decision id", json!(input.id)), json!({ "id": input.id }));
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("DECISION_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove && input.body.as_deref().is_none_or(|b| b.trim().is_empty()) {
        return fail("DECISION_WRITE_BODY_REQUIRED", format!("{} needs the body of the decision", input.operation.name()), json!({}));
    }
    if input.operation != Operation::Add && input.create_category == Some(true) {
        return fail("DECISION_WRITE_CATEGORY_UNEXPECTED", "createCategory applies to add only", json!({}));
    }
    if let Some(category) = input.category.as_deref()
        && !id_is_valid(category)
    {
        return fail("DECISION_WRITE_CATEGORY_INVALID", format!("{} is not a valid category name", json!(category)), json!({ "category": category }));
    }
    Ok(())
}

/// `planNewDecisionFile`: a new `common/decisions` file with one category block and one decision.
pub fn plan_new_decision_file(path: &str, input: &DecisionWriteInput) -> WriteResult<DecisionWritePlan> {
    check_request(input)?;
    if input.operation != Operation::Add {
        return fail("DECISION_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let Some(category) = input.category.as_deref() else {
        return fail("DECISION_WRITE_CATEGORY_REQUIRED", "a new file needs the category block the decision goes in", json!({}));
    };
    let body = input.body.as_deref().unwrap_or_default();
    assert_body_is_one_block(&input.id, body, "DECISION_WRITE_BODY_INVALID", "decision")?;
    let text = [format!("{category} = {{"), format!("\t{} = {{", input.id), indented_body(body, "\t\t", "\n"), "\t}".to_string(), "}".to_string(), String::new()].join("\n");
    let written = Source::parse(text.as_bytes(), path);
    if written.has_blocking() {
        return fail("DECISION_WRITE_RESULT_INVALID", "The new file would have syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
    }
    Ok(DecisionWritePlan {
        operation: Operation::Add,
        id: input.id.clone(),
        category: category.to_string(),
        path: path.to_string(),
        bytes: text.clone().into_bytes(),
        edit: Replacement { start: 0, end: 0, text, description: format!("create {path} with {}", input.id) },
        untouched_definitions: 0,
    })
}

/// `planDecisionWrite`: the edit of one decision of an existing file.
pub fn plan_decision_write(bytes: &[u8], path: &str, input: &DecisionWriteInput) -> WriteResult<DecisionWritePlan> {
    check_request(input)?;
    let source = Source::parse(bytes, path);
    if source.has_blocking() {
        return fail(
            "DECISION_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": diagnostic_codes(&source) }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    let located = definitions(&source, &source.document);
    if let Some(body) = input.body.as_deref() {
        assert_body_is_one_block(&input.id, body, "DECISION_WRITE_BODY_INVALID", "decision")?;
    }
    let unit = indent_unit(&source, &located);
    let existing: Vec<&Located> = located.iter().filter(|l| source.key(l.decision) == input.id).collect();
    let body = input.body.as_deref().unwrap_or_default();

    let edit;
    let category;
    let mut skip = None;
    if input.operation == Operation::Add {
        if let Some(first) = existing.first() {
            return fail(
                "DECISION_WRITE_DUPLICATE_ID",
                format!("{} is already defined in this file", input.id),
                json!({ "id": input.id, "category": source.key(first.category), "line": source.line_of_key(first.decision) }),
            );
        }
        let Some(wanted) = input.category.as_deref() else {
            return fail("DECISION_WRITE_CATEGORY_REQUIRED", "add needs the category block the decision goes in", json!({}));
        };
        let blocks = category_blocks(&source, &source.document);
        let matching: Vec<&Entry> = blocks.iter().copied().filter(|e| source.key(e) == wanted).collect();
        if matching.is_empty() && input.create_category != Some(true) {
            let mut categories: Vec<String> = Vec::new();
            for entry in &blocks {
                let key = source.key(entry);
                if !categories.contains(&key) {
                    categories.push(key);
                }
            }
            return fail(
                "DECISION_WRITE_CATEGORY_NOT_FOUND",
                format!("The file has no {wanted} category block; pass createCategory: true to create it"),
                json!({ "category": wanted, "categories": categories }),
            );
        }
        if matching.len() > 1 {
            return fail(
                "DECISION_WRITE_CATEGORY_AMBIGUOUS",
                format!("The file has {} {wanted} category blocks", matching.len()),
                json!({ "category": wanted, "lines": matching.iter().map(|e| source.line_of_key(e)).collect::<Vec<_>>() }),
            );
        }
        edit = if matching.is_empty() {
            let lead = if text.is_empty() { String::new() } else { format!("{}{newline}", if text.ends_with(b"\n") { "" } else { newline }) };
            Replacement {
                start: text.len(),
                end: text.len(),
                text: format!(
                    "{lead}{wanted} = {{{newline}{unit}{} = {{{newline}{}{newline}{unit}}}{newline}}}{newline}",
                    input.id,
                    indented_body(body, &format!("{unit}{unit}"), newline)
                ),
                description: format!("add {} in the new category {wanted}", input.id),
            }
        } else {
            let target = matching[0];
            let block = block_of(target).expect("filtered to blocks");
            let Some(close) = source.close_range(block) else {
                return fail("DECISION_WRITE_LAYOUT_UNSUPPORTED", format!("The {wanted} category has no closing brace"), json!({}));
            };
            let close_line_start = line_start(text, close.start);
            if !blank(&text[close_line_start..close.start]) {
                return fail(
                    "DECISION_WRITE_LAYOUT_UNSUPPORTED",
                    format!("The closing brace of {wanted} shares its line with other text, so the new decision has no line to go on"),
                    json!({ "category": wanted, "line": source.line_of(close.start) }),
                );
            }
            let decision_indent = format!("{}{unit}", line_indent(text, source.entry_range(target).start));
            let decision_text = format!("{decision_indent}{} = {{{newline}{}{newline}{decision_indent}}}{newline}", input.id, indented_body(body, &format!("{decision_indent}{unit}"), newline));
            Replacement {
                start: close_line_start,
                end: close_line_start,
                text: format!("{}{decision_text}", if block.items.is_empty() { "" } else { newline }),
                description: format!("add {} to {wanted}", input.id),
            }
        };
        category = wanted.to_string();
    } else {
        if existing.is_empty() {
            return fail("DECISION_WRITE_NOT_FOUND", format!("{} is not defined in this file", input.id), json!({ "id": input.id }));
        }
        if existing.len() > 1 {
            return fail(
                "DECISION_WRITE_DUPLICATE_ID",
                format!("{} is defined {} times in this file", input.id, existing.len()),
                json!({ "id": input.id, "lines": existing.iter().map(|l| source.line_of_key(l.decision)).collect::<Vec<_>>() }),
            );
        }
        let found = existing[0];
        category = source.key(found.category);
        if input.category.as_deref().is_some_and(|c| c != category) {
            return fail(
                "DECISION_WRITE_CATEGORY_MISMATCH",
                format!("{} is in {category}, and moving a decision to another category is not supported", input.id),
                json!({ "id": input.id, "category": category }),
            );
        }
        let range = source.entry_range(found.decision);
        skip = Some(range.start);
        let decision_indent = line_indent(text, range.start);
        edit = if input.operation == Operation::Replace {
            Replacement {
                start: range.start,
                end: range.end,
                text: format!("{} = {{{newline}{}{newline}{decision_indent}}}", input.id, indented_body(body, &format!("{decision_indent}{unit}"), newline)),
                description: format!("replace {}", input.id),
            }
        } else {
            remove_edit(&source, &input.id, range.start, range.end, false)
        };
    }

    let new_bytes = apply_replacements(&source, std::slice::from_ref(&edit))?;
    let written = Source::parse(&new_bytes, path);
    if written.has_blocking() {
        return fail("DECISION_WRITE_RESULT_INVALID", "The edit would leave the file with syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
    }
    let before = definition_texts(&source, &source.document, skip);
    let after = definition_texts(&written, &written.document, None);
    let mut untouched = 0;
    for (key, texts) in &before {
        let now = after.get(key).map(Vec::as_slice).unwrap_or_default();
        for definition in texts {
            if now.contains(definition) {
                untouched += 1;
            } else {
                return fail("DECISION_WRITE_RESULT_INVALID", format!("The edit would change {key}, which it must not touch"), json!({ "key": key }));
            }
        }
    }
    Ok(DecisionWritePlan { operation: input.operation, id: input.id.clone(), category, path: path.to_string(), bytes: new_bytes, edit, untouched_definitions: untouched })
}

/// The category blocks of a `common/decisions` file, or none when the file cannot be parsed.
pub fn decision_categories(bytes: &[u8], path: &str) -> Vec<String> {
    let source = Source::parse(bytes, path);
    if source.has_blocking() {
        return Vec::new();
    }
    let mut seen: Vec<String> = Vec::new();
    for entry in category_blocks(&source, &source.document) {
        let key = source.key(entry);
        if !seen.contains(&key) {
            seen.push(key);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "# decisions\nmy_category = {\n\tfirst_decision = {\n\t\ticon = x\n\t}\n\n\tsecond_decision = {\n\t\ticon = y\n\t}\n}\n";

    fn input(operation: Operation, id: &str, category: Option<&str>, body: Option<&str>) -> DecisionWriteInput {
        DecisionWriteInput { operation, id: id.into(), category: category.map(Into::into), create_category: None, body: body.map(Into::into) }
    }

    fn plan(i: &DecisionWriteInput) -> WriteResult<DecisionWritePlan> {
        plan_decision_write(FILE.as_bytes(), "common/decisions/t.txt", i)
    }

    fn code(r: WriteResult<DecisionWritePlan>) -> String {
        r.err().map_or("NO_ERROR".into(), |e| e.code)
    }

    #[test]
    fn adds_replaces_and_removes() {
        let added = plan(&input(Operation::Add, "third_decision", Some("my_category"), Some("icon = z"))).unwrap();
        assert_eq!(String::from_utf8(added.bytes.clone()).unwrap(), FILE.replace("\t}\n}\n", "\t}\n\n\tthird_decision = {\n\t\ticon = z\n\t}\n}\n"));
        let removed = plan_decision_write(&added.bytes, "a.txt", &input(Operation::Remove, "third_decision", None, None)).unwrap();
        assert_eq!(removed.bytes, FILE.as_bytes());
        let replaced = plan(&input(Operation::Replace, "second_decision", None, Some("icon = q"))).unwrap();
        assert!(String::from_utf8(replaced.bytes).unwrap().ends_with("\tsecond_decision = {\n\t\ticon = q\n\t}\n}\n"));
        assert_eq!(replaced.untouched_definitions, 1);
    }

    #[test]
    fn creates_a_category_at_the_end_of_the_file_only_when_asked() {
        let mut i = input(Operation::Add, "d_one", Some("other_category"), Some("icon = x"));
        assert_eq!(code(plan(&i)), "DECISION_WRITE_CATEGORY_NOT_FOUND");
        i.create_category = Some(true);
        let result = plan(&i).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), format!("{FILE}\nother_category = {{\n\td_one = {{\n\t\ticon = x\n\t}}\n}}\n"));
        i.operation = Operation::Replace;
        assert_eq!(code(plan(&i)), "DECISION_WRITE_CATEGORY_UNEXPECTED");
    }

    #[test]
    fn refuses_what_it_cannot_place() {
        assert_eq!(code(plan(&input(Operation::Add, "first_decision", Some("my_category"), Some("a = b")))), "DECISION_WRITE_DUPLICATE_ID");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", None, Some("a = b")))), "DECISION_WRITE_CATEGORY_REQUIRED");
        assert_eq!(code(plan(&input(Operation::Replace, "first_decision", Some("zzz"), Some("a = b")))), "DECISION_WRITE_CATEGORY_MISMATCH");
        assert_eq!(code(plan(&input(Operation::Remove, "none_one", None, None))), "DECISION_WRITE_NOT_FOUND");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", Some("bad cat"), Some("a = b")))), "DECISION_WRITE_CATEGORY_INVALID");
        assert_eq!(code(plan_decision_write(b"a = {", "a.txt", &input(Operation::Remove, "x", None, None))), "DECISION_WRITE_SOURCE_INVALID");
    }

    #[test]
    fn makes_a_new_file() {
        let result = plan_new_decision_file("n.txt", &input(Operation::Add, "d_one", Some("cat"), Some("icon = x"))).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), "cat = {\n\td_one = {\n\t\ticon = x\n\t}\n}\n");
        assert_eq!(code(plan_new_decision_file("n.txt", &input(Operation::Add, "d_one", None, Some("icon = x")))), "DECISION_WRITE_CATEGORY_REQUIRED");
    }

    #[test]
    fn lists_categories() {
        assert_eq!(decision_categories(FILE.as_bytes(), "a.txt"), vec!["my_category"]);
    }
}
