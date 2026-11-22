//! The edit behind `hoi4.event_write`: add, replace or remove one event block of an
//! `events/*.txt` file and nothing else.
//!
//! Ported from `src/hoi4_agent_tools/event/write-plan.ts` (`planEventWrite`, `planNewEventFile`,
//! `eventFileContents` and their helpers), commit `ef3d2215`.

use std::collections::BTreeMap;

use hoi4_syntax::{Document, Entry, Value};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::idea::{Operation, remove_edit};
use crate::source::{
    Replacement, Source, WriteResult, apply_replacements, assignments, block_of, diagnostic_codes, fail, indented_body, line_indent, line_start, probe_one_block,
};

pub const EVENT_KINDS: [&str; 5] = ["country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWriteInput {
    pub operation: Operation,
    pub id: String,
    pub kind: Option<String>,
    pub body: Option<String>,
    pub create_namespace: Option<bool>,
    pub namespace_declared: Option<bool>,
}

#[derive(Debug)]
pub struct EventWritePlan {
    pub operation: Operation,
    pub id: String,
    pub kind: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub edits: Vec<Replacement>,
    pub untouched_definitions: usize,
    pub namespace_added: bool,
}

impl EventWritePlan {
    pub fn to_json(&self) -> Json {
        json!({
            "operation": self.operation.name(),
            "id": self.id,
            "kind": self.kind,
            "path": self.path,
            "edits": self.edits.iter().map(Replacement::to_json).collect::<Vec<_>>(),
            "untouchedDefinitions": self.untouched_definitions,
            "namespaceAdded": self.namespace_added,
        })
    }
}

/// `^[A-Za-z_][A-Za-z0-9_]*\.[0-9]+$`.
pub fn event_id_is_valid(id: &str) -> bool {
    let Some((namespace, number)) = id.split_once('.') else { return false };
    let mut chars = namespace.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
}

pub fn namespace_of(id: &str) -> &str {
    &id[..id.find('.').unwrap_or(id.len())]
}

struct Located<'a> {
    event: &'a Entry,
    kind: String,
    id: String,
}

/// Every top-level event block of the document that has an `id`.
fn definitions<'a>(source: &Source, document: &'a Document) -> Vec<Located<'a>> {
    let mut found = Vec::new();
    for event in assignments(source, &document.root, None) {
        let kind = source.key(event);
        if !EVENT_KINDS.contains(&kind.as_str()) {
            continue;
        }
        let Some(block) = block_of(event) else { continue };
        if let Some(id) = assignments(source, block, Some("id")).first()
            && let Value::Scalar(token) = &id.value
        {
            found.push(Located { event, kind, id: document.text(*token).into_owned() });
        }
    }
    found
}

fn namespaces<'a>(source: &Source, document: &'a Document) -> Vec<&'a Entry> {
    assignments(source, &document.root, Some("add_namespace"))
}

fn indent_unit(source: &Source, located: &[Located]) -> String {
    for Located { event, .. } in located {
        let Some(block) = block_of(event) else { continue };
        let Some(first) = block.items.first() else { continue };
        let inner = line_indent(source.bytes(), source.document.byte_range(&first.tokens()).start as usize);
        let outer = line_indent(source.bytes(), source.entry_range(event).start);
        if inner.len() > outer.len() && inner.starts_with(&outer) {
            return inner[outer.len()..].to_string();
        }
    }
    "\t".to_string()
}

/// The body, checked on its own as the block it will become, and its own `id` when it has one.
/// Returns the `id` line to write, none when the body has its own.
fn checked_body(kind: &str, id: &str, body: &str) -> WriteResult<Vec<String>> {
    let probe = match probe_one_block(kind, body) {
        Ok(probe) => probe,
        Err(codes) => {
            return fail(
                "EVENT_WRITE_BODY_INVALID",
                "The body must be the text between the braces of one event: balanced braces and no definition of its own",
                json!({ "diagnosticCodes": codes }),
            );
        }
    };
    let probe_source = Source { document: probe, path: "event-body".into() };
    let Some(Entry { value: Value::Block(block), .. }) = probe_source.document.root.items.first().and_then(|i| i.as_entry()) else {
        return fail("EVENT_WRITE_BODY_INVALID", "The body of an event cannot be empty", json!({}));
    };
    if block.items.is_empty() {
        return fail("EVENT_WRITE_BODY_INVALID", "The body of an event cannot be empty", json!({}));
    }
    let own = assignments(&probe_source, block, Some("id"));
    if own.len() > 1 {
        return fail("EVENT_WRITE_BODY_INVALID", "The body names an id more than once", json!({}));
    }
    if let Some(own) = own.first() {
        let matches = matches!(&own.value, Value::Scalar(token) if probe_source.document.text(*token) == id);
        if !matches {
            return fail(
                "EVENT_WRITE_ID_MISMATCH",
                format!("The body has its own id, which is not {id}; leave id out of the body, the tool writes it"),
                json!({ "id": id }),
            );
        }
    }
    Ok(if own.len() == 1 { Vec::new() } else { vec![format!("id = {id}")] })
}

fn definition_texts(source: &Source, document: &Document, skip: Option<usize>) -> BTreeMap<String, Vec<Vec<u8>>> {
    let mut by_id: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    for Located { event, id, .. } in definitions(source, document) {
        let range = source.entry_range(event);
        if Some(range.start) == skip {
            continue;
        }
        by_id.entry(id).or_default().push(source.bytes()[range].to_vec());
    }
    by_id
}

fn check_request(input: &EventWriteInput) -> WriteResult<()> {
    if !event_id_is_valid(&input.id) {
        return fail(
            "EVENT_WRITE_ID_INVALID",
            format!("{} is not a valid event id; it is a namespace, a dot and a number, as in my_events.1", json!(input.id)),
            json!({ "id": input.id }),
        );
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("EVENT_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove && input.body.as_deref().is_none_or(|b| b.trim().is_empty()) {
        return fail("EVENT_WRITE_BODY_REQUIRED", format!("{} needs the body of the event", input.operation.name()), json!({}));
    }
    if input.operation != Operation::Add && input.create_namespace == Some(true) {
        return fail("EVENT_WRITE_NAMESPACE_UNEXPECTED", "createNamespace applies to add only", json!({}));
    }
    Ok(())
}

/// The event block text at `indent`, with `id` first.
fn block_text(kind: &str, body: &str, id_line: &[String], indent: &str, unit: &str, newline: &str) -> String {
    let inner = format!("{indent}{unit}");
    let mut lines: Vec<String> = id_line.iter().map(|line| format!("{inner}{line}")).collect();
    lines.push(indented_body(body, &inner, newline));
    format!("{indent}{kind} = {{{newline}{}{newline}{indent}}}", lines.join(newline))
}

fn kind_of(input: &EventWriteInput) -> String {
    input.kind.clone().unwrap_or_else(|| "country_event".into())
}

fn namespace_missing(id: &str) -> WriteResult<()> {
    fail(
        "EVENT_WRITE_NAMESPACE_MISSING",
        format!("No mod file declares the namespace {}; pass createNamespace: true to write add_namespace", namespace_of(id)),
        json!({ "namespace": namespace_of(id) }),
    )
}

/// `planNewEventFile`: a new `events` file holding the namespace line and one new event.
pub fn plan_new_event_file(path: &str, input: &EventWriteInput) -> WriteResult<EventWritePlan> {
    check_request(input)?;
    if input.operation != Operation::Add {
        return fail("EVENT_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let kind = kind_of(input);
    let body = input.body.as_deref().unwrap_or_default();
    let id_line = checked_body(&kind, &input.id, body)?;
    let namespace_added = input.namespace_declared != Some(true);
    if namespace_added && input.create_namespace != Some(true) {
        namespace_missing(&input.id)?;
    }
    let mut parts: Vec<String> = Vec::new();
    if namespace_added {
        parts.push(format!("add_namespace = {}", namespace_of(&input.id)));
        parts.push(String::new());
    }
    parts.push(block_text(&kind, body, &id_line, "", "\t", "\n"));
    parts.push(String::new());
    let text = parts.join("\n");
    let written = Source::parse(text.as_bytes(), path);
    if written.has_blocking() {
        return fail("EVENT_WRITE_RESULT_INVALID", "The new file would have syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
    }
    Ok(EventWritePlan {
        operation: Operation::Add,
        id: input.id.clone(),
        kind,
        path: path.to_string(),
        bytes: text.clone().into_bytes(),
        edits: vec![Replacement { start: 0, end: 0, text, description: format!("create {path} with {}", input.id) }],
        untouched_definitions: 0,
        namespace_added,
    })
}

/// `planEventWrite`: the edit of one event of an existing file.
pub fn plan_event_write(bytes: &[u8], path: &str, input: &EventWriteInput) -> WriteResult<EventWritePlan> {
    check_request(input)?;
    let source = Source::parse(bytes, path);
    if source.has_blocking() {
        return fail(
            "EVENT_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": diagnostic_codes(&source) }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    let located = definitions(&source, &source.document);
    let unit = indent_unit(&source, &located);
    let existing: Vec<&Located> = located.iter().filter(|l| l.id == input.id).collect();
    let body = input.body.as_deref().unwrap_or_default();
    let mut edits: Vec<Replacement> = Vec::new();
    let mut skip = None;
    let kind;
    let mut namespace_added = false;

    if input.operation == Operation::Add {
        kind = kind_of(input);
        if let Some(first) = existing.first() {
            return fail("EVENT_WRITE_DUPLICATE_ID", format!("{} is already defined in this file", input.id), json!({ "id": input.id, "line": source.line_of_key(first.event) }));
        }
        let id_line = checked_body(&kind, &input.id, body)?;
        let wanted = namespace_of(&input.id);
        let declared_here = namespaces(&source, &source.document).iter().any(|e| matches!(&e.value, Value::Scalar(token) if source.document.text(*token) == wanted));
        if !declared_here && input.namespace_declared != Some(true) {
            if input.create_namespace != Some(true) {
                namespace_missing(&input.id)?;
            }
            namespace_added = true;
            let lines = namespaces(&source, &source.document);
            let description = format!("declare the namespace {wanted}");
            if let Some(last) = lines.last() {
                let end = source.entry_range(last).end;
                let line_end_at = text[end..].iter().position(|&b| b == b'\n').map(|at| end + at);
                let at = line_end_at.map_or(text.len(), |at| at + 1);
                edits.push(Replacement { start: at, end: at, text: format!("{}add_namespace = {wanted}{newline}", if line_end_at.is_none() { newline } else { "" }), description });
            } else if let Some(first) = source.document.root.items.first() {
                let at = line_start(text, source.document.byte_range(&first.tokens()).start as usize);
                edits.push(Replacement { start: at, end: at, text: format!("add_namespace = {wanted}{newline}{newline}"), description });
            }
        }
        let block = block_text(&kind, body, &id_line, "", &unit, newline);
        let lead = if text.is_empty() { String::new() } else { format!("{}{newline}", if text.ends_with(b"\n") { "" } else { newline }) };
        edits.push(Replacement { start: text.len(), end: text.len(), text: format!("{lead}{block}{newline}"), description: format!("add {}", input.id) });
        if namespace_added && source.document.root.items.is_empty() {
            edits = vec![Replacement {
                start: text.len(),
                end: text.len(),
                text: format!("{}add_namespace = {wanted}{newline}{newline}{block}{newline}", if text.is_empty() { "" } else { newline }),
                description: format!("add {} and declare its namespace", input.id),
            }];
        }
    } else {
        if existing.is_empty() {
            return fail("EVENT_WRITE_NOT_FOUND", format!("{} is not defined in this file", input.id), json!({ "id": input.id }));
        }
        if existing.len() > 1 {
            return fail(
                "EVENT_WRITE_DUPLICATE_ID",
                format!("{} is defined {} times in this file", input.id, existing.len()),
                json!({ "id": input.id, "lines": existing.iter().map(|l| source.line_of_key(l.event)).collect::<Vec<_>>() }),
            );
        }
        let found = existing[0];
        kind = found.kind.clone();
        if input.kind.as_deref().is_some_and(|k| k != kind) {
            return fail(
                "EVENT_WRITE_KIND_MISMATCH",
                format!("{} is a {kind}, and changing the kind of an event is not supported", input.id),
                json!({ "id": input.id, "kind": kind }),
            );
        }
        let range = source.entry_range(found.event);
        skip = Some(range.start);
        if input.operation == Operation::Replace {
            let id_line = checked_body(&kind, &input.id, body)?;
            let indent = line_indent(text, range.start);
            let full = block_text(&kind, body, &id_line, &indent, &unit, newline);
            edits.push(Replacement { start: range.start, end: range.end, text: full[indent.len()..].to_string(), description: format!("replace {}", input.id) });
        } else {
            edits.push(remove_edit(&source, &input.id, range.start, range.end, true));
        }
    }

    let new_bytes = apply_replacements(&source, &edits)?;
    let written = Source::parse(&new_bytes, path);
    if written.has_blocking() {
        return fail("EVENT_WRITE_RESULT_INVALID", "The edit would leave the file with syntax errors", json!({ "diagnosticCodes": diagnostic_codes(&written) }));
    }
    let before = definition_texts(&source, &source.document, skip);
    let after = definition_texts(&written, &written.document, None);
    let mut untouched = 0;
    for (id, texts) in &before {
        let now = after.get(id).map(Vec::as_slice).unwrap_or_default();
        for definition in texts {
            if now.contains(definition) {
                untouched += 1;
            } else {
                return fail("EVENT_WRITE_RESULT_INVALID", format!("The edit would change {id}, which it must not touch"), json!({ "id": id }));
            }
        }
    }
    Ok(EventWritePlan { operation: input.operation, id: input.id.clone(), kind, path: path.to_string(), bytes: new_bytes, edits, untouched_definitions: untouched, namespace_added })
}

/// The ids of the events in a source, and the namespaces it declares.
pub fn event_file_contents(bytes: &[u8], path: &str) -> (Vec<String>, Vec<String>) {
    let source = Source::parse(bytes, path);
    if source.has_blocking() {
        return (Vec::new(), Vec::new());
    }
    let ids = definitions(&source, &source.document).into_iter().map(|l| l.id).collect();
    let spaces = namespaces(&source, &source.document)
        .into_iter()
        .filter_map(|e| match &e.value {
            Value::Scalar(token) => Some(source.document.text(*token).into_owned()),
            _ => None,
        })
        .collect();
    (ids, spaces)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "add_namespace = my_events\n\ncountry_event = {\n\tid = my_events.1\n\ttitle = x\n}\n\ncountry_event = {\n\tid = my_events.2\n\ttitle = y\n}\n";

    fn input(operation: Operation, id: &str, body: Option<&str>) -> EventWriteInput {
        EventWriteInput { operation, id: id.into(), kind: None, body: body.map(Into::into), create_namespace: None, namespace_declared: None }
    }

    fn plan(i: &EventWriteInput) -> WriteResult<EventWritePlan> {
        plan_event_write(FILE.as_bytes(), "events/t.txt", i)
    }

    fn code(r: WriteResult<EventWritePlan>) -> String {
        r.err().map_or("NO_ERROR".into(), |e| e.code)
    }

    #[test]
    fn adds_replaces_and_removes_an_event() {
        let added = plan(&input(Operation::Add, "my_events.3", Some("title = z"))).unwrap();
        assert_eq!(String::from_utf8(added.bytes.clone()).unwrap(), format!("{FILE}\ncountry_event = {{\n\tid = my_events.3\n\ttitle = z\n}}\n"));
        let removed = plan_event_write(&added.bytes, "a.txt", &input(Operation::Remove, "my_events.3", None)).unwrap();
        assert_eq!(removed.bytes, FILE.as_bytes());
        let replaced = plan(&input(Operation::Replace, "my_events.1", Some("title = q"))).unwrap();
        assert!(String::from_utf8(replaced.bytes).unwrap().contains("country_event = {\n\tid = my_events.1\n\ttitle = q\n}\n\ncountry_event"));
        assert_eq!(replaced.untouched_definitions, 1);
    }

    #[test]
    fn declares_a_namespace_only_when_asked() {
        let mut i = input(Operation::Add, "other.1", Some("title = z"));
        assert_eq!(code(plan(&i)), "EVENT_WRITE_NAMESPACE_MISSING");
        i.create_namespace = Some(true);
        let result = plan(&i).unwrap();
        assert!(result.namespace_added);
        assert!(String::from_utf8(result.bytes).unwrap().starts_with("add_namespace = my_events\nadd_namespace = other\n\ncountry_event"));
        i.namespace_declared = Some(true);
        assert!(!plan(&i).unwrap().namespace_added);
    }

    #[test]
    fn refuses_what_it_cannot_place() {
        assert_eq!(code(plan(&input(Operation::Add, "my_events.1", Some("a = b")))), "EVENT_WRITE_DUPLICATE_ID");
        assert_eq!(code(plan(&input(Operation::Add, "bad", Some("a = b")))), "EVENT_WRITE_ID_INVALID");
        assert_eq!(code(plan(&input(Operation::Add, "my_events.3", Some("id = my_events.9\na = b")))), "EVENT_WRITE_ID_MISMATCH");
        assert_eq!(code(plan(&input(Operation::Add, "my_events.3", Some("id = my_events.3\nid = my_events.3")))), "EVENT_WRITE_BODY_INVALID");
        assert_eq!(code(plan(&input(Operation::Remove, "my_events.8", None))), "EVENT_WRITE_NOT_FOUND");
        let mut kind = input(Operation::Replace, "my_events.1", Some("a = b"));
        kind.kind = Some("news_event".into());
        assert_eq!(code(plan(&kind)), "EVENT_WRITE_KIND_MISMATCH");
        let mut stray = input(Operation::Remove, "my_events.1", None);
        stray.create_namespace = Some(true);
        assert_eq!(code(plan(&stray)), "EVENT_WRITE_NAMESPACE_UNEXPECTED");
    }

    #[test]
    fn makes_a_new_file_with_its_namespace() {
        let mut i = input(Operation::Add, "ns.1", Some("title = x"));
        assert_eq!(code(plan_new_event_file("n.txt", &i)), "EVENT_WRITE_NAMESPACE_MISSING");
        i.create_namespace = Some(true);
        let result = plan_new_event_file("n.txt", &i).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), "add_namespace = ns\n\ncountry_event = {\n\tid = ns.1\n\ttitle = x\n}\n");
    }

    #[test]
    fn lists_ids_and_namespaces() {
        let (ids, spaces) = event_file_contents(FILE.as_bytes(), "a.txt");
        assert_eq!(ids, vec!["my_events.1", "my_events.2"]);
        assert_eq!(spaces, vec!["my_events"]);
    }
}
