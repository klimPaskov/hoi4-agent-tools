//! Imports a draw.io (diagrams.net) sketch of a focus tree: every vertex becomes a focus on the
//! game grid and every edge a prerequisite link.
//!
//! Provenance: ported from Hagane Studio, `internal/hoi4/drawio/drawio.go` and its tests
//! (hagane-works/hagane-studio at 1e831623ed162e1a64763c242c55b249376ba20c, GPL-3.0-only). The
//! copyright holder gave the maintainer written permission to use the project in any way,
//! including under this repository's Apache-2.0 licence (maintainer decision D-05). The output,
//! warning texts and limits match the original so its parity fixtures pass unchanged
//! (`tests/data/hagane_parity.json`). The XML parser is `roxmltree`, which refuses document type
//! declarations and so entity expansion.

use serde::{Deserialize, Serialize};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const PX_PER_GRID_UNIT: f64 = 100.0;
const MAX_FOCUS_ID_CHARS: usize = 200;
const MAX_FOCUS_NAME_CHARS: usize = 255;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub focus_id: String,
    pub name: String,
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Import {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub warnings: Vec<String>,
}

type XmlNode<'a, 'i> = roxmltree::Node<'a, 'i>;

fn tag_is(node: &XmlNode, tag: &str) -> bool {
    node.is_element() && node.tag_name().namespace().is_none() && node.tag_name().name() == tag
}

fn attr<'a>(node: &XmlNode<'a, '_>, name: &str) -> Option<&'a str> {
    node.attributes().find(|a| a.namespace().is_none() && a.name() == name).map(|a| a.value())
}

fn first_child<'a, 'i>(node: &XmlNode<'a, 'i>, tag: &str) -> Option<XmlNode<'a, 'i>> {
    node.children().find(|c| tag_is(c, tag))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Decodes HTML character references left in a label after its markup is removed.
fn unescape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let Some(end) = rest[1..].find(';').map(|e| e + 1).filter(|e| *e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn plain_label(label: &str) -> String {
    let mut without_tags = String::with_capacity(label.len());
    let mut in_tag = false;
    let mut pending = String::new();
    for c in label.chars() {
        if in_tag {
            pending.push(c);
            if c == '>' {
                in_tag = false;
                pending.clear();
                without_tags.push(' ');
            }
        } else if c == '<' {
            in_tag = true;
            pending.push(c);
        } else {
            without_tags.push(c);
        }
    }
    // An unclosed `<` is not a tag.
    without_tags.push_str(&pending);
    let cleaned = unescape_html(&without_tags).split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&cleaned, MAX_FOCUS_NAME_CHARS).trim_end().to_string()
}

/// Turns a label into a focus id: ASCII letters, digits and underscores, other runs collapsed to
/// one underscore, at most 200 characters.
pub fn sanitize_focus_id(label: &str) -> String {
    let mut out = String::new();
    let mut last_unsafe = false;
    for c in label.chars() {
        if c == '_' || c.is_ascii_alphanumeric() {
            out.push(c);
            last_unsafe = false;
        } else if !last_unsafe {
            out.push('_');
            last_unsafe = true;
        }
    }
    let cleaned = out.trim_matches('_');
    let cleaned = truncate_chars(cleaned, MAX_FOCUS_ID_CHARS);
    let cleaned = cleaned.trim_matches('_');
    if cleaned.is_empty() { "focus".to_string() } else { cleaned.to_string() }
}

struct CellView<'a, 'i> {
    id: String,
    label: String,
    vertex: String,
    edge: String,
    source: String,
    target: String,
    geometry: Option<XmlNode<'a, 'i>>,
}

fn view_cell<'a, 'i>(cell: &XmlNode<'a, 'i>) -> CellView<'a, 'i> {
    let get = |n: &XmlNode<'a, 'i>, name: &str| attr(n, name).unwrap_or_default().to_string();
    if tag_is(cell, "object") || tag_is(cell, "UserObject") {
        let inner = first_child(cell, "mxCell");
        let mut label = get(cell, "label");
        if label.is_empty() {
            label = get(cell, "value");
        }
        let mut view = CellView {
            id: get(cell, "id"),
            label: label.trim().to_string(),
            vertex: String::new(),
            edge: String::new(),
            source: get(cell, "source"),
            target: get(cell, "target"),
            geometry: None,
        };
        if let Some(inner) = inner {
            view.vertex = get(&inner, "vertex");
            view.edge = get(&inner, "edge");
            view.geometry = first_child(&inner, "mxGeometry");
            if view.source.is_empty() {
                view.source = get(&inner, "source");
            }
            if view.target.is_empty() {
                view.target = get(&inner, "target");
            }
        }
        return view;
    }
    CellView {
        id: get(cell, "id"),
        label: get(cell, "value").trim().to_string(),
        vertex: get(cell, "vertex"),
        edge: get(cell, "edge"),
        source: get(cell, "source"),
        target: get(cell, "target"),
        geometry: first_child(cell, "mxGeometry"),
    }
}

fn geometry(view: &CellView) -> Option<(f64, f64)> {
    let Some(g) = &view.geometry else { return Some((0.0, 0.0)) };
    let parse = |value: Option<&str>| -> Option<f64> {
        let raw = value.unwrap_or("0").trim();
        let parsed: f64 = raw.parse().ok()?;
        parsed.is_finite().then_some(parsed)
    };
    Some((parse(attr(g, "x"))?, parse(attr(g, "y"))?))
}

pub fn parse(text: &str, prefix: &str) -> Result<Import, String> {
    let mut result = Import::default();
    if text.trim().is_empty() {
        return Err("empty Draw.io payload".into());
    }
    if text.len() > MAX_BYTES {
        return Err(format!("Draw.io payload too large: {} bytes exceeds cap of {MAX_BYTES} bytes", text.len()));
    }
    let doc = roxmltree::Document::parse(text).map_err(|e| match e {
        roxmltree::Error::DtdDetected => "Draw.io XML rejected (unsafe XML construct): DOCTYPE and ENTITY declarations are not allowed".to_string(),
        other => format!("Draw.io XML parse failed: {other}"),
    })?;
    let root = doc.root();
    let wrappers: Vec<XmlNode> = root.descendants().filter(|n| tag_is(n, "object")).chain(root.descendants().filter(|n| tag_is(n, "UserObject"))).collect();
    let mut cells = wrappers.clone();
    for cell in root.descendants().filter(|n| tag_is(n, "mxCell")) {
        let wrapped = cell.parent().is_some_and(|p| tag_is(&p, "object") || tag_is(&p, "UserObject"));
        if !wrapped {
            cells.push(cell);
        }
    }

    let mut id_to_focus: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for cell in &cells {
        let view = view_cell(cell);
        if view.vertex != "1" {
            continue;
        }
        let (raw_x, raw_y) = geometry(&view).unwrap_or_else(|| {
            result.warnings.push(format!("cell {}: invalid geometry \u{b7} using (0,0)", view.id));
            (0.0, 0.0)
        });
        let label = plain_label(&view.label);
        let mut focus_id =
            if label.is_empty() { format!("focus_{}", if view.id.is_empty() { "unnamed" } else { &view.id }) } else { sanitize_focus_id(&label) };
        if !prefix.is_empty() {
            focus_id = format!("{prefix}_{focus_id}");
        }
        let mut claimed = focus_id.clone();
        let mut suffix = 2;
        while used.contains(&claimed) {
            claimed = format!("{focus_id}_{suffix}");
            suffix += 1;
        }
        used.insert(claimed.clone());
        if claimed != focus_id {
            result.warnings.push(format!("focus_id collision \u{b7} '{focus_id}' renamed to '{claimed}'"));
        }
        id_to_focus.insert(view.id.clone(), claimed.clone());
        let name = if label.is_empty() { claimed.clone() } else { label };
        result.nodes.push(Node { focus_id: claimed, name, x: (raw_x / PX_PER_GRID_UNIT).floor() as i64, y: (raw_y / PX_PER_GRID_UNIT).floor() as i64 });
    }

    if let Some(first) = result.nodes.first() {
        let (mut min_x, mut min_y) = (first.x, first.y);
        for node in &result.nodes[1..] {
            min_x = min_x.min(node.x);
            min_y = min_y.min(node.y);
        }
        if min_x < 0 || min_y < 0 {
            for node in &mut result.nodes {
                node.x -= min_x;
                node.y -= min_y;
            }
            result.warnings.push(format!("negative canvas coords \u{b7} shifted all nodes by ({},{}) to keep grid positions non-negative", -min_x, -min_y));
        }
    }

    let mut occupied: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
    for node in &mut result.nodes {
        if occupied.insert((node.x, node.y)) {
            continue;
        }
        let (ox, oy) = (node.x, node.y);
        let (mut nx, mut ny) = (ox, oy);
        while occupied.contains(&(nx, ny)) {
            nx += 1;
            if nx - ox > 64 {
                nx = ox;
                ny += 1;
            }
        }
        occupied.insert((nx, ny));
        result.warnings.push(format!("grid collision \u{b7} focus '{}' moved from ({ox},{oy}) to ({nx},{ny}) to avoid overlap", node.focus_id));
        node.x = nx;
        node.y = ny;
    }

    for cell in &cells {
        let view = view_cell(cell);
        if view.edge != "1" {
            continue;
        }
        let (Some(source), Some(target)) = (id_to_focus.get(&view.source), id_to_focus.get(&view.target)) else {
            result.warnings.push(format!("edge {}: dangling source / target \u{b7} skipped", if view.id.is_empty() { "?" } else { &view.id }));
            continue;
        };
        if source == target {
            result.warnings.push(format!("self-loop edge on '{source}' \u{b7} dropped (a focus cannot be its own prerequisite)"));
            continue;
        }
        result.edges.push(Edge { source: source.clone(), target: target.clone() });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        xml: String,
        prefix: String,
        expected: Import,
    }

    #[test]
    fn matches_the_hagane_parity_fixtures() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!("../tests/data/hagane_parity.json")).unwrap();
        assert_eq!(fixtures.len(), 5);
        for fixture in fixtures {
            let got = parse(&fixture.xml, &fixture.prefix).unwrap_or_else(|e| panic!("{}: {e}", fixture.name));
            assert_eq!(got, fixture.expected, "fixture {}", fixture.name);
        }
    }

    #[test]
    fn rejects_unsafe_and_malformed_xml() {
        for (input, want) in [
            (r#"<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><mxGraphModel>&e;</mxGraphModel>"#, "unsafe XML construct"),
            (r#"<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><mxGraphModel/>"#, "unsafe XML construct"),
            ("<mxGraphModel><root>", "Draw.io XML parse failed"),
            (" \n\t", "empty Draw.io payload"),
        ] {
            let err = parse(input, "").unwrap_err();
            assert!(err.contains(want), "{input}: {err}");
        }
    }

    #[test]
    fn doctype_text_inside_comment_or_cdata_is_not_a_declaration() {
        for input in
            ["<mxGraphModel><!-- <!DOCTYPE harmless> --><root/></mxGraphModel>", "<mxGraphModel><root><![CDATA[<!DOCTYPE harmless>]]></root></mxGraphModel>"]
        {
            assert_eq!(parse(input, "").unwrap(), Import::default());
        }
    }

    #[test]
    fn rejects_payloads_over_eight_mib() {
        let input = format!("<x>{}</x>", "a".repeat(MAX_BYTES));
        assert!(parse(&input, "").unwrap_err().contains("payload too large"));
    }

    #[test]
    fn caps_labels_by_characters() {
        let label = "\u{754c}".repeat(300);
        let got = parse(&format!(r#"<mxGraphModel><root><mxCell id="n" value="{label}" vertex="1"/></root></mxGraphModel>"#), "").unwrap();
        assert_eq!(got.nodes[0].name.chars().count(), MAX_FOCUS_NAME_CHARS);
        assert_eq!(got.nodes[0].focus_id, "focus");

        let label = "x".repeat(400);
        let got = parse(&format!(r#"<mxGraphModel><root><mxCell id="n" value="{label}" vertex="1"/></root></mxGraphModel>"#), "").unwrap();
        assert_eq!(got.nodes[0].focus_id.chars().count(), MAX_FOCUS_ID_CHARS);
        assert_eq!(got.nodes[0].name.chars().count(), MAX_FOCUS_NAME_CHARS);
    }
}
