//! Sprite index, content trace and findings on the synthetic fixtures in `fixtures/sprites`, plus
//! one run on the installed game when there is one. Textures are generated headers only.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::sprite_audit::{Allowlist, SpriteReport};
use hoi4_engine::sprite_trace::{Family, SpriteUse, TraceOptions, trace};
use hoi4_engine::sprites::{SpriteIndex, SpriteKind};
use hoi4_engine::{Workspace, WorkspaceOptions};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sprites")
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn dds(w: u32, h: u32, mips: u32, fourcc: &[u8; 4], dxgi: Option<u32>) -> Vec<u8> {
    let mut b = vec![0u8; if dxgi.is_some() { 148 } else { 128 }];
    b[0..4].copy_from_slice(b"DDS ");
    b[4..8].copy_from_slice(&124u32.to_le_bytes());
    b[12..16].copy_from_slice(&h.to_le_bytes());
    b[16..20].copy_from_slice(&w.to_le_bytes());
    b[28..32].copy_from_slice(&mips.to_le_bytes());
    b[76..80].copy_from_slice(&32u32.to_le_bytes());
    b[80..84].copy_from_slice(&4u32.to_le_bytes());
    b[84..88].copy_from_slice(fourcc);
    if let Some(d) = dxgi {
        b[128..132].copy_from_slice(&d.to_le_bytes());
    }
    b
}

fn tga(w: u16, h: u16) -> Vec<u8> {
    let mut b = vec![0u8; 18];
    b[2] = 2;
    b[12..14].copy_from_slice(&w.to_le_bytes());
    b[14..16].copy_from_slice(&h.to_le_bytes());
    b[16] = 32;
    b[17] = 0x28;
    b
}

fn put(root: &Path, relative: &str, bytes: Vec<u8>) {
    let full = root.join(relative);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, bytes).unwrap();
}

struct Fixture {
    game: PathBuf,
    mod_dir: PathBuf,
}

/// Copies the fixture tree and writes its textures. `replace_path` goes into the mod descriptor.
fn fixture(name: &str, replace_path: Option<&str>) -> Fixture {
    let base = Path::new(env!("CARGO_TARGET_TMPDIR")).join("sprites").join(name);
    let _ = fs::remove_dir_all(&base);
    let game = base.join("game");
    let mod_dir = base.join("mod");
    copy_dir(&fixtures().join("game"), &game);
    copy_dir(&fixtures().join("mod"), &mod_dir);
    let dxt = |w, h| dds(w, h, 1, b"DXT5", None);
    for (path, w, h) in [
        ("gfx/interface/goals/alpha.dds", 100, 88),
        ("gfx/interface/goals/beta.dds", 100, 88),
        ("gfx/interface/goals/cond_a.dds", 100, 88),
        ("gfx/interface/goals/cond_b.dds", 100, 88),
        ("gfx/Interface/shared.dds", 100, 88),
        ("gfx/interface/ideas/spirit_one.dds", 60, 68),
        ("gfx/interface/ideas/fallback.dds", 60, 68),
        ("gfx/interface/ideas/concern_one.dds", 64, 64),
        ("gfx/interface/ideas/adv_one.dds", 65, 67),
        ("gfx/interface/ideas/adv_token.dds", 65, 67),
        ("gfx/interface/ideas/officer_one.dds", 45, 45),
        ("gfx/interface/decisions/alpha.dds", 33, 32),
        ("gfx/interface/decisions/shared_tex.dds", 33, 32),
        ("gfx/interface/decisions/dyn.dds", 60, 68),
        ("gfx/interface/decisions/cat.dds", 52, 40),
        ("gfx/interface/decisions/pic.dds", 114, 101),
        ("gfx/event_pictures/report_one.dds", 210, 176),
        ("gfx/event_pictures/news_one.dds", 397, 153),
        ("gfx/leaders/leader.dds", 156, 210),
        ("gfx/leaders/small.dds", 65, 67),
        ("gfx/leaders/cmd.dds", 156, 210),
        ("gfx/leaders/direct.dds", 156, 210),
        ("gfx/Interface/Case.dds", 40, 40),
    ] {
        put(&game, path, dxt(w, h));
    }
    put(&game, "gfx/interface/icon.tga", tga(32, 32));
    put(&game, "gfx/interface/anim.dds", dds(256, 64, 5, b"DXT1", None));
    put(&game, "gfx/interface/tile.dds", dds(64, 64, 0, b"DX10", Some(98)));
    put(&mod_dir, "gfx/interface/goals/alpha_mod.dds", dxt(90, 80));
    put(&mod_dir, "gfx/interface/goals/mod_new.dds", dxt(100, 88));
    put(&mod_dir, "gfx/interface/goals/beta.dds", dxt(77, 66));
    if let Some(path) = replace_path {
        fs::write(mod_dir.join("descriptor.mod"), format!("name=\"spritemod\"\nreplace_path=\"{path}\"\n")).unwrap();
    }
    Fixture { game, mod_dir }
}

fn load(f: &Fixture, with_mod: bool) -> Workspace {
    Workspace::load(&WorkspaceOptions { game: Some(f.game.clone()), include_dlc: true, dependencies: Vec::new(), target: with_mod.then(|| f.mod_dir.clone()) })
}

fn find<'a>(uses: &'a [SpriteUse], content: &str, subject: &str) -> Vec<&'a SpriteUse> {
    uses.iter().filter(|u| u.content_type == content && u.subject.as_deref() == Some(subject)).collect()
}

fn one<'a>(uses: &'a [SpriteUse], content: &str, subject: &str) -> &'a SpriteUse {
    let list = find(uses, content, subject);
    assert_eq!(list.len(), 1, "{content} {subject}: {list:?}");
    list[0]
}

#[test]
fn indexes_every_block_type_and_reads_texture_headers() {
    let f = fixture("index", None);
    let ws = load(&f, false);
    let index = SpriteIndex::build(&ws);
    assert_eq!(index.len(), 31);
    let shine = index.get("gfx_goal_ALPHA_shine").unwrap();
    assert_eq!(shine.block_type, "SpriteType");
    assert_eq!(shine.animation_blocks, 1);
    assert_eq!(shine.effect_file.as_deref(), Some("gfx/FX/buttonstate_onlydisable.lua"));
    assert_eq!(shine.frames, 1);
    let anim = index.get("GFX_anim").unwrap();
    assert_eq!(
        (anim.kind, anim.frames, anim.legacy_lazy_load, anim.load_type.as_deref()),
        (SpriteKind::FrameAnimatedSpriteType, 4, Some(false), Some("INGAME"))
    );
    assert_eq!(index.get("GFX_tile").unwrap().kind, SpriteKind::CorneredTileSpriteType);
    assert_eq!(index.get("GFX_text_only").unwrap().kind, SpriteKind::TextSpriteType);
    assert!(index.get("GFX_text_only").unwrap().texturefile.is_none());
    assert_eq!(index.get("GFX_goal_beta").unwrap().texturefile.as_deref(), Some("gfx/interface/goals/beta.dds"));
    assert!(index.get("GFX_goal_beta").unwrap().line > 0);

    let header = |name: &str| {
        let def = index.get(name).unwrap();
        index.texture_of(def).unwrap().header.clone().unwrap_or_else(|| panic!("no header for {name}"))
    };
    let alpha = header("GFX_goal_alpha");
    assert_eq!((alpha.width, alpha.height, alpha.pixel_format.as_str(), alpha.mip_count), (100, 88, "DXT5", Some(1)));
    let anim = header("GFX_anim");
    assert_eq!((anim.width, anim.height, anim.mip_count, anim.fourcc.as_deref()), (256, 64, Some(5), Some("DXT1")));
    let tile = header("GFX_tile");
    assert_eq!((tile.pixel_format.as_str(), tile.dxgi_format), ("BC7_UNORM", Some(98)));
    let icon = header("GFX_tga_icon");
    assert_eq!((icon.container, icon.width, icon.height, icon.bits, icon.origin), ("tga", 32, 32, Some(32), Some("top_left")));
}

#[test]
fn resolves_textures_without_regard_to_case_and_reports_missing_ones() {
    let f = fixture("case", None);
    let index = SpriteIndex::build(&load(&f, false));
    // The sprite writes `GFX/INTERFACE/Case.DDS`; the file is `gfx/Interface/Case.dds`.
    let case = index.texture_of(index.get("GFX_case_mix").unwrap()).unwrap();
    assert!(case.exists, "{case:?}");
    let relative = case.relative.as_deref().unwrap();
    assert!(relative.eq_ignore_ascii_case("gfx/Interface/Case.dds") && relative.ends_with("/Case.dds"), "{relative}");
    // The directory is `Interface` but the sprite says `interface`.
    assert!(index.texture_of(index.get("GFX_shared").unwrap()).unwrap().exists);
    let missing = index.texture_of(index.get("GFX_missing_tex").unwrap()).unwrap();
    assert!(!missing.exists && missing.header.is_none());
    assert_eq!(index.by_texture("GFX\\Interface\\Goals\\ALPHA.dds").len(), 2);
    assert!(index.texture("gfx/interface/ideas/spirit_one.DDS").exists);
}

#[test]
fn a_mod_overrides_sprites_and_textures() {
    let f = fixture("override", None);
    let ws = load(&f, true);
    let index = SpriteIndex::build(&ws);
    let alpha = index.get("GFX_goal_alpha").unwrap();
    assert_eq!(alpha.layer, "spritemod");
    assert_eq!(index.definitions_of("GFX_goal_alpha").len(), 2);
    assert!(!index.definitions_of("GFX_goal_alpha")[0].effective);
    let tex = index.texture_of(alpha).unwrap();
    assert_eq!((tex.layer.as_deref(), tex.header.as_ref().unwrap().width), (Some("spritemod"), 90));
    // The game's sprite keeps its own path, but the mod's file of the same path wins.
    let beta = index.texture_of(index.get("GFX_goal_beta").unwrap()).unwrap();
    assert_eq!((beta.layer.as_deref(), beta.header.as_ref().unwrap().width), (Some("spritemod"), 77));
    let gamma = index.texture_of(index.get("GFX_goal_cond_a").unwrap()).unwrap();
    assert_eq!(gamma.layer.as_deref(), Some("game"));
}

#[test]
fn replace_path_hides_the_games_textures() {
    let f = fixture("replace", Some("gfx/interface/goals"));
    let index = SpriteIndex::build(&load(&f, true));
    assert!(!index.texture_of(index.get("GFX_goal_cond_a").unwrap()).unwrap().exists);
    assert!(index.texture_of(index.get("GFX_mod_new").unwrap()).unwrap().exists);
    // Subfolders and other folders are untouched.
    assert!(index.texture_of(index.get("GFX_idea_spirit_one").unwrap()).unwrap().exists);
}

fn game_uses(name: &str) -> (Vec<SpriteUse>, SpriteIndex) {
    let f = fixture(name, None);
    let ws = load(&f, false);
    let index = SpriteIndex::build(&ws);
    (trace(&ws, &index, &TraceOptions::default()), index)
}

#[test]
fn traces_focus_icons_including_conditional_ones() {
    let (uses, _) = game_uses("traces_focus_icons_including_conditional_ones");
    let alpha = one(&uses, "focus.icon", "focus:t_alpha");
    assert_eq!((alpha.family, alpha.sprite.as_str(), alpha.defined), (Family::Focus, "GFX_goal_alpha", true));
    assert_eq!(alpha.texture.as_ref().map(|t| (t.width, t.height)), Some((Some(100), Some(88))));
    let cond: BTreeSet<&str> = find(&uses, "focus.icon", "focus:t_cond").iter().map(|u| u.sprite.as_str()).collect();
    assert_eq!(cond, BTreeSet::from(["GFX_goal_cond_a", "GFX_goal_cond_b"]));
    let unknown = one(&uses, "focus.icon", "focus:t_unknown");
    assert!(!unknown.defined && unknown.sprite == "GFX_goal_not_defined");
}

#[test]
fn applies_the_prefix_rules() {
    let (uses, _) = game_uses("applies_the_prefix_rules");
    // Idea: GFX_idea_<x>, or the written GFX_ name.
    assert_eq!(one(&uses, "idea.picture", "idea:spirit_one").sprite, "GFX_idea_spirit_one");
    assert_eq!(one(&uses, "idea.picture", "idea:explicit_gfx").sprite, "GFX_idea_spirit_one");
    // No picture: the sprite named after the idea, marked implicit.
    let fallback = one(&uses, "idea.picture", "idea:fallback");
    assert!(fallback.implicit && fallback.defined && fallback.sprite == "GFX_idea_fallback");
    // Decision: GFX_decision_<x>, GFX_kept as written, missions in the same family.
    let dec = one(&uses, "decision.icon", "decision:t_dec");
    assert_eq!((dec.sprite.as_str(), dec.family), ("GFX_decision_alpha", Family::Decision));
    let mission = one(&uses, "decision.mission.icon", "decision:t_mission");
    assert_eq!((mission.sprite.as_str(), mission.family), ("GFX_decision_alpha", Family::Decision));
    // Decision categories.
    let icon = one(&uses, "decision_category.icon", "decision_category:cat");
    assert_eq!((icon.sprite.as_str(), icon.family), ("GFX_decision_category_cat", Family::DecisionCategoryIcon));
    let picture = one(&uses, "decision_category.picture", "decision_category:cat");
    assert_eq!((picture.sprite.as_str(), picture.family), ("GFX_decision_cat_picture_pic", Family::DecisionCategoryPicture));
    // Dynamic modifier icons are written in full.
    let dyn_use = one(&uses, "dynamic_modifier.icon", "dynamic_modifier:dyn");
    assert_eq!((dyn_use.sprite.as_str(), dyn_use.family), ("GFX_modifiers_dyn", Family::StateModifier));
}

#[test]
fn splits_ideas_by_slot() {
    let (uses, _) = game_uses("splits_ideas_by_slot");
    assert_eq!(one(&uses, "idea.picture", "idea:spirit_one").family, Family::IdeaSpirit);
    assert_eq!(one(&uses, "idea.picture", "idea:concern_one").family, Family::IdeaConcern);
    assert_eq!(one(&uses, "idea.picture", "idea:adv_one").family, Family::AdvisorCard);
    assert_eq!(one(&uses, "idea.picture", "idea:officer_one").family, Family::OfficerCorpsSpirit);
}

#[test]
fn splits_events_and_traces_character_portraits() {
    let (uses, _) = game_uses("splits_events_and_traces_character_portraits");
    assert_eq!(one(&uses, "event.picture", "event:t.1").family, Family::ReportEvent);
    let news = one(&uses, "event.picture", "event:t.2");
    assert_eq!((news.family, news.slot.as_str()), (Family::NewsEvent, "news_event.picture"));
    let large = one(&uses, "character.portrait.civilian.large", "character:LEADER");
    assert_eq!((large.family, large.sprite.as_str()), (Family::LeaderPortrait, "GFX_portrait_leader"));
    assert_eq!(one(&uses, "character.portrait.civilian.small", "character:LEADER").family, Family::AdvisorCard);
    assert_eq!(one(&uses, "character.portrait.army.large", "character:CMD").family, Family::CommanderPortrait);
    // An advisor without a small portrait falls back to GFX_idea_<idea_token>.
    let token = one(&uses, "character.advisor.idea_token", "character:ADV");
    assert!(token.implicit && token.family == Family::AdvisorCard && token.sprite == "GFX_idea_adv_token");
    // A texture path is not a sprite.
    let direct = one(&uses, "character.portrait.civilian.large", "character:DIRECT");
    assert!(direct.direct_texture && direct.sprite.is_empty());
    let t = direct.texture.as_ref().unwrap();
    assert_eq!((t.path.as_str(), t.exists, t.width), ("gfx/leaders/direct.dds", true, Some(156)));
}

#[test]
fn reports_reuse_missing_textures_undefined_sprites_and_missing_shine() {
    let f = fixture("audit", None);
    let ws = load(&f, false);
    let (_, report) = SpriteReport::run(&ws, &Allowlist::default(), &TraceOptions::default());
    let by = |code: &str| -> Vec<&hoi4_engine::Finding> { report.findings.iter().filter(|f| f.code == code).collect() };
    let reuse = by("GFX-FAMILY-REUSE");
    let shared = reuse.iter().find(|f| f.subject.as_deref() == Some("GFX_shared")).expect("sprite reuse");
    assert!(shared.message.contains("focus") && shared.message.contains("decision"), "{}", shared.message);
    // Two sprites with one texture, consumed by two families.
    let texture = reuse.iter().find(|f| f.subject.as_deref() == Some("gfx/interface/decisions/shared_tex.dds")).expect("texture reuse");
    assert!(texture.message.contains("state_modifier"));
    assert_eq!(reuse.len(), 2, "{reuse:?}");
    // The fixture's own sprite GFX_idea_adv_token appears once, not as reuse.
    let missing = by("GFX-TEXTURE-MISSING");
    assert!(missing.iter().any(|f| f.subject.as_deref() == Some("GFX_missing_tex")));
    let undefined = by("GFX-SPRITE-UNDEFINED");
    assert_eq!(undefined.len(), 1);
    assert_eq!(undefined[0].subject.as_deref(), Some("GFX_goal_not_defined"));
    let shine: BTreeSet<&str> = by("GFX-FOCUS-SHINE-MISSING").iter().filter_map(|f| f.subject.as_deref()).collect();
    assert_eq!(shine, BTreeSet::from(["GFX_goal_beta", "GFX_shared"]));
    assert!(report.summary.uses_by_family["focus"].uses >= 6);
}

#[test]
fn the_allowlist_silences_intentional_aliases() {
    let f = fixture("allow", None);
    let ws = load(&f, false);
    let allow = Allowlist::parse(
        r#"{ "aliases": [
            { "sprite": "gfx_shared", "families": ["focus", "decision"], "reason": "same art" },
            { "texture": "GFX\\Interface\\Decisions\\Shared_Tex.dds" } ],
          "no_shine": ["GFX_goal_beta"],
          "missing_textures": ["GFX_missing_tex"] }"#,
    )
    .unwrap();
    let (_, report) = SpriteReport::run(&ws, &allow, &TraceOptions::default());
    assert!(report.findings.iter().all(|f| f.code != "GFX-FAMILY-REUSE"), "{:?}", report.findings);
    assert!(report.findings.iter().all(|f| f.code != "GFX-TEXTURE-MISSING"));
    let shine: Vec<_> = report.findings.iter().filter(|f| f.code == "GFX-FOCUS-SHINE-MISSING").filter_map(|f| f.subject.clone()).collect();
    assert_eq!(shine, ["GFX_shared"]);
    // An alias that lists too few families does not cover the reuse.
    let narrow = Allowlist::parse(r#"{ "aliases": [ { "sprite": "GFX_shared", "families": ["focus"] } ] }"#).unwrap();
    let (_, report) = SpriteReport::run(&ws, &narrow, &TraceOptions::default());
    assert!(report.findings.iter().any(|f| f.subject.as_deref() == Some("GFX_shared") && f.code == "GFX-FAMILY-REUSE"));
}

#[test]
fn a_mod_run_traces_only_the_mods_files() {
    let f = fixture("modrun", None);
    let ws = load(&f, true);
    let (index, report) = SpriteReport::run(&ws, &Allowlist::default(), &TraceOptions::default());
    assert!(report.uses.iter().all(|u| u.layer == "spritemod"), "{:?}", report.uses.iter().map(|u| &u.path).collect::<Vec<_>>());
    assert_eq!(report.uses.len(), 3);
    let reuse: Vec<_> = report.findings.iter().filter(|f| f.code == "GFX-FAMILY-REUSE").collect();
    assert_eq!(reuse.len(), 1);
    assert_eq!(reuse[0].layer, "spritemod");
    let shine: Vec<_> = report.findings.iter().filter(|f| f.code == "GFX-FOCUS-SHINE-MISSING").filter_map(|f| f.subject.as_deref()).collect();
    assert_eq!(shine, ["GFX_mod_new"]);
    // With every layer traced, the game's uses are included too.
    let all = trace(&ws, &index, &TraceOptions { all_layers: true });
    assert!(all.len() > report.uses.len());
}

fn installed_game() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("HOI4_GAME_DIR").map(PathBuf::from),
        Some(PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\Hearts of Iron IV")),
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Steam/steamapps/common/Hearts of Iron IV")),
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".steam/steam/steamapps/common/Hearts of Iron IV")),
    ];
    candidates.into_iter().flatten().find(|p| p.join("interface").is_dir() && p.join("common/national_focus").is_dir())
}

#[test]
fn the_installed_game_gives_sane_totals() {
    let Some(game) = installed_game() else {
        eprintln!("skipped: no installed game (set HOI4_GAME_DIR)");
        return;
    };
    let ws = Workspace::load(&WorkspaceOptions { game: Some(game), include_dlc: true, ..WorkspaceOptions::default() });
    let (index, report) = SpriteReport::run(&ws, &Allowlist::default(), &TraceOptions::default());
    assert!(index.len() > 20_000, "sprites {}", index.len());
    let share = |family: &str, w: u32, h: u32| {
        let with_size: Vec<_> =
            report.uses.iter().filter(|u| u.family.as_str() == family).filter_map(|u| u.texture.as_ref()?.width.zip(u.texture.as_ref()?.height)).collect();
        assert!(with_size.len() > 500, "{family}: {} uses with a texture", with_size.len());
        with_size.iter().filter(|s| **s == (w, h)).count() as f64 / with_size.len() as f64
    };
    // Focus icons are mostly 100x88, decision icons mostly 33x32, report events 210x176 and portraits 156x210.
    assert!(share("focus", 100, 88) > 0.4);
    assert!(share("decision", 33, 32) > 0.5);
    assert!(share("report_event", 210, 176) > 0.7);
    assert!(share("leader_portrait", 156, 210) > 0.9);
    assert!(report.summary.uses > 20_000);
    assert!(report.summary.uses_by_family["idea_spirit"].uses > 1000);
}
