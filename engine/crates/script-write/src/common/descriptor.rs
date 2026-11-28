//! The kind descriptors of `common.block_write` (D-152: a new kind is a descriptor, not new code).
//!
//! New in the tutorial-path packet T3; adapted from no TypeScript file. A descriptor is static data:
//! the folder the kind's files live in, the wrapper block the definitions sit in (if any), how the
//! id is merged, the rule a name must pass, and the one check function that reads the written
//! definition. The write path in `mod.rs` knows none of the kinds.

use super::checks::{self, CheckFn};

/// How an add treats an id the container already has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merge {
    /// One block per id: add refuses an existing id, replace swaps the whole block, remove drops it.
    Definition,
    /// The game merges blocks of one key across files: add appends the body's entries to the key's
    /// block (creating the key), replace swaps the key's body or one child (`blockIndex`), remove
    /// drops the key or one child.
    KeyedChildren,
}

/// What a name must be before a write may use it as an id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameRule {
    /// Any valid identifier.
    Identifier,
    /// A name from the list the caller read out of the game's documentation, a periodic name
    /// (`on_daily_TAG`, `on_weekly_TAG`, `on_monthly_TAG`), or one the file already has.
    DocumentedOrPattern,
}

pub struct KindDescriptor {
    pub kind: &'static str,
    /// The folder, relative to the workspace, every file of the kind lives under.
    pub folder: &'static str,
    /// The block every definition sits in, `None` for definitions at the top level of the file.
    pub wrapper: Option<&'static str>,
    pub merge: Merge,
    pub name_rule: NameRule,
    /// What the id is called in messages.
    pub noun: &'static str,
    pub check: CheckFn,
}

pub const DESCRIPTORS: &[KindDescriptor] = &[
    KindDescriptor {
        kind: "bop",
        folder: "common/bop",
        wrapper: None,
        merge: Merge::Definition,
        name_rule: NameRule::Identifier,
        noun: "balance of power",
        check: checks::bop,
    },
    KindDescriptor {
        kind: "ai_strategy",
        folder: "common/ai_strategy",
        wrapper: None,
        merge: Merge::Definition,
        name_rule: NameRule::Identifier,
        noun: "AI strategy",
        check: checks::ai_strategy,
    },
    KindDescriptor {
        kind: "ai_strategy_plan",
        folder: "common/ai_strategy_plans",
        wrapper: None,
        merge: Merge::Definition,
        name_rule: NameRule::Identifier,
        noun: "AI strategy plan",
        check: checks::ai_strategy_plan,
    },
    KindDescriptor {
        kind: "on_action",
        folder: "common/on_actions",
        wrapper: Some("on_actions"),
        merge: Merge::KeyedChildren,
        name_rule: NameRule::DocumentedOrPattern,
        noun: "on_action",
        check: checks::none,
    },
];

pub fn descriptor(kind: &str) -> Option<&'static KindDescriptor> {
    DESCRIPTORS.iter().find(|d| d.kind == kind)
}

/// The kinds, in the order of the table.
pub fn kinds() -> Vec<&'static str> {
    DESCRIPTORS.iter().map(|d| d.kind).collect()
}
