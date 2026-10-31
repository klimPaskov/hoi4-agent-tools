//! Symbol kinds and the index of definitions in loaded files.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    ScriptedEffect,
    ScriptedTrigger,
    Event,
    EventNamespace,
    Focus,
    FocusTree,
    ContinuousFocus,
    Idea,
    Decision,
    DecisionCategory,
    Character,
    CountryLeaderTrait,
    UnitLeaderTrait,
    OpinionModifier,
    DynamicModifier,
    StaticModifier,
    Technology,
    Sprite,
    LocalisationKey,
    ScriptedLocalisation,
    CountryTag,
    State,
    Ideology,
    OnAction,
    ScriptedGui,
    SubUnit,
    Building,
    Terrain,
    Equipment,
    Resource,
    CombatTactic,
}

impl Kind {
    pub const ALL: &'static [Kind] = &[
        Kind::ScriptedEffect,
        Kind::ScriptedTrigger,
        Kind::Event,
        Kind::EventNamespace,
        Kind::Focus,
        Kind::FocusTree,
        Kind::ContinuousFocus,
        Kind::Idea,
        Kind::Decision,
        Kind::DecisionCategory,
        Kind::Character,
        Kind::CountryLeaderTrait,
        Kind::UnitLeaderTrait,
        Kind::OpinionModifier,
        Kind::DynamicModifier,
        Kind::StaticModifier,
        Kind::Technology,
        Kind::Sprite,
        Kind::LocalisationKey,
        Kind::ScriptedLocalisation,
        Kind::CountryTag,
        Kind::State,
        Kind::Ideology,
        Kind::OnAction,
        Kind::ScriptedGui,
        Kind::SubUnit,
        Kind::Building,
        Kind::Terrain,
        Kind::Equipment,
        Kind::Resource,
        Kind::CombatTactic,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::ScriptedEffect => "scripted_effect",
            Kind::ScriptedTrigger => "scripted_trigger",
            Kind::Event => "event",
            Kind::EventNamespace => "event_namespace",
            Kind::Focus => "focus",
            Kind::FocusTree => "focus_tree",
            Kind::ContinuousFocus => "continuous_focus",
            Kind::Idea => "idea",
            Kind::Decision => "decision",
            Kind::DecisionCategory => "decision_category",
            Kind::Character => "character",
            Kind::CountryLeaderTrait => "country_leader_trait",
            Kind::UnitLeaderTrait => "unit_leader_trait",
            Kind::OpinionModifier => "opinion_modifier",
            Kind::DynamicModifier => "dynamic_modifier",
            Kind::StaticModifier => "static_modifier",
            Kind::Technology => "technology",
            Kind::Sprite => "sprite",
            Kind::LocalisationKey => "localisation_key",
            Kind::ScriptedLocalisation => "scripted_localisation",
            Kind::CountryTag => "country_tag",
            Kind::State => "state",
            Kind::Ideology => "ideology",
            Kind::OnAction => "on_action",
            Kind::ScriptedGui => "scripted_gui",
            Kind::SubUnit => "sub_unit",
            Kind::Building => "building",
            Kind::Terrain => "terrain",
            Kind::Equipment => "equipment",
            Kind::Resource => "resource",
            Kind::CombatTactic => "combat_tactic",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Definition {
    pub kind: Kind,
    pub name: String,
    pub file: usize,
    pub start: u32,
    pub line: u32,
}

#[derive(Default)]
pub struct SymbolIndex {
    by_kind: HashMap<Kind, HashMap<String, Vec<Definition>>>,
    /// Lower-case name to the defined spellings, for case-mismatch suggestions.
    folded: HashMap<Kind, HashMap<String, Vec<String>>>,
}

impl SymbolIndex {
    pub fn insert(&mut self, def: Definition) {
        self.folded.entry(def.kind).or_default().entry(def.name.to_ascii_lowercase()).or_default().push(def.name.clone());
        self.by_kind.entry(def.kind).or_default().entry(def.name.clone()).or_default().push(def);
    }

    pub fn contains(&self, kind: Kind, name: &str) -> bool {
        self.by_kind.get(&kind).is_some_and(|m| m.contains_key(name))
    }

    /// True when a definition matches ignoring ASCII case.
    pub fn contains_folded(&self, kind: Kind, name: &str) -> bool {
        self.folded.get(&kind).is_some_and(|m| m.contains_key(&name.to_ascii_lowercase()))
    }

    pub fn get(&self, kind: Kind, name: &str) -> &[Definition] {
        self.by_kind.get(&kind).and_then(|m| m.get(name)).map_or(&[], Vec::as_slice)
    }

    pub fn count(&self, kind: Kind) -> usize {
        self.by_kind.get(&kind).map_or(0, HashMap::len)
    }

    pub fn names(&self, kind: Kind) -> impl Iterator<Item = &String> {
        self.by_kind.get(&kind).into_iter().flat_map(|m| m.keys())
    }

    pub fn definitions(&self, kind: Kind) -> impl Iterator<Item = (&String, &Vec<Definition>)> {
        self.by_kind.get(&kind).into_iter().flat_map(|m| m.iter())
    }

    /// A defined name that differs only in case, or the single defined name one edit away
    /// (names of four or more characters, as in Hagane's typo rule). Localisation keys and
    /// sprites get only the case check: their name spaces are too large for a useful guess.
    pub fn suggest(&self, kind: Kind, name: &str) -> Option<String> {
        if let Some(spellings) = self.folded.get(&kind).and_then(|m| m.get(&name.to_ascii_lowercase()))
            && let Some(first) = spellings.iter().find(|s| s.as_str() != name)
        {
            return Some(first.clone());
        }
        if name.len() < 4 || matches!(kind, Kind::LocalisationKey | Kind::Sprite) {
            return None;
        }
        let mut found: Option<&String> = None;
        for known in self.names(kind) {
            if within_one_edit(name, known) {
                if found.is_some() {
                    return None;
                }
                found = Some(known);
            }
        }
        found.cloned()
    }

    pub fn counts(&self) -> BTreeMap<&'static str, usize> {
        Kind::ALL.iter().map(|k| (k.as_str(), self.count(*k))).collect()
    }
}

/// True when `a` and `b` differ by exactly one inserted, deleted or substituted byte.
pub fn within_one_edit(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    prefix + suffix + 1 >= a.len().max(b.len())
}

pub fn levenshtein(left: &[char], right: &[char]) -> usize {
    if left == right {
        return 0;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (row, l) in left.iter().enumerate() {
        let mut current = Vec::with_capacity(right.len() + 1);
        current.push(row + 1);
        for (column, r) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(l != r);
            current.push(substitution.min(previous[column + 1] + 1).min(current[column] + 1));
        }
        previous = current;
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(kind: Kind, name: &str) -> Definition {
        Definition { kind, name: name.into(), file: 0, start: 0, line: 1 }
    }

    #[test]
    fn suggests_case_and_single_edit_matches() {
        let mut index = SymbolIndex::default();
        index.insert(def(Kind::Focus, "GER_rearm"));
        index.insert(def(Kind::Focus, "GER_reform"));
        index.insert(def(Kind::Idea, "abc"));
        assert_eq!(index.suggest(Kind::Focus, "ger_rearm").as_deref(), Some("GER_rearm"));
        assert_eq!(index.suggest(Kind::Focus, "GER_rearn").as_deref(), Some("GER_rearm"));
        assert_eq!(index.suggest(Kind::Focus, "GER_xxxxx"), None);
        assert_eq!(index.suggest(Kind::Idea, "abd"), None, "short names get no edit-distance guess");
    }

    #[test]
    fn one_edit_check_matches_levenshtein() {
        let words = ["abcd", "abce", "abd", "abcde", "bacd", "abcd", "xbcd", "aabb", "abbb", ""];
        for a in words {
            for b in words {
                let d = levenshtein(&a.chars().collect::<Vec<_>>(), &b.chars().collect::<Vec<_>>());
                assert_eq!(within_one_edit(a, b), d == 1, "{a} {b}");
            }
        }
    }

    #[test]
    fn levenshtein_matches_known_values() {
        let d = |a: &str, b: &str| levenshtein(&a.chars().collect::<Vec<_>>(), &b.chars().collect::<Vec<_>>());
        assert_eq!(d("kitten", "sitting"), 3);
        assert_eq!(d("", "abc"), 3);
        assert_eq!(d("same", "same"), 0);
    }
}
