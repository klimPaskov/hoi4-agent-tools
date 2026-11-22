//! The edit behind `hoi4.doctrine_write`: add, replace or remove one grand doctrine, track or
//! subdoctrine of a `common/doctrines/**` file and nothing else. These files are flat: each
//! top-level block is one definition, keyed by its name.
//!
//! Ported from `src/hoi4_agent_tools/doctrine/write-plan.ts` (`planDoctrineWrite`,
//! `planNewDoctrineFile` and their helpers), commit `ef3d2215`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::idea::{Operation, assert_body_is_one_block, id_is_valid, remove_edit};
use crate::source::{Block, Decoded, Entry, Replacement, Source, WriteResult, apply_replacements, assignments, block_of, fail, indented_body, key_of, line_indent};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctrineWriteInput {
    pub operation: Operation,
    pub id: String,
    pub body: Option<String>,
}

#[derive(Debug)]
pub struct DoctrineWritePlan {
    pub operation: Operation,
    pub id: String,
    pub path: String,
    pub text: String,
    pub bytes: Vec<u8>,
    pub edit: Replacement,
    pub untouched_definitions: usize,
}

impl DoctrineWritePlan {
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

/// Every top-level block of the document: one doctrine definition each.
fn definitions<'b, 't>(root: &'b Block<'t>) -> Vec<&'b Entry<'t>> {
    assignments(root, None).into_iter().filter(|e| block_of(e).is_some()).collect()
}

/// One level of indentation, read from the file's own doctrines, tabs when it has none.
fn indent_unit(source: &Source<'_>, located: &[&Entry<'_>]) -> String {
    for doctrine in located {
        let Some(block) = block_of(doctrine) else { continue };
        let Some(first) = block.entries.first() else { continue };
        let inner = line_indent(source.bytes(), Source::item_start(first));
        let outer = line_indent(source.bytes(), source.entry_range(doctrine).start);
        if inner.len() > outer.len() && inner.starts_with(&outer) {
            return inner[outer.len()..].to_string();
        }
    }
    "\t".to_string()
}

fn definition_texts(source: &Source<'_>, skip: Option<usize>) -> BTreeMap<String, Vec<String>> {
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for doctrine in definitions(&source.document.root) {
        let range = source.entry_range(doctrine);
        if Some(range.start) == skip {
            continue;
        }
        by_key.entry(key_of(doctrine)).or_default().push(source.text()[range].to_string());
    }
    by_key
}

fn check_request(input: &DoctrineWriteInput) -> WriteResult<()> {
    if !id_is_valid(&input.id) {
        return fail("DOCTRINE_WRITE_ID_INVALID", format!("{} is not a valid doctrine id", json!(input.id)), json!({ "id": input.id }));
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("DOCTRINE_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove && input.body.as_deref().is_none_or(|b| b.trim().is_empty()) {
        return fail("DOCTRINE_WRITE_BODY_REQUIRED", format!("{} needs the body of the doctrine", input.operation.name()), json!({}));
    }
    Ok(())
}

/// `planNewDoctrineFile`: a new doctrine file holding one new doctrine.
pub fn plan_new_doctrine_file(path: &str, input: &DoctrineWriteInput) -> WriteResult<DoctrineWritePlan> {
    check_request(input)?;
    if input.operation != Operation::Add {
        return fail("DOCTRINE_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let body = input.body.as_deref().unwrap_or_default();
    assert_body_is_one_block(&input.id, body, "DOCTRINE_WRITE_BODY_INVALID", "doctrine")?;
    let text = [format!("{} = {{", input.id), indented_body(body, "\t", "\n"), "}".to_string(), String::new()].join("\n");
    let decoded = Decoded::new(text.as_bytes());
    let written = Source::new(&decoded, path);
    if written.has_blocking() {
        return fail("DOCTRINE_WRITE_RESULT_INVALID", "The new file would have syntax errors", json!({ "diagnosticCodes": written.diagnostic_codes() }));
    }
    Ok(DoctrineWritePlan {
        operation: Operation::Add,
        id: input.id.clone(),
        path: path.to_string(),
        bytes: text.clone().into_bytes(),
        edit: Replacement { start: 0, end: 0, text: text.clone(), description: format!("create {path} with {}", input.id) },
        text,
        untouched_definitions: 0,
    })
}

/// `planDoctrineWrite`: the edit of one doctrine of an existing file.
pub fn plan_doctrine_write(bytes: &[u8], path: &str, input: &DoctrineWriteInput) -> WriteResult<DoctrineWritePlan> {
    check_request(input)?;
    let decoded = Decoded::new(bytes);
    let source = Source::new(&decoded, path);
    if source.has_blocking() {
        return fail(
            "DOCTRINE_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": source.diagnostic_codes() }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    if let Some(body) = input.body.as_deref() {
        assert_body_is_one_block(&input.id, body, "DOCTRINE_WRITE_BODY_INVALID", "doctrine")?;
    }
    let all = definitions(&source.document.root);
    let unit = indent_unit(&source, &all);
    let existing: Vec<&&Entry> = all.iter().filter(|e| e.key.value == input.id).collect();
    let body = input.body.as_deref().unwrap_or_default();

    let edit;
    let mut skip = None;
    if input.operation == Operation::Add {
        if let Some(first) = existing.first() {
            return fail("DOCTRINE_WRITE_DUPLICATE_ID", format!("{} is already defined in this file", input.id), json!({ "id": input.id, "line": first.key.line }));
        }
        let lead = if text.is_empty() { String::new() } else { format!("{}{newline}", if text.ends_with(b"\n") { "" } else { newline }) };
        edit = Replacement {
            start: text.len(),
            end: text.len(),
            text: format!("{lead}{} = {{{newline}{}{newline}}}{newline}", input.id, indented_body(body, &unit, newline)),
            description: format!("add {}", input.id),
        };
    } else {
        if existing.is_empty() {
            return fail("DOCTRINE_WRITE_NOT_FOUND", format!("{} is not defined in this file", input.id), json!({ "id": input.id }));
        }
        if existing.len() > 1 {
            return fail(
                "DOCTRINE_WRITE_DUPLICATE_ID",
                format!("{} is defined {} times in this file", input.id, existing.len()),
                json!({ "id": input.id, "lines": existing.iter().map(|e| e.key.line).collect::<Vec<_>>() }),
            );
        }
        let range = source.entry_range(existing[0]);
        skip = Some(range.start);
        let indent = line_indent(text, range.start);
        edit = if input.operation == Operation::Replace {
            Replacement {
                start: range.start,
                end: range.end,
                text: format!("{} = {{{newline}{}{newline}{indent}}}", input.id, indented_body(body, &format!("{indent}{unit}"), newline)),
                description: format!("replace {}", input.id),
            }
        } else {
            remove_edit(&source, &input.id, range.start, range.end, true)
        };
    }

    let (after_text, new_bytes) = apply_replacements(&source, std::slice::from_ref(&edit))?;
    let written_decoded = Decoded::new(&new_bytes);
    let written = Source::new(&written_decoded, path);
    if written.has_blocking() {
        return fail("DOCTRINE_WRITE_RESULT_INVALID", "The edit would leave the file with syntax errors", json!({ "diagnosticCodes": written.diagnostic_codes() }));
    }
    let before = definition_texts(&source, skip);
    let after = definition_texts(&written, None);
    let mut untouched = 0;
    for (key, texts) in &before {
        let now = after.get(key).map(Vec::as_slice).unwrap_or_default();
        for definition in texts {
            if now.contains(definition) {
                untouched += 1;
            } else {
                return fail("DOCTRINE_WRITE_RESULT_INVALID", format!("The edit would change {key}, which it must not touch"), json!({ "key": key }));
            }
        }
    }
    if written.text() != after_text {
        return fail("DOCTRINE_WRITE_RESULT_INVALID", "The written file does not match the planned edit", json!({}));
    }
    Ok(DoctrineWritePlan { operation: input.operation, id: input.id.clone(), path: path.to_string(), text: after_text, bytes: new_bytes, edit, untouched_definitions: untouched })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "# doctrines\nalpha_doctrine = {\n\tname = a\n}\n\nbeta_doctrine = {\n\tname = b\n}\n";

    fn input(operation: Operation, id: &str, body: Option<&str>) -> DoctrineWriteInput {
        DoctrineWriteInput { operation, id: id.into(), body: body.map(Into::into) }
    }

    fn plan(i: &DoctrineWriteInput) -> WriteResult<DoctrineWritePlan> {
        plan_doctrine_write(FILE.as_bytes(), "common/doctrines/t.txt", i)
    }

    fn code(r: WriteResult<DoctrineWritePlan>) -> String {
        r.err().map_or("NO_ERROR".into(), |e| e.code)
    }

    #[test]
    fn adds_at_the_end_replaces_and_removes() {
        let added = plan(&input(Operation::Add, "gamma_doctrine", Some("name = c"))).unwrap();
        assert_eq!(String::from_utf8(added.bytes.clone()).unwrap(), format!("{FILE}\ngamma_doctrine = {{\n\tname = c\n}}\n"));
        let removed = plan_doctrine_write(&added.bytes, "a.txt", &input(Operation::Remove, "gamma_doctrine", None)).unwrap();
        assert_eq!(removed.bytes, FILE.as_bytes());
        let replaced = plan(&input(Operation::Replace, "alpha_doctrine", Some("name = z"))).unwrap();
        assert!(String::from_utf8(replaced.bytes).unwrap().starts_with("# doctrines\nalpha_doctrine = {\n\tname = z\n}\n\nbeta"));
        assert_eq!(replaced.untouched_definitions, 1);
    }

    #[test]
    fn refuses_what_it_cannot_place() {
        assert_eq!(code(plan(&input(Operation::Add, "alpha_doctrine", Some("a = b")))), "DOCTRINE_WRITE_DUPLICATE_ID");
        assert_eq!(code(plan(&input(Operation::Remove, "none_doctrine", None))), "DOCTRINE_WRITE_NOT_FOUND");
        assert_eq!(code(plan(&input(Operation::Add, "bad id", Some("a = b")))), "DOCTRINE_WRITE_ID_INVALID");
        assert_eq!(code(plan(&input(Operation::Add, "x_doctrine", Some("a = }")))), "DOCTRINE_WRITE_BODY_INVALID");
        assert_eq!(code(plan(&input(Operation::Replace, "alpha_doctrine", None))), "DOCTRINE_WRITE_BODY_REQUIRED");
        assert_eq!(code(plan_doctrine_write(b"a = {", "a.txt", &input(Operation::Remove, "a", None))), "DOCTRINE_WRITE_SOURCE_INVALID");
    }

    #[test]
    fn makes_a_new_flat_file() {
        let result = plan_new_doctrine_file("n.txt", &input(Operation::Add, "new_doctrine", Some("name = x"))).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), "new_doctrine = {\n\tname = x\n}\n");
        assert_eq!(code(plan_new_doctrine_file("n.txt", &input(Operation::Remove, "new_doctrine", None))), "DOCTRINE_WRITE_FILE_NOT_FOUND");
    }
}
