//! The edit behind `hoi4.tech_write`: add, replace or remove one technology of a
//! `common/technologies/*.txt` file and nothing else.
//!
//! Ported from `src/hoi4_agent_tools/technology/write-plan.ts` (`planTechWrite`,
//! `planTechWrite` and their helpers), commit `ef3d2215`.

use std::collections::BTreeMap;

use hoi4_syntax::Entry;
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::idea::{Operation, assert_body_is_one_block, id_is_valid, remove_edit};
use crate::source::{Replacement, Source, WriteResult, apply_replacements, assignments, blank, block_of, diagnostic_codes, fail, indented_body, line_indent, line_start};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechWriteInput {
    pub operation: Operation,
    pub id: String,
    pub body: Option<String>,
}

#[derive(Debug)]
pub struct TechWritePlan {
    pub operation: Operation,
    pub id: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub edit: Replacement,
    pub untouched_definitions: usize,
}

impl TechWritePlan {
    pub fn to_json(&self) -> Json {
        json!({
            "operation": self.operation.name(),
            "id": self.id,
            "path": self.path,
            "edit": self.edit.to_json(),
            "untouchedDefinitions": self.untouched_definitions,
        })
    }
}

/// Every `technologies = { <id> = { ... } }` definition of the document.
fn definitions<'a>(source: &Source, document: &'a hoi4_syntax::Document) -> Vec<&'a Entry> {
    assignments(source, &document.root, Some("technologies"))
        .into_iter()
        .flat_map(|technologies| block_of(technologies).map(|block| assignments(source, block, None).into_iter().filter(|e| block_of(e).is_some()).collect::<Vec<_>>()).unwrap_or_default())
        .collect()
}

/// One level of indentation, read from the file's own technologies, tabs when it has none.
fn indent_unit(source: &Source) -> String {
    for technologies in assignments(source, &source.document.root, Some("technologies")) {
        let Some(block) = block_of(technologies) else { continue };
        let outer = line_indent(source.bytes(), source.entry_range(technologies).start);
        for technology in assignments(source, block, None) {
            let inner = line_indent(source.bytes(), source.entry_range(technology).start);
            if inner.len() > outer.len() && inner.starts_with(&outer) {
                return inner[outer.len()..].to_string();
            }
        }
    }
    "\t".to_string()
}

fn definition_texts(source: &Source, document: &hoi4_syntax::Document, skip: Option<usize>) -> BTreeMap<String, Vec<Vec<u8>>> {
    let mut by_key: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    for technology in definitions(source, document) {
        let range = source.entry_range(technology);
        if Some(range.start) == skip {
            continue;
        }
        by_key.entry(source.key(technology)).or_default().push(source.bytes()[range].to_vec());
    }
    by_key
}

fn check_request(input: &TechWriteInput) -> WriteResult<()> {
    if !id_is_valid(&input.id) {
        return fail("TECH_WRITE_ID_INVALID", format!("{} is not a valid tech id", json!(input.id)), json!({ "id": input.id }));
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("TECH_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove && input.body.as_deref().is_none_or(|b| b.trim().is_empty()) {
        return fail("TECH_WRITE_BODY_REQUIRED", format!("{} needs the body of the tech", input.operation.name()), json!({}));
    }
    Ok(())
}

/// `planTechWrite`: a new `common/technologies` file holding one new technology.
pub fn plan_new_technology_file(path: &str, input: &TechWriteInput) -> WriteResult<TechWritePlan> {
    check_request(input)?;
    if input.operation != Operation::Add {
        return fail("TECH_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let body = input.body.as_deref().unwrap_or_default();
    assert_body_is_one_block(&input.id, body, "TECH_WRITE_BODY_INVALID", "technology")?;
    let text = ["technologies = {".to_string(), format!("\t{} = {{", input.id), indented_body(body, "\t\t", "\n"), "\t}".to_string(), "}".to_string(), String::new()].join("\n");
    let written = Source::parse(text.as_bytes(), path);
    if written.has_blocking() {
        return fail("TECH_WRITE_RESULT_INVALID", "The new file would have syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
    }
    Ok(TechWritePlan {
        operation: Operation::Add,
        id: input.id.clone(),
        path: path.to_string(),
        bytes: text.clone().into_bytes(),
        edit: Replacement { start: 0, end: 0, text, description: format!("create {path} with {}", input.id) },
        untouched_definitions: 0,
    })
}

/// `planTechWrite`: the edit of one technology of an existing file.
pub fn plan_technology_write(bytes: &[u8], path: &str, input: &TechWriteInput) -> WriteResult<TechWritePlan> {
    check_request(input)?;
    let source = Source::parse(bytes, path);
    if source.has_blocking() {
        return fail(
            "TECH_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": diagnostic_codes(&source) }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    if let Some(body) = input.body.as_deref() {
        assert_body_is_one_block(&input.id, body, "TECH_WRITE_BODY_INVALID", "technology")?;
    }
    let unit = indent_unit(&source);
    let all = definitions(&source, &source.document);
    let existing: Vec<&&Entry> = all.iter().filter(|e| source.key(e) == input.id).collect();
    let body = input.body.as_deref().unwrap_or_default();

    let edit;
    let mut skip = None;
    if input.operation == Operation::Add {
        if let Some(first) = existing.first() {
            return fail("TECH_WRITE_DUPLICATE_ID", format!("{} is already defined in this file", input.id), json!({ "id": input.id, "line": source.line_of_key(first) }));
        }
        let blocks: Vec<&Entry> = assignments(&source, &source.document.root, Some("technologies")).into_iter().filter(|e| block_of(e).is_some()).collect();
        if blocks.len() != 1 {
            return fail(
                "TECH_WRITE_LAYOUT_UNSUPPORTED",
                if blocks.is_empty() {
                    "The file has no technologies block to put the new technology in".to_string()
                } else {
                    format!("The file has {} technologies blocks, so the new technology has no single place", blocks.len())
                },
                json!({ "blocks": blocks.len() }),
            );
        }
        let technologies = blocks[0];
        let block = block_of(technologies).expect("filtered to blocks");
        let Some(close) = source.close_range(block) else {
            return fail("TECH_WRITE_LAYOUT_UNSUPPORTED", "The technologies block has no closing brace", json!({}));
        };
        let close_line_start = line_start(text, close.start);
        if !blank(&text[close_line_start..close.start]) {
            return fail(
                "TECH_WRITE_LAYOUT_UNSUPPORTED",
                "The closing brace of the technologies block shares its line with other text, so the new technology has no line to go on",
                json!({ "line": source.line_of(close.start) }),
            );
        }
        let technology_indent = format!("{}{unit}", line_indent(text, source.entry_range(technologies).start));
        let technology_text = format!("{technology_indent}{} = {{{newline}{}{newline}{technology_indent}}}{newline}", input.id, indented_body(body, &format!("{technology_indent}{unit}"), newline));
        edit = Replacement {
            start: close_line_start,
            end: close_line_start,
            text: format!("{}{technology_text}", if block.items.is_empty() { "" } else { newline }),
            description: format!("add {}", input.id),
        };
    } else {
        if existing.is_empty() {
            return fail("TECH_WRITE_NOT_FOUND", format!("{} is not defined in this file", input.id), json!({ "id": input.id }));
        }
        if existing.len() > 1 {
            return fail(
                "TECH_WRITE_DUPLICATE_ID",
                format!("{} is defined {} times in this file", input.id, existing.len()),
                json!({ "id": input.id, "lines": existing.iter().map(|e| source.line_of_key(e)).collect::<Vec<_>>() }),
            );
        }
        let range = source.entry_range(existing[0]);
        skip = Some(range.start);
        let technology_indent = line_indent(text, range.start);
        edit = if input.operation == Operation::Replace {
            Replacement {
                start: range.start,
                end: range.end,
                text: format!("{} = {{{newline}{}{newline}{technology_indent}}}", input.id, indented_body(body, &format!("{technology_indent}{unit}"), newline)),
                description: format!("replace {}", input.id),
            }
        } else {
            remove_edit(&source, &input.id, range.start, range.end, false)
        };
    }

    let new_bytes = apply_replacements(&source, std::slice::from_ref(&edit))?;
    let written = Source::parse(&new_bytes, path);
    if written.has_blocking() {
        return fail("TECH_WRITE_RESULT_INVALID", "The edit would leave the file with syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
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
                return fail("TECH_WRITE_RESULT_INVALID", format!("The edit would change {key}, which it must not touch"), json!({ "key": key }));
            }
        }
    }
    Ok(TechWritePlan { operation: input.operation, id: input.id.clone(), path: path.to_string(), bytes: new_bytes, edit, untouched_definitions: untouched })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "technologies = {\n\t# first\n\ttech_alpha = {\n\t\tname = tech_alpha\n\t}\n\n\ttech_beta = {\n\t\tname = tech_beta\n\t}\n}\n";

    fn input(operation: Operation, id: &str, body: Option<&str>) -> TechWriteInput {
        TechWriteInput { operation, id: id.into(), body: body.map(Into::into) }
    }

    fn plan(i: &TechWriteInput) -> WriteResult<TechWritePlan> {
        plan_technology_write(FILE.as_bytes(), "common/technologies/t.txt", i)
    }

    fn code(r: WriteResult<TechWritePlan>) -> String {
        r.err().map_or("NO_ERROR".into(), |e| e.code)
    }

    #[test]
    fn adds_replaces_and_removes_without_touching_the_rest() {
        let added = plan(&input(Operation::Add, "tech_gamma", Some("name = tech_gamma"))).unwrap();
        assert_eq!(String::from_utf8(added.bytes.clone()).unwrap(), FILE.replace("\t}\n}\n", "\t}\n\n\ttech_gamma = {\n\t\tname = tech_gamma\n\t}\n}\n"));
        assert_eq!(added.untouched_definitions, 2);
        let replaced = plan(&input(Operation::Replace, "tech_alpha", Some("name = other"))).unwrap();
        assert!(String::from_utf8(replaced.bytes).unwrap().starts_with("technologies = {\n\t# first\n\ttech_alpha = {\n\t\tname = other\n\t}\n"));
        let removed = plan_technology_write(&added.bytes, "a.txt", &input(Operation::Remove, "tech_gamma", None)).unwrap();
        assert_eq!(removed.bytes, FILE.as_bytes());
    }

    #[test]
    fn refuses_what_it_cannot_place() {
        assert_eq!(code(plan(&input(Operation::Add, "tech_alpha", Some("a = b")))), "TECH_WRITE_DUPLICATE_ID");
        assert_eq!(code(plan(&input(Operation::Replace, "tech_none", Some("a = b")))), "TECH_WRITE_NOT_FOUND");
        assert_eq!(code(plan(&input(Operation::Add, "bad id", Some("a = b")))), "TECH_WRITE_ID_INVALID");
        assert_eq!(code(plan(&input(Operation::Add, "tech_x", Some("a = {")))), "TECH_WRITE_BODY_INVALID");
        assert_eq!(code(plan(&input(Operation::Remove, "tech_alpha", Some("a = b")))), "TECH_WRITE_BODY_UNEXPECTED");
        assert_eq!(code(plan_technology_write(b"technologies = {} technologies = {}", "a.txt", &input(Operation::Add, "tech_x", Some("a = b")))), "TECH_WRITE_LAYOUT_UNSUPPORTED");
        assert_eq!(code(plan_technology_write(b"technologies = {", "a.txt", &input(Operation::Add, "tech_x", Some("a = b")))), "TECH_WRITE_SOURCE_INVALID");
    }

    #[test]
    fn makes_a_new_file() {
        let result = plan_new_technology_file("n.txt", &input(Operation::Add, "tech_new", Some("name = x"))).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), "technologies = {\n\ttech_new = {\n\t\tname = x\n\t}\n}\n");
        assert_eq!(code(plan_new_technology_file("n.txt", &input(Operation::Replace, "tech_new", Some("a = b")))), "TECH_WRITE_FILE_NOT_FOUND");
    }
}
