//! The unit kinds, for `hoi4-engine units` and the MCP tool `hoi4.unit_inspect`: orders of battle
//! (`history/units`), sub-units, equipment with its modules, and equipment variants.
//!
//! The rules follow `common/units/equipment/_documentation.md` and the shipped files. Templates are
//! checked against the designer's grid (five columns of five regiments and one column of five
//! support companies, unless the `MAX_DIVISION_` defines change it), and every name a unit file gives is looked up: sub-units, equipment, modules, module
//! categories, upgrades, variants, templates, division name groups, provinces and states.

use std::collections::{HashMap, HashSet};
use std::fs;

use hoi4_syntax::{Block, Document};
use rayon::prelude::*;

use super::{Checker, Found, State, System, VARIANT_SOURCES, computed, named_blocks, parse_files, problem, read_ids, scalar, values};
use crate::ideas::{self, Problem};
use crate::workspace::Workspace;

/// The keys that load an order of battle by its file name.
const OOB_KEYS: &[&str] = &["oob", "set_oob", "load_oob", "set_naval_oob", "set_air_oob"];

/// Names the unit checks look up beyond the definitions of the inspected kind.
pub(super) fn extra_names(system: System, workspace: &Workspace, docs: &[(usize, Document)]) -> Vec<(&'static str, HashSet<String>)> {
    let upgrades = || read_ids(workspace, "common/units/equipment/upgrades/", "upgrades");
    let mut extra = match system {
        System::OnActions | System::Mio | System::BalanceOfPower => Vec::new(),
        _ => vec![("derived_equipment", derived_equipment(workspace))],
    };
    extra.extend(match system {
        System::Equipment => vec![("module_category", module_categories(workspace)), ("upgrade", upgrades())],
        System::Variant => vec![("upgrade", upgrades())],
        System::Oob => {
            // A carrier's air wings are listed under the ship's name.
            let ships = docs
                .iter()
                .flat_map(|(_, doc)| {
                    let mut found = Vec::new();
                    named_blocks(doc, &doc.root, "ship", &mut found);
                    found
                        .into_iter()
                        .filter_map(|e| e.value.as_block().and_then(|b| scalar(doc, b, "name")))
                        .map(|(n, _)| n.to_ascii_lowercase())
                        .collect::<Vec<_>>()
                })
                .collect();
            vec![
                ("variant", named_anywhere(workspace, "create_equipment_variant")),
                // Templates come from orders of battle and from the `division_template` effect.
                ("division_template", named_anywhere(workspace, "division_template")),
                ("division_names_group", name_groups(workspace)),
                ("province", provinces(workspace)),
                ("ship", ships),
            ]
        }
        _ => Vec::new(),
    });
    extra
}

/// The equipment a `duplicate_archetypes` copy derives: for the copy `small_plane_cas_airframe` of
/// `small_plane_airframe`, each `small_plane_airframe_<n>` gives `small_plane_cas_airframe_<n>`.
/// A copy with `only_duplicate_archetype = yes` derives nothing. Exact case, as the game matches.
fn derived_equipment(workspace: &Workspace) -> HashSet<String> {
    let files: Vec<usize> =
        workspace.loaded_files().filter(|(_, f)| under(&f.relative, "common/units/equipment/") && !f.relative[23..].contains('/')).map(|(i, _)| i).collect();
    let docs = parse_files(workspace, &files, None);
    let mut children: Vec<(String, String)> = Vec::new();
    let mut copies: Vec<(String, String)> = Vec::new();
    for (_, doc) in &docs {
        for (container, list) in [("equipments", &mut children), ("duplicate_archetypes", &mut copies)] {
            for block in doc.root.entries().filter(|e| doc.key(e) == container).filter_map(|e| e.value.as_block()) {
                for e in block.entries() {
                    let Some(b) = e.value.as_block() else { continue };
                    let only = scalar(doc, b, "only_duplicate_archetype").is_some_and(|(v, _)| v == "yes");
                    if let Some((archetype, _)) = scalar(doc, b, "archetype").filter(|_| !only) {
                        list.push((doc.key(e).into_owned(), archetype));
                    }
                }
            }
        }
    }
    let mut out = HashSet::new();
    for (copy, archetype) in &copies {
        for (child, _) in children.iter().filter(|(_, a)| a == archetype) {
            if let Some(rest) = child.strip_prefix(archetype.as_str()) {
                out.insert(format!("{copy}{rest}").to_ascii_lowercase());
            }
        }
    }
    out
}

/// Module categories exist only through the modules that name them.
fn module_categories(workspace: &Workspace) -> HashSet<String> {
    let files: Vec<usize> = workspace.loaded_files().filter(|(_, f)| under(&f.relative, "common/units/equipment/modules/")).map(|(i, _)| i).collect();
    parse_files(workspace, &files, None)
        .iter()
        .flat_map(|(_, doc)| {
            doc.root
                .entries()
                .filter(|e| doc.key(e) == "equipment_modules")
                .filter_map(|e| e.value.as_block())
                .flat_map(|b| b.entries())
                .filter_map(|m| m.value.as_block().and_then(|b| scalar(doc, b, "category")))
                .map(|(category, _)| category.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The `name` of every `key` block in history, events and common files, lower case.
fn named_anywhere(workspace: &Workspace, key: &str) -> HashSet<String> {
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            p.ends_with(".txt") && VARIANT_SOURCES.iter().any(|s| p.starts_with(s.folder))
        })
        .map(|(i, _)| i)
        .collect();
    parse_files(workspace, &files, Some(key))
        .iter()
        .flat_map(|(_, doc)| {
            let mut found = Vec::new();
            named_blocks(doc, &doc.root, key, &mut found);
            found.into_iter().filter_map(|e| e.value.as_block().and_then(|b| scalar(doc, b, "name"))).map(|(n, _)| n.to_ascii_lowercase()).collect::<Vec<_>>()
        })
        .collect()
}

/// The groups of `common/units/names_divisions`, which templates pick with `division_names_group`.
fn name_groups(workspace: &Workspace) -> HashSet<String> {
    let files: Vec<usize> = workspace.loaded_files().filter(|(_, f)| under(&f.relative, "common/units/names_divisions/")).map(|(i, _)| i).collect();
    parse_files(workspace, &files, None)
        .iter()
        .flat_map(|(_, doc)| doc.root.entries().filter(|e| e.value.as_block().is_some()).map(|e| doc.key(e).to_ascii_lowercase()).collect::<Vec<_>>())
        .collect()
}

/// The province ids of `map/definition.csv`, from the last layer that has one. Empty when no layer
/// has it, and then no province is judged.
fn provinces(workspace: &Workspace) -> HashSet<String> {
    let Some(text) = workspace.layers.iter().rev().find_map(|l| fs::read(l.path.join("map/definition.csv")).ok()) else { return HashSet::new() };
    String::from_utf8_lossy(&text)
        .lines()
        .filter_map(|line| line.split(';').next())
        .filter(|id| id.trim().parse::<u32>().is_ok_and(|n| n > 0))
        .map(|id| id.trim().to_owned())
        .collect()
}

/// The game's division designer: five columns of five regiments, one column of five supports.
pub(super) const DEFAULT_GRID: [i64; 4] = [5, 5, 1, 5];

/// The designer's grid from `NMilitary.MAX_DIVISION_{BRIGADE,SUPPORT}_{WIDTH,HEIGHT}` in every
/// layer's `common/defines/*.lua`, read in load order so the last value wins.
pub(super) fn grid(workspace: &Workspace) -> [i64; 4] {
    const NAMES: [&str; 4] = ["MAX_DIVISION_BRIGADE_WIDTH", "MAX_DIVISION_BRIGADE_HEIGHT", "MAX_DIVISION_SUPPORT_WIDTH", "MAX_DIVISION_SUPPORT_HEIGHT"];
    let mut grid = DEFAULT_GRID;
    for layer in &workspace.layers {
        let Ok(entries) = fs::read_dir(layer.path.join("common/defines")) else { continue };
        let mut files: Vec<_> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lua"))).collect();
        files.sort();
        for file in files {
            let Ok(bytes) = fs::read(&file) else { continue };
            for line in String::from_utf8_lossy(&bytes).lines() {
                let code = line.split("--").next().unwrap_or("");
                for (slot, name) in NAMES.iter().enumerate() {
                    let Some(at) = code.find(name) else { continue };
                    let rest = code[at + name.len()..].trim_start();
                    // Not `MAX_DIVISION_BRIGADE_WIDTH_HQ` or similar longer names.
                    let Some(value) = rest.strip_prefix('=') else { continue };
                    if let Ok(n) = value.trim().trim_end_matches(',').trim().parse::<i64>() {
                        grid[slot] = n;
                    }
                }
            }
        }
    }
    grid
}

fn under(relative: &str, folder: &str) -> bool {
    let p = relative.to_ascii_lowercase();
    p.starts_with(folder) && p.ends_with(".txt")
}

impl Checker<'_> {
    fn known_or_unjudged(&self, target: &'static str) -> bool {
        // Without a province list, provinces are not judged.
        target == "province" && self.state.names.get("province").is_none_or(|p| p.is_empty())
    }

    fn refer_unit(&self, out: &mut Found, field: &str, target: &'static str, value: &str, line: u32) {
        if self.known_or_unjudged(target) {
            return;
        }
        self.refer(out, field, target, value, line);
    }

    pub(super) fn sub_unit(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        Self::text(out, id, line);
        Self::text(out, &format!("{id}_desc"), line);
        for need in block.entries().filter(|e| doc.key(e) == "need").filter_map(|e| e.value.as_block()) {
            for e in need.entries() {
                self.refer(out, "need", "equipment", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
            }
        }
        self.refer_all(out, doc, block, "essential", "essential", "equipment");
        self.refer_all(out, doc, block, "transport", "transport", "equipment");
        self.refer_all(out, doc, block, "categories", "categories", "unit_category");
    }

    pub(super) fn equipment(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        Self::text(out, id, line);
        self.refer_all(out, doc, block, "archetype", "archetype", "equipment");
        self.refer_all(out, doc, block, "parent", "parent", "equipment");
        self.refer_all(out, doc, block, "upgrades", "upgrades", "upgrade");
        for resources in block.entries().filter(|e| doc.key(e) == "resources").filter_map(|e| e.value.as_block()) {
            for e in resources.entries() {
                self.refer(out, "resources", "resource", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
            }
        }
        let mut slots: HashSet<String> = HashSet::new();
        for module_slots in block.entries().filter(|e| doc.key(e) == "module_slots").filter_map(|e| e.value.as_block()) {
            for slot in module_slots.entries() {
                let name = doc.key(slot).into_owned();
                let l = ideas::line_at(doc, doc.token(slot.key).start);
                Self::part(out, "module_slot", &name, l);
                match slot.value.as_block() {
                    Some(b) => {
                        self.refer_all(out, doc, b, "allowed_module_categories", &format!("module_slots.{name}.allowed_module_categories"), "module_category")
                    }
                    // `<slot> = inherit` takes the parent's slot; `<slot> = <earlier slot>` copies one.
                    None => {
                        for (value, vl) in values(doc, slot) {
                            if value != "inherit" && !computed(&value) {
                                let known = slots.contains(&value);
                                if !known {
                                    out.problems.push(problem(
                                        "SYSTEM_REFERENCE_UNKNOWN",
                                        format!("the slot `{name}` copies `{value}`, which no earlier slot of this equipment is"),
                                        vl,
                                    ));
                                }
                                out.references.push(super::Reference { field: format!("module_slots.{name}"), target: "module_slot", value, known, line: vl });
                            }
                        }
                    }
                }
                slots.insert(name);
            }
        }
        for defaults in block.entries().filter(|e| doc.key(e) == "default_modules").filter_map(|e| e.value.as_block()) {
            for slot in defaults.entries() {
                for (module, l) in values(doc, slot) {
                    if module != "empty" && module != "inherit" {
                        self.refer(out, &format!("default_modules.{}", doc.key(slot)), "equipment_module", &module, l);
                    }
                }
            }
        }
        for limit in block.entries().filter(|e| doc.key(e) == "module_count_limit").filter_map(|e| e.value.as_block()) {
            self.refer_all(out, doc, limit, "category", "module_count_limit.category", "module_category");
        }
    }

    pub(super) fn module(&self, doc: &Document, id: &str, block: &Block, line: u32, out: &mut Found) {
        Self::text(out, id, line);
        self.refer_all(out, doc, block, "forbid_module_categories", "forbid_module_categories", "module_category");
    }

    pub(super) fn variant(&self, doc: &Document, block: &Block, out: &mut Found) {
        self.refer_all(out, doc, block, "type", "type", "equipment");
        for modules in block.entries().filter(|e| doc.key(e) == "modules").filter_map(|e| e.value.as_block()) {
            for slot in modules.entries() {
                for (module, l) in values(doc, slot) {
                    if module != "empty" {
                        self.refer(out, &format!("modules.{}", doc.key(slot)), "equipment_module", &module, l);
                    }
                }
            }
        }
        for upgrades in block.entries().filter(|e| doc.key(e) == "upgrades").filter_map(|e| e.value.as_block()) {
            for e in upgrades.entries() {
                self.refer(out, "upgrades", "upgrade", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
            }
        }
    }

    /// An order of battle: its templates, divisions, fleets and air wings.
    pub(super) fn oob(&self, doc: &Document, _id: &str, out: &mut Found) {
        let mut templates: HashMap<String, u32> = HashMap::new();
        for entry in doc.root.entries() {
            let Some(block) = entry.value.as_block() else { continue };
            let line = ideas::line_at(doc, doc.token(entry.key).start);
            match doc.key(entry).as_ref() {
                "division_template" => self.template(doc, block, line, &mut templates, out),
                "units" => {
                    for unit in block.entries() {
                        let Some(b) = unit.value.as_block() else { continue };
                        let l = ideas::line_at(doc, doc.token(unit.key).start);
                        match doc.key(unit).as_ref() {
                            "division" => self.division(doc, b, out),
                            "fleet" | "navy" => self.fleet(doc, b, l, out),
                            _ => {}
                        }
                    }
                }
                "air_wings" => {
                    for wing in block.entries() {
                        let l = ideas::line_at(doc, doc.token(wing.key).start);
                        let key = super::unquote(&doc.key(wing));
                        // A state id, or the name of the carrier the wings fly from.
                        let target = if key.parse::<u32>().is_ok() { "state" } else { "ship" };
                        self.refer(out, "air_wings", target, &key, l);
                        if let Some(b) = wing.value.as_block() {
                            self.equipment_amounts(doc, b, "air_wings", out);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn template(&self, doc: &Document, block: &Block, line: u32, templates: &mut HashMap<String, u32>, out: &mut Found) {
        if let Some((name, l)) = scalar(doc, block, "name") {
            Self::part(out, "template", &name, line);
            if templates.insert(name.clone(), l).is_some() {
                out.problems.push(problem(
                    "SYSTEM_DUPLICATE_TOKEN",
                    format!("two division templates in this file are named `{name}`, and divisions find their template by name"),
                    l,
                ));
            }
        }
        self.refer_all(out, doc, block, "division_names_group", "division_names_group", "division_names_group");
        // The designer's grid, from the defines.
        let [rw, rh, sw, sh] = self.state.grid;
        for (section, width, height) in [("regiments", rw, rh), ("support", sw, sh)] {
            let (max_x, max_y) = (width - 1, height - 1);
            let mut taken: HashMap<(i64, i64), String> = HashMap::new();
            for units in block.entries().filter(|e| doc.key(e) == section).filter_map(|e| e.value.as_block()) {
                for unit in units.entries() {
                    let name = doc.key(unit).into_owned();
                    let l = ideas::line_at(doc, doc.token(unit.key).start);
                    self.refer(out, section, "sub_unit", &name, l);
                    let Some(b) = unit.value.as_block() else { continue };
                    let at = |key| scalar(doc, b, key).and_then(|(v, _)| v.parse::<i64>().ok()).unwrap_or(0);
                    let (x, y) = (at("x"), at("y"));
                    if !(0..=max_x).contains(&x) || !(0..=max_y).contains(&y) {
                        out.problems.push(problem(
                            "UNIT_TEMPLATE_SLOT_INVALID",
                            format!("`{name}` sits at x = {x}, y = {y}, outside the {section} grid (x 0 to {max_x}, y 0 to {max_y}, from the `MAX_DIVISION_` defines)"),
                            l,
                        ));
                    } else if let Some(other) = taken.insert((x, y), name.clone()) {
                        out.problems.push(problem(
                            "UNIT_TEMPLATE_SLOT_INVALID",
                            format!("`{name}` and `{other}` both sit at x = {x}, y = {y} in {section}"),
                            l,
                        ));
                    }
                }
            }
        }
    }

    fn division(&self, doc: &Document, block: &Block, out: &mut Found) {
        self.refer_all(out, doc, block, "division_template", "division.division_template", "division_template");
        if let Some((location, l)) = scalar(doc, block, "location") {
            self.refer_unit(out, "division.location", "province", &location, l);
        }
        for variants in block.entries().filter(|e| doc.key(e) == "force_equipment_variants").filter_map(|e| e.value.as_block()) {
            self.equipment_amounts(doc, variants, "division.force_equipment_variants", out);
        }
    }

    fn fleet(&self, doc: &Document, block: &Block, line: u32, out: &mut Found) {
        if let Some((name, _)) = scalar(doc, block, "name") {
            Self::part(out, "fleet", &name, line);
        }
        for key in ["naval_base", "base", "location"] {
            if let Some((province, l)) = scalar(doc, block, key) {
                self.refer_unit(out, &format!("fleet.{key}"), "province", &province, l);
            }
        }
        for entry in block.entries() {
            let Some(b) = entry.value.as_block() else { continue };
            match doc.key(entry).as_ref() {
                "task_force" => {
                    if let Some((province, l)) = scalar(doc, b, "location") {
                        self.refer_unit(out, "task_force.location", "province", &province, l);
                    }
                    for ship in b.entries().filter(|e| doc.key(e) == "ship").filter_map(|e| e.value.as_block()) {
                        self.ship(doc, ship, out);
                    }
                }
                "ship" => self.ship(doc, b, out),
                _ => {}
            }
        }
    }

    fn ship(&self, doc: &Document, block: &Block, out: &mut Found) {
        self.refer_all(out, doc, block, "definition", "ship.definition", "sub_unit");
        for equipment in block.entries().filter(|e| doc.key(e) == "equipment").filter_map(|e| e.value.as_block()) {
            self.equipment_amounts(doc, equipment, "ship.equipment", out);
        }
    }

    /// `<equipment> = { amount = … owner = … version_name = … }` entries.
    fn equipment_amounts(&self, doc: &Document, block: &Block, field: &str, out: &mut Found) {
        for e in block.entries() {
            let Some(b) = e.value.as_block() else { continue };
            // An air wing's `ace` block is a pilot, not equipment.
            if doc.key(e) == "ace" {
                continue;
            }
            self.refer(out, field, "equipment", &doc.key(e), ideas::line_at(doc, doc.token(e.key).start));
            if let Some((version, l)) = scalar(doc, b, "version_name") {
                self.refer(out, &format!("{field}.version_name"), "variant", &version, l);
            }
        }
    }
}

/// References to orders of battle that no `history/units` file is, in the checked layer's files:
/// (name, file, problem).
pub(super) fn missing_oobs(state: &State) -> Vec<(String, usize, Problem)> {
    let workspace = &state.loaded.workspace;
    let Some(target) = workspace.target_layer() else { return Vec::new() };
    let known = state.names.get("oob").cloned().unwrap_or_default();
    let files: Vec<usize> = workspace
        .loaded_files()
        .filter(|(_, f)| {
            let p = f.relative.to_ascii_lowercase();
            f.layer == target && p.ends_with(".txt") && ["history/", "events/", "common/"].iter().any(|folder| p.starts_with(folder))
        })
        .map(|(i, _)| i)
        .collect();
    parse_files(workspace, &files, Some("oob"))
        .par_iter()
        .flat_map_iter(|(file, doc)| {
            let mut out = Vec::new();
            oob_references(doc, &doc.root, &mut |key, value, line| {
                if !computed(&value) && !known.contains(&value.to_ascii_lowercase()) {
                    out.push((
                        value.clone(),
                        *file,
                        problem(
                            "UNIT_OOB_MISSING",
                            format!("`{key}` loads `{value}`, but no loaded history/units file is named `{value}.txt`, so nothing is created"),
                            line,
                        ),
                    ));
                }
            });
            out
        })
        .collect()
}

fn oob_references(doc: &Document, block: &Block, found: &mut impl FnMut(&str, String, u32)) {
    for entry in block.entries() {
        let key = doc.key(entry);
        match &entry.value {
            hoi4_syntax::Value::Block(inner) => oob_references(doc, inner, found),
            hoi4_syntax::Value::Scalar(t) if OOB_KEYS.contains(&key.as_ref()) => {
                found(&key, super::unquote(&doc.text(*t)), ideas::line_at(doc, doc.token(*t).start));
            }
            _ => {}
        }
    }
}
