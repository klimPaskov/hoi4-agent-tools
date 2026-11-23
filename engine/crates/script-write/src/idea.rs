//! The edit behind `hoi4.idea_write`: add, replace or remove one idea definition of a
//! `common/ideas/*.txt` file and nothing else.
//!
//! Ported from `src/hoi4_agent_tools/ideas/write-plan.ts` (`planIdeaWrite`, `planNewIdeaFile`,
//! `ideaCategories` and their helpers), commit `ef3d2215`. Every byte outside the touched block, its
//! comments, its neighbours, the newline style and the encoding come back as they were read, and a
//! layout the edit cannot place safely is refused with the reason.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::source::{
    Block, Decoded, Entry, Replacement, Source, WriteResult, apply_replacements, assignments, blank, block_of, fail, indented_body, key_of, line_indent,
    line_start, probe_one_block,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Add,
    Replace,
    Remove,
}

impl Operation {
    pub fn name(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Replace => "replace",
            Self::Remove => "remove",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaWriteInput {
    pub operation: Operation,
    pub id: String,
    pub category: Option<String>,
    pub create_category: Option<bool>,
    pub body: Option<String>,
}

/// The plan of one idea edit. The file after the edit is `bytes`, its decoded text `text`.
#[derive(Debug)]
pub struct IdeaWritePlan {
    pub operation: Operation,
    pub id: String,
    pub category: String,
    pub path: String,
    pub text: String,
    pub bytes: Vec<u8>,
    pub edit: Replacement,
    pub untouched_definitions: usize,
}

impl IdeaWritePlan {
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

/// `^[A-Za-z_][A-Za-z0-9_.-]*$`.
pub fn id_is_valid(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

struct Located<'b, 't> {
    idea: &'b Entry<'t>,
    category: &'b Entry<'t>,
}

/// Every `ideas = { <category> = { <id> = { ... } } }` definition of the document.
fn definitions<'b, 't>(root: &'b Block<'t>) -> Vec<Located<'b, 't>> {
    let mut found = Vec::new();
    for ideas in assignments(root, Some("ideas")) {
        let Some(ideas_block) = block_of(ideas) else { continue };
        for category in assignments(ideas_block, None) {
            let Some(category_block) = block_of(category) else { continue };
            for idea in assignments(category_block, None) {
                if block_of(idea).is_some() {
                    found.push(Located { idea, category });
                }
            }
        }
    }
    found
}

fn category_blocks<'b, 't>(root: &'b Block<'t>) -> Vec<&'b Entry<'t>> {
    assignments(root, Some("ideas"))
        .into_iter()
        .flat_map(|ideas| {
            block_of(ideas).map(|block| assignments(block, None).into_iter().filter(|e| block_of(e).is_some()).collect::<Vec<_>>()).unwrap_or_default()
        })
        .collect()
}

/// One level of indentation, read from the file's own ideas, tabs when it has none.
fn indent_unit(source: &Source<'_>, located: &[Located<'_, '_>]) -> String {
    for Located { idea, category } in located {
        let outer = line_indent(source.bytes(), source.entry_range(category).start);
        let inner = line_indent(source.bytes(), source.entry_range(idea).start);
        if inner.len() > outer.len() && inner.starts_with(&outer) {
            return inner[outer.len()..].to_string();
        }
    }
    "\t".to_string()
}

/// The body, checked on its own as the block it will become.
pub fn assert_body_is_one_block(id: &str, body: &str, code: &str, what: &str) -> WriteResult<()> {
    match probe_one_block(id, body, |block| block.entries.is_empty()) {
        Err(codes) => fail(
            code,
            format!("The body must be the text between the braces of one {what}: balanced braces and no definition of its own"),
            json!({ "diagnosticCodes": codes }),
        ),
        Ok(true) => {
            fail(code, format!("The body of {} {what} cannot be empty", if what.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" }), json!({}))
        }
        Ok(false) => Ok(()),
    }
}

fn definition_texts(source: &Source<'_>, skip: Option<usize>) -> BTreeMap<String, Vec<String>> {
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for Located { idea, category } in definitions(&source.document.root) {
        let range = source.entry_range(idea);
        if Some(range.start) == skip {
            continue;
        }
        by_key.entry(format!("{}:{}", key_of(category), key_of(idea))).or_default().push(source.text()[range].to_string());
    }
    by_key
}

/// The edit that adds a category block holding the new idea to the file's single `ideas` block.
fn category_creation(source: &Source<'_>, input: &IdeaWriteInput, unit: &str, body: &str) -> WriteResult<Replacement> {
    let wanted = input.category.as_deref().unwrap_or_default();
    if !id_is_valid(wanted) {
        return fail("IDEA_WRITE_CATEGORY_INVALID", format!("{} is not a valid category name", json!(wanted)), json!({ "category": wanted }));
    }
    let bytes = source.bytes();
    let newline = source.newline();
    let blocks: Vec<&Entry> = assignments(&source.document.root, Some("ideas")).into_iter().filter(|e| block_of(e).is_some()).collect();
    if blocks.len() != 1 {
        return fail(
            "IDEA_WRITE_LAYOUT_UNSUPPORTED",
            if blocks.is_empty() {
                "The file has no ideas block to put a new category in".to_string()
            } else {
                format!("The file has {} ideas blocks, so the new category has no single place", blocks.len())
            },
            json!({ "blocks": blocks.len() }),
        );
    }
    let ideas = blocks[0];
    let block = block_of(ideas).expect("filtered to blocks");
    let Some(close) = source.close_range(block) else {
        return fail("IDEA_WRITE_LAYOUT_UNSUPPORTED", "The ideas block has no closing brace", json!({}));
    };
    let close_line_start = line_start(bytes, close.start);
    if !blank(&bytes[close_line_start..close.start]) {
        return fail(
            "IDEA_WRITE_LAYOUT_UNSUPPORTED",
            "The closing brace of the ideas block shares its line with other text",
            json!({ "line": source.line_of(close.start) }),
        );
    }
    let category_indent = format!("{}{unit}", line_indent(bytes, source.entry_range(ideas).start));
    let idea_indent = format!("{category_indent}{unit}");
    let idea_text =
        format!("{idea_indent}{} = {{{newline}{}{newline}{idea_indent}}}{newline}", input.id, indented_body(body, &format!("{idea_indent}{unit}"), newline));
    Ok(Replacement {
        start: close_line_start,
        end: close_line_start,
        text: format!("{}{category_indent}{wanted} = {{{newline}{idea_text}{category_indent}}}{newline}", if block.entries.is_empty() { "" } else { newline }),
        description: format!("add {} in the new category {wanted}", input.id),
    })
}

fn body_required(input: &IdeaWriteInput) -> WriteResult<&str> {
    match input.body.as_deref() {
        Some(body) if !body.trim().is_empty() => Ok(body),
        _ => fail("IDEA_WRITE_BODY_REQUIRED", format!("{} needs the body of the idea", input.operation.name()), json!({})),
    }
}

/// The plan that creates a new `common/ideas` file holding one new idea in one category
/// (`planNewIdeaFile`). The file is UTF-8 without a byte order mark and uses tabs and LF.
pub fn plan_new_idea_file(path: &str, input: &IdeaWriteInput) -> WriteResult<IdeaWritePlan> {
    if !id_is_valid(&input.id) {
        return fail("IDEA_WRITE_ID_INVALID", format!("{} is not a valid idea id", json!(input.id)), json!({ "id": input.id }));
    }
    if input.operation != Operation::Add {
        return fail("IDEA_WRITE_FILE_NOT_FOUND", format!("{path} does not exist, and only add can create a file"), json!({}));
    }
    let category = match input.category.as_deref() {
        Some(category) if id_is_valid(category) => category,
        _ => return fail("IDEA_WRITE_CATEGORY_REQUIRED", "a new file needs the category block the idea goes in", json!({})),
    };
    let body = match input.body.as_deref() {
        Some(body) if !body.trim().is_empty() => body,
        _ => return fail("IDEA_WRITE_BODY_REQUIRED", "add needs the body of the idea", json!({})),
    };
    assert_body_is_one_block(&input.id, body, "IDEA_WRITE_BODY_INVALID", "idea")?;
    let text = [
        "ideas = {".to_string(),
        format!("\t{category} = {{"),
        format!("\t\t{} = {{", input.id),
        indented_body(body, "\t\t\t", "\n"),
        "\t\t}".to_string(),
        "\t}".to_string(),
        "}".to_string(),
        String::new(),
    ]
    .join("\n");
    let decoded = Decoded::new(text.as_bytes());
    let written = Source::new(&decoded, path);
    if written.has_blocking() {
        return fail("IDEA_WRITE_RESULT_INVALID", "The new file would have syntax errors", json!({ "diagnosticCodes": written.diagnostic_codes() }));
    }
    Ok(IdeaWritePlan {
        operation: Operation::Add,
        id: input.id.clone(),
        category: category.to_string(),
        path: path.to_string(),
        bytes: text.clone().into_bytes(),
        edit: Replacement { start: 0, end: 0, text: text.clone(), description: format!("create {path} with {}", input.id) },
        text,
        untouched_definitions: 0,
    })
}

/// `planIdeaWrite`: the edit of one idea of an existing file.
pub fn plan_idea_write(bytes: &[u8], path: &str, input: &IdeaWriteInput) -> WriteResult<IdeaWritePlan> {
    if !id_is_valid(&input.id) {
        return fail("IDEA_WRITE_ID_INVALID", format!("{} is not a valid idea id", json!(input.id)), json!({ "id": input.id }));
    }
    if input.operation == Operation::Remove && input.body.is_some() {
        return fail("IDEA_WRITE_BODY_UNEXPECTED", "remove takes no body", json!({}));
    }
    if input.operation != Operation::Remove {
        body_required(input)?;
    }
    let decoded = Decoded::new(bytes);
    let source = Source::new(&decoded, path);
    if source.has_blocking() {
        return fail(
            "IDEA_WRITE_SOURCE_INVALID",
            "The source has syntax errors and cannot be edited safely",
            json!({ "path": path, "diagnosticCodes": source.diagnostic_codes() }),
        );
    }
    let text = source.bytes();
    let newline = source.newline();
    let located = definitions(&source.document.root);
    if let Some(body) = input.body.as_deref() {
        assert_body_is_one_block(&input.id, body, "IDEA_WRITE_BODY_INVALID", "idea")?;
    }
    let unit = indent_unit(&source, &located);
    let existing: Vec<&Located> = located.iter().filter(|l| key_of(l.idea) == input.id).collect();

    let edit: Replacement;
    let category: String;
    let mut skip: Option<usize> = None;

    if input.operation == Operation::Add {
        if let Some(first) = existing.first() {
            return fail(
                "IDEA_WRITE_DUPLICATE_ID",
                format!("{} is already defined in this file", input.id),
                json!({ "id": input.id, "category": key_of(first.category), "line": first.idea.key.line }),
            );
        }
        let Some(wanted) = input.category.as_deref() else {
            return fail("IDEA_WRITE_CATEGORY_REQUIRED", "add needs the category block the idea goes in", json!({}));
        };
        let blocks = category_blocks(&source.document.root);
        let matching: Vec<&Entry> = blocks.iter().copied().filter(|e| e.key.value == wanted).collect();
        if matching.is_empty() && input.create_category != Some(true) {
            let mut categories: Vec<String> = Vec::new();
            for entry in &blocks {
                let key = key_of(entry);
                if !categories.contains(&key) {
                    categories.push(key);
                }
            }
            return fail(
                "IDEA_WRITE_CATEGORY_NOT_FOUND",
                format!("The file has no {wanted} category; pass createCategory: true to create it"),
                json!({ "category": wanted, "categories": categories }),
            );
        }
        if matching.len() > 1 {
            return fail(
                "IDEA_WRITE_CATEGORY_AMBIGUOUS",
                format!("The file has {} {wanted} categories", matching.len()),
                json!({ "category": wanted, "lines": matching.iter().map(|e| e.key.line).collect::<Vec<_>>() }),
            );
        }
        let body = input.body.as_deref().unwrap_or_default();
        edit = if matching.is_empty() {
            category_creation(&source, input, &unit, body)?
        } else {
            let target = matching[0];
            let block = block_of(target).expect("filtered to blocks");
            let Some(close) = source.close_range(block) else {
                return fail("IDEA_WRITE_LAYOUT_UNSUPPORTED", format!("The {wanted} category has no closing brace"), json!({}));
            };
            let close_line_start = line_start(text, close.start);
            if !blank(&text[close_line_start..close.start]) {
                return fail(
                    "IDEA_WRITE_LAYOUT_UNSUPPORTED",
                    format!("The closing brace of {wanted} shares its line with other text, so the new idea has no line to go on"),
                    json!({ "category": wanted, "line": source.line_of(close.start) }),
                );
            }
            let category_indent = line_indent(text, source.entry_range(target).start);
            let idea_indent = format!("{category_indent}{unit}");
            let idea_text = format!(
                "{idea_indent}{} = {{{newline}{}{newline}{idea_indent}}}{newline}",
                input.id,
                indented_body(body, &format!("{idea_indent}{unit}"), newline)
            );
            Replacement {
                start: close_line_start,
                end: close_line_start,
                text: format!("{}{idea_text}", if block.entries.is_empty() { "" } else { newline }),
                description: format!("add {} to {wanted}", input.id),
            }
        };
        category = wanted.to_string();
    } else {
        if existing.is_empty() {
            return fail("IDEA_WRITE_NOT_FOUND", format!("{} is not defined in this file", input.id), json!({ "id": input.id }));
        }
        if existing.len() > 1 {
            return fail(
                "IDEA_WRITE_DUPLICATE_ID",
                format!("{} is defined {} times in this file", input.id, existing.len()),
                json!({ "id": input.id, "lines": existing.iter().map(|l| l.idea.key.line).collect::<Vec<_>>() }),
            );
        }
        let found = existing[0];
        category = key_of(found.category);
        if input.category.as_deref().is_some_and(|c| c != category) {
            return fail(
                "IDEA_WRITE_CATEGORY_MISMATCH",
                format!("{} is in {category}, and moving an idea to another category is not supported", input.id),
                json!({ "id": input.id, "category": category }),
            );
        }
        let range = source.entry_range(found.idea);
        skip = Some(range.start);
        let idea_indent = line_indent(text, range.start);
        if input.operation == Operation::Replace {
            let body = input.body.as_deref().unwrap_or_default();
            edit = Replacement {
                start: range.start,
                end: range.end,
                text: format!("{} = {{{newline}{}{newline}{idea_indent}}}", input.id, indented_body(body, &format!("{idea_indent}{unit}"), newline)),
                description: format!("replace {}", input.id),
            };
        } else {
            edit = remove_edit(&source, &input.id, range.start, range.end, false);
        }
    }

    let (after_text, new_bytes) = apply_replacements(&source, std::slice::from_ref(&edit))?;
    let written_decoded = Decoded::new(&new_bytes);
    let written = Source::new(&written_decoded, path);
    if written.has_blocking() {
        return fail("IDEA_WRITE_RESULT_INVALID", "The edit would leave the file with syntax errors", json!({ "diagnosticCodes": written.diagnostic_codes() }));
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
                return fail("IDEA_WRITE_RESULT_INVALID", format!("The edit would change {key}, which it must not touch"), json!({ "key": key }));
            }
        }
    }
    if written.text() != after_text {
        return fail("IDEA_WRITE_RESULT_INVALID", "The written file does not match the planned edit", json!({}));
    }
    Ok(IdeaWritePlan {
        operation: input.operation,
        id: input.id.clone(),
        category,
        path: path.to_string(),
        text: after_text,
        bytes: new_bytes,
        edit,
        untouched_definitions: untouched,
    })
}

/// The removal of one definition: its own line when it is alone on it, and a blank line that only
/// separated it from the definition before. `flat` files have no closing brace to stop at.
pub fn remove_edit(source: &Source<'_>, id: &str, start: usize, end: usize, flat: bool) -> Replacement {
    let text = source.bytes();
    let line_start_at = line_start(text, start);
    let line_end_at = text[end..].iter().position(|&b| b == b'\n').map(|at| end + at);
    let line_end = line_end_at.map_or(text.len(), |at| at + 1);
    let tail = &text[end..line_end_at.unwrap_or(text.len())];
    let alone = blank(&text[line_start_at..start]) && (blank(tail) || (tail.last() == Some(&b'\r') && blank(&tail[..tail.len() - 1])));
    let description = format!("remove {id}");
    if !alone {
        return Replacement { start, end, text: String::new(), description };
    }
    let before = &text[..line_start_at];
    let blank_before = !before.is_empty() && before.ends_with(b"\n") && {
        let inner = &before[..before.len() - 1];
        let previous = inner.iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
        let line = &inner[previous..];
        blank(line) || (line.last() == Some(&b'\r') && blank(&line[..line.len() - 1]))
    };
    let after = &text[line_end..];
    let next_is_blank_or_close = after.is_empty() || {
        let skip = after.iter().take_while(|&&b| b == b' ' || b == b'\t').count();
        let crlf = after.get(skip) == Some(&b'\r') && after.get(skip + 1) == Some(&b'\n');
        if flat {
            let rest = &after[skip..];
            rest.is_empty() || rest[0] == b'\n' || crlf || rest == b"\r"
        } else {
            matches!(after.get(skip), Some(b'\n' | b'}')) || crlf
        }
    };
    let mut new_start = line_start_at;
    if blank_before && next_is_blank_or_close {
        let upto = before.len().saturating_sub(1);
        new_start = before[..upto].iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
    }
    Replacement { start: new_start, end: line_end, text: String::new(), description }
}

/// The category blocks of a `common/ideas` file, or none when the file cannot be parsed.
pub fn idea_categories(bytes: &[u8], path: &str) -> Vec<String> {
    let decoded = Decoded::new(bytes);
    let source = Source::new(&decoded, path);
    if source.has_blocking() {
        return Vec::new();
    }
    let mut seen: Vec<String> = Vec::new();
    for entry in category_blocks(&source.document.root) {
        let key = key_of(entry);
        if !seen.contains(&key) {
            seen.push(key);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use hoi4_core::plan::{FileChange, PlanApplier, RewritePlan};
    use hoi4_core::testing::MemoryApplier;

    const FILE: &str = "# Ideas of the test mod\nideas = {\n\tcountry = {\n\t\t# the first spirit\n\t\tfirst_spirit = {\n\t\t\tpicture = first_spirit\n\t\t\tmodifier = { stability_factor = 0.1 }\n\t\t}\n\n\t\tsecond_spirit = {\n\t\t\tpicture = second_spirit\n\t\t}\n\t}\n\n\thidden_ideas = {\n\t}\n}\n";

    fn input(operation: Operation, id: &str, category: Option<&str>, body: Option<&str>) -> IdeaWriteInput {
        IdeaWriteInput { operation, id: id.into(), category: category.map(Into::into), create_category: None, body: body.map(Into::into) }
    }

    fn plan(i: &IdeaWriteInput) -> WriteResult<IdeaWritePlan> {
        plan_idea_write(FILE.as_bytes(), "common/ideas/test.txt", i)
    }

    fn code(result: WriteResult<IdeaWritePlan>) -> String {
        result.err().map_or("NO_ERROR".into(), |e| e.code)
    }

    #[test]
    fn adds_at_the_end_of_a_category_after_a_blank_line() {
        let result =
            plan(&input(Operation::Add, "third_spirit", Some("country"), Some("picture = third_spirit\nmodifier = {\n\tstability_factor = 0.05\n}"))).unwrap();
        let expected = FILE.replace(
            "\t\t\tpicture = second_spirit\n\t\t}\n\t}",
            "\t\t\tpicture = second_spirit\n\t\t}\n\n\t\tthird_spirit = {\n\t\t\tpicture = third_spirit\n\t\t\tmodifier = {\n\t\t\t\tstability_factor = 0.05\n\t\t\t}\n\t\t}\n\t}",
        );
        assert_eq!(String::from_utf8(result.bytes).unwrap(), expected);
        assert_eq!(result.untouched_definitions, 2);
    }

    #[test]
    fn replaces_only_the_idea_block_and_keeps_the_comment() {
        let result = plan(&input(Operation::Replace, "first_spirit", None, Some("picture = other"))).unwrap();
        let text = String::from_utf8(result.bytes).unwrap();
        assert!(text.contains("\t\t# the first spirit\n\t\tfirst_spirit = {\n\t\t\tpicture = other\n\t\t}\n"));
        assert_eq!(result.category, "country");
        assert_eq!(result.untouched_definitions, 1);
    }

    #[test]
    fn removes_the_idea_its_line_and_the_blank_line_before() {
        let result = plan(&input(Operation::Remove, "second_spirit", None, None)).unwrap();
        let text = String::from_utf8(result.bytes).unwrap();
        assert_eq!(
            text,
            FILE.replace(
                "

		second_spirit = {
			picture = second_spirit
		}
",
                "
"
            )
        );
        assert_eq!(result.untouched_definitions, 1);
    }

    #[test]
    fn add_then_remove_gives_back_the_original_bytes() {
        let added = plan(&input(Operation::Add, "third_spirit", Some("country"), Some("picture = third_spirit"))).unwrap();
        let removed = plan_idea_write(&added.bytes, "common/ideas/test.txt", &input(Operation::Remove, "third_spirit", None, None)).unwrap();
        assert_eq!(removed.bytes, FILE.as_bytes());
    }

    #[test]
    fn keeps_crlf_and_the_byte_order_mark() {
        let crlf = format!("\u{feff}{}", FILE.replace('\n', "\r\n"));
        let result = plan_idea_write(crlf.as_bytes(), "a.txt", &input(Operation::Add, "third_spirit", Some("country"), Some("picture = x"))).unwrap();
        assert!(result.bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(result.bytes).unwrap();
        assert_eq!(text.replace("\r\n", "").matches(['\r', '\n']).count(), 0);
        assert!(text.contains("\t\tthird_spirit = {\r\n\t\t\tpicture = x\r\n\t\t}\r\n"));
    }

    #[test]
    fn refuses_what_it_cannot_place() {
        assert_eq!(code(plan(&input(Operation::Add, "first_spirit", Some("country"), Some("a = b")))), "IDEA_WRITE_DUPLICATE_ID");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", None, Some("a = b")))), "IDEA_WRITE_CATEGORY_REQUIRED");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", Some("nope"), Some("a = b")))), "IDEA_WRITE_CATEGORY_NOT_FOUND");
        assert_eq!(code(plan(&input(Operation::Add, "bad id", Some("country"), Some("a = b")))), "IDEA_WRITE_ID_INVALID");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", Some("country"), Some("a = b }\nz = {")))), "IDEA_WRITE_BODY_INVALID");
        assert_eq!(code(plan(&input(Operation::Add, "x_one", Some("country"), Some("  ")))), "IDEA_WRITE_BODY_REQUIRED");
        assert_eq!(code(plan(&input(Operation::Replace, "nope_one", None, Some("a = b")))), "IDEA_WRITE_NOT_FOUND");
        assert_eq!(code(plan(&input(Operation::Replace, "first_spirit", Some("hidden_ideas"), Some("a = b")))), "IDEA_WRITE_CATEGORY_MISMATCH");
        assert_eq!(code(plan(&input(Operation::Remove, "first_spirit", None, Some("a = b")))), "IDEA_WRITE_BODY_UNEXPECTED");
        let twice = FILE.replace("second_spirit", "first_spirit");
        assert_eq!(code(plan_idea_write(twice.as_bytes(), "a.txt", &input(Operation::Remove, "first_spirit", None, None))), "IDEA_WRITE_DUPLICATE_ID");
        assert_eq!(
            code(plan_idea_write(b"ideas = { country = {", "a.txt", &input(Operation::Add, "x_one", Some("country"), Some("a = b")))),
            "IDEA_WRITE_SOURCE_INVALID"
        );
    }

    #[test]
    fn creates_a_category_only_when_asked() {
        let mut i = input(Operation::Add, "advisor_one", Some("political_advisor"), Some("picture = a"));
        assert_eq!(code(plan(&i)), "IDEA_WRITE_CATEGORY_NOT_FOUND");
        i.create_category = Some(true);
        let result = plan(&i).unwrap();
        assert!(String::from_utf8(result.bytes).unwrap().contains("\n\tpolitical_advisor = {\n\t\tadvisor_one = {\n\t\t\tpicture = a\n\t\t}\n\t}\n}\n"));
        assert_eq!(result.untouched_definitions, 2);
        i.category = Some("bad name".into());
        assert_eq!(code(plan(&i)), "IDEA_WRITE_CATEGORY_INVALID");
    }

    #[test]
    fn makes_a_new_file_in_the_game_layout() {
        let result = plan_new_idea_file("common/ideas/n.txt", &input(Operation::Add, "one_idea", Some("country"), Some("picture = one"))).unwrap();
        assert_eq!(String::from_utf8(result.bytes).unwrap(), "ideas = {\n\tcountry = {\n\t\tone_idea = {\n\t\t\tpicture = one\n\t\t}\n\t}\n}\n");
        assert_eq!(code(plan_new_idea_file("n.txt", &input(Operation::Add, "one_idea", None, Some("a = b")))), "IDEA_WRITE_CATEGORY_REQUIRED");
        assert_eq!(code(plan_new_idea_file("n.txt", &input(Operation::Remove, "one_idea", Some("country"), None))), "IDEA_WRITE_FILE_NOT_FOUND");
    }

    #[test]
    fn a_plan_goes_through_the_applier_and_a_stale_source_is_refused() {
        let applier = MemoryApplier::new([("a.txt".to_string(), FILE.as_bytes().to_vec())]);
        let result = plan_idea_write(FILE.as_bytes(), "a.txt", &input(Operation::Remove, "first_spirit", None, None)).unwrap();
        let rewrite = |before: &[u8]| RewritePlan {
            workspace_id: "w".into(),
            operation_kind: "idea-write".into(),
            changes: vec![FileChange {
                path: "a.txt".into(),
                before_sha256: Some(hoi4_core::canonical::sha256_hex(before)),
                after: Some(result.bytes.clone()),
            }],
            diagnostics: Vec::new(),
        };
        assert_eq!(applier.apply(&rewrite(b"other")).unwrap_err().code, "TRANSACTION_STALE");
        assert!(applier.apply(&rewrite(FILE.as_bytes())).is_ok());
        assert_eq!(applier.read("a.txt").unwrap(), result.bytes);
    }

    #[test]
    fn lists_the_categories() {
        assert_eq!(idea_categories(FILE.as_bytes(), "a.txt"), vec!["country", "hidden_ideas"]);
        assert!(idea_categories(b"ideas = {", "a.txt").is_empty());
    }

    #[test]
    fn untouched_bytes_round_trip_exactly_in_every_encoding() {
        // BOM and CRLF: everything outside the new idea is byte-identical.
        let crlf = format!("\u{feff}{}", FILE.replace('\n', "\r\n"));
        let added = plan_idea_write(crlf.as_bytes(), "a.txt", &input(Operation::Add, "third_spirit", Some("country"), Some("picture = x"))).unwrap();
        let removed = plan_idea_write(&added.bytes, "a.txt", &input(Operation::Remove, "third_spirit", None, None)).unwrap();
        assert_eq!(removed.bytes, crlf.as_bytes());
        // Windows-1252: a defined high byte survives, and the new text is encoded in it.
        let mut latin = FILE.as_bytes().to_vec();
        latin.extend_from_slice(b"# Gro\xDF\n");
        let added = plan_idea_write(&latin, "a.txt", &input(Operation::Add, "third_spirit", Some("country"), Some("picture = x"))).unwrap();
        assert!(added.bytes.windows(4).any(|w| w == b"Gro\xDF"));
        let removed = plan_idea_write(&added.bytes, "a.txt", &input(Operation::Remove, "third_spirit", None, None)).unwrap();
        assert_eq!(removed.bytes, latin);
        // A character Windows-1252 cannot hold is refused, not replaced.
        assert_eq!(
            code(plan_idea_write(&latin, "a.txt", &input(Operation::Add, "third_spirit", Some("country"), Some("picture = \u{4e2d}")))),
            "SOURCE_ENCODING_UNREPRESENTABLE"
        );
    }

    #[test]
    fn refuses_a_windows_1252_file_that_would_not_round_trip() {
        let mut lossy = FILE.as_bytes().to_vec();
        lossy.extend_from_slice(b"# \x81\n");
        assert_eq!(
            code(plan_idea_write(&lossy, "a.txt", &input(Operation::Add, "third_spirit", Some("country"), Some("picture = x")))),
            "SOURCE_ENCODING_NOT_ROUND_TRIPPABLE"
        );
    }
}
