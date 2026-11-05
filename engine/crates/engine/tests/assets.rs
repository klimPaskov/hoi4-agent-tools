//! `hoi4-engine assets` against the synthetic game in `fixtures/game` and a small mod.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_engine::assets::{AssetKind, Request, audit, respond, respond_json};

fn game() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/game")
}

/// A DDS header of the given size; `dxgi` writes a DX10 header with that format.
fn dds(width: u32, height: u32, dxgi: Option<u32>) -> Vec<u8> {
    let mut b = vec![0u8; 148];
    b[0..4].copy_from_slice(b"DDS ");
    b[4..8].copy_from_slice(&124u32.to_le_bytes());
    b[12..16].copy_from_slice(&height.to_le_bytes());
    b[16..20].copy_from_slice(&width.to_le_bytes());
    b[80..84].copy_from_slice(&4u32.to_le_bytes());
    match dxgi {
        Some(format) => {
            b[84..88].copy_from_slice(b"DX10");
            b[128..132].copy_from_slice(&format.to_le_bytes());
        }
        None => b[84..88].copy_from_slice(b"DXT5"),
    }
    b
}

/// An uncompressed 32-bit TGA header of the given size.
fn tga(width: u16, height: u16) -> Vec<u8> {
    let mut b = vec![0u8; 18];
    b[2] = 2;
    b[12..14].copy_from_slice(&width.to_le_bytes());
    b[14..16].copy_from_slice(&height.to_le_bytes());
    b[16] = 32;
    b
}

fn write_mod(name: &str, text: &[(&str, &str)], binary: &[(&str, Vec<u8>)]) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("assets").join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("descriptor.mod"), format!("name=\"{name}\"\n")).unwrap();
    for (path, bytes) in text.iter().map(|(p, t)| (*p, t.as_bytes().to_vec())).chain(binary.iter().cloned()) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, bytes).unwrap();
    }
    root
}

fn request(target: &Path, kind: AssetKind, id: &str, audit: bool) -> Request {
    Request {
        game: Some(game()),
        target: Some(target.to_path_buf()),
        dependencies: Vec::new(),
        include_dlc: false,
        kind,
        id: id.to_owned(),
        audit,
        limit: Some(20),
    }
}

fn fixture(name: &str) -> PathBuf {
    write_mod(
        name,
        &[
            (
                "interface/t.gfx",
                "spriteTypes = {\n\tspriteType = { name = \"GFX_t_ok\" texturefile = \"gfx/interface/t_ok.dds\" }\n\tspriteType = { name = \"GFX_t_strip\" texturefile = \"gfx/interface/t_strip.dds\" noOfFrames = 3 }\n\tspriteType = { name = \"GFX_t_bc7\" texturefile = \"gfx/interface/t_bc7.dds\" }\n\tspriteType = { name = \"GFX_t_lost\" texturefile = \"gfx/interface/t_lost.dds\" }\n\tspriteType = { name = \"GFX_t_none\" }
	spriteType = { name = \"GFX_t_empty\" texturefile = \"gfx/interface/t_empty.dds\" }\n}\n",
            ),
            ("events/t.txt", "# uses GFX_t_ok\n"),
            (
                "sound/t.asset",
                "sound = { name = \"t_click\" file = \"t/click.wav\" }\nsound = { name = \"t_lost\" file = \"t/lost.wav\" }\nsoundeffect = {\n\tname = t_effect\n\tsounds = {\n\t\tsound = t_click\n\t\tweighted_sound = { sound = t_nowhere weight = 1 }\n\t}\n}\ncategory = { name = \"T\" soundeffects = { t_effect t_gone } }\n",
            ),
            ("sound/t/click.wav", "RIFF"),
            ("music/t/t_music.asset", "music = { name = \"t_song\" file = \"t_song.ogg\" }\n"),
            ("music/t/t_song.ogg", "OggS"),
            ("common/country_tags/t.txt", "TTT = \"countries/T.txt\"\nTUV = \"countries/U.txt\"\n"),
            ("common/country_tags/zz_dynamic.txt", "dynamic_tags = yes\nD01 = \"countries/D.txt\"\n"),
        ],
        &[
            ("gfx/interface/t_ok.dds", dds(64, 64, None)),
            ("gfx/interface/t_strip.dds", dds(100, 20, None)),
            ("gfx/interface/t_bc7.dds", dds(64, 64, Some(98))),
            ("gfx/flags/TTT.tga", tga(82, 52)),
            ("gfx/flags/medium/TTT.tga", tga(41, 26)),
            ("gfx/flags/small/TTT.tga", tga(12, 7)),
            ("gfx/flags/TUW.tga", tga(82, 52)),
            ("gfx/flags/medium/TUW.tga", tga(41, 26)),
            ("gfx/flags/small/TUW.tga", tga(11, 7)),
            ("gfx/interface/t_empty.dds", Vec::new()),
            ("gfx/flags/TTT_fascism.tga", tga(82, 52)),
            ("gfx/flags/small/STRAY.tga", tga(10, 7)),
        ],
    )
}

fn codes(problems: &[hoi4_engine::ideas::Problem]) -> Vec<&'static str> {
    let mut codes: Vec<_> = problems.iter().map(|p| p.code).collect();
    codes.sort();
    codes
}

#[test]
fn a_sprite_reports_its_texture_header_frames_and_format() {
    let root = fixture("sprite");
    let ok = respond(&request(&root, AssetKind::Sprite, "GFX_t_ok", false));
    assert!(ok.found);
    assert!(ok.problems.is_empty());
    assert!(ok.fields.iter().any(|f| f.name == "texture" && f.text.contains("dds DXT5 64x64")), "{:?}", ok.fields.iter().map(|f| &f.text).collect::<Vec<_>>());
    assert_eq!(ok.mentions.len(), 2, "the .gfx file and the event");

    let strip = respond(&request(&root, AssetKind::Sprite, "GFX_t_strip", false));
    assert_eq!(codes(&strip.problems), ["ASSET_FRAMES_MISMATCH"]);
    assert_eq!(strip.problems[0].severity, "info");
    let bc7 = respond(&request(&root, AssetKind::Sprite, "GFX_t_bc7", false));
    assert_eq!(codes(&bc7.problems), ["ASSET_TEXTURE_FORMAT_RISKY"]);

    let audit = audit(&request(&root, AssetKind::Sprite, "", true));
    assert_eq!(audit.checked, 6);
    assert_eq!(audit.counts.get("ASSET_TEXTURE_MISSING"), Some(&1));
    // An empty file hides a picture on purpose.
    assert!(audit.problems.iter().any(|p| p.code == "ASSET_TEXTURE_EMPTY" && p.severity == "info"));
    assert_eq!(audit.counts.get("ASSET_TEXTURE_NONE"), Some(&1));
    let missing = respond(&request(&root, AssetKind::Sprite, "GFX_t_ko", false));
    assert!(!missing.found);
    assert_eq!(missing.suggestions[0], "GFX_t_ok");
}

#[test]
fn sounds_need_their_files_and_effects_need_their_sounds() {
    let root = fixture("sound");
    let click = respond(&request(&root, AssetKind::Sound, "t_click", false));
    assert!(click.problems.is_empty(), "{:?}", click.problems.iter().map(|p| &p.message).collect::<Vec<_>>());
    let lost = respond(&request(&root, AssetKind::Sound, "t_lost", false));
    assert_eq!(codes(&lost.problems), ["ASSET_FILE_MISSING"]);
    assert!(lost.problems[0].message.contains("sound/t/lost.wav"));
    let effect = respond(&request(&root, AssetKind::Sound, "t_effect", false));
    let unknown: Vec<_> = effect.references.iter().filter(|r| !r.known).map(|r| r.value.as_str()).collect();
    assert_eq!(unknown, ["t_nowhere"]);
    // Music files sit next to their .asset file.
    let song = respond(&request(&root, AssetKind::Sound, "t_song", false));
    assert!(song.problems.is_empty());
    let audit = audit(&request(&root, AssetKind::Sound, "", true));
    assert_eq!(audit.checked, 5);
    assert_eq!(audit.counts.get("ASSET_REFERENCE_UNKNOWN"), Some(&2));
    assert_eq!(audit.counts.get("ASSET_FILE_MISSING"), Some(&1));
}

#[test]
fn flags_need_all_three_sizes_and_tags_need_a_flag() {
    let root = fixture("flag");
    let flag = respond(&request(&root, AssetKind::Flag, "TTT", false));
    assert_eq!(flag.definitions.len(), 3);
    assert_eq!(codes(&flag.problems), ["ASSET_FLAG_SIZE"]);
    let fascist = respond(&request(&root, AssetKind::Flag, "TTT_fascism", false));
    assert_eq!(codes(&fascist.problems), ["ASSET_FLAG_MISSING", "ASSET_FLAG_MISSING"]);

    let audit = audit(&request(&root, AssetKind::Flag, "", true));
    // A stray small file without a large flag is no problem; TUV has no flag; D01 is dynamic.
    let ids: Vec<_> = audit.problems.iter().map(|p| (p.code, p.id.as_str())).collect();
    assert_eq!(
        ids,
        [
            ("ASSET_FLAG_SIZE", "TTT"),
            ("ASSET_FLAG_MISSING", "TTT_fascism"),
            ("ASSET_FLAG_MISSING", "TTT_fascism"),
            ("ASSET_FLAG_SIZE_CLOSE", "TUW"),
            ("ASSET_FLAG_MISSING", "TUV")
        ]
    );
}

#[test]
fn requests_are_checked() {
    let (text, code) = respond_json(r#"{"kind":"sprite"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("ASSET_ID_REQUIRED"));
    let (text, code) = respond_json(r#"{"kind":"model","id":"x"}"#);
    assert_eq!(code, 2);
    assert!(text.contains("ASSET_INVALID_REQUEST"));
}
