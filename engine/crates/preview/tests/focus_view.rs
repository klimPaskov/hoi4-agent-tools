//! The focus view on synthetic assets, so CI needs no game. The geometry asserted here is what
//! the in-game screenshots of game 1.19.4.1 showed at the default UI scale (hoi4-factory run27):
//! a focus item every 96 by 130 pixels, the plaque at item + (5, 40), the icon centred on
//! item + (87, 20), connector tiles in the column at item + 78 from item + 64 down to the bar at
//! item + 96, the exclusive mark at the left item + (167, 52), the title centred in the box at
//! item + (15, 58) sized 147 by 20.

use std::fs;
use std::path::{Path, PathBuf};

use hoi4_preview::focus::{FocusNode, FocusRenderRequest, FocusState, render};
use hoi4_preview::{Assets, LayerRoot};
use hoi4_texture::Image;

const PLAQUE_CAN_START: [u8; 4] = [10, 200, 10, 255];
const PLAQUE_UNAVAILABLE: [u8; 4] = [120, 20, 20, 255];
const ICON: [u8; 4] = [200, 200, 0, 255];
const SOLID: [u8; 4] = [1, 2, 250, 255];
const DOTTED: [u8; 4] = [3, 250, 4, 255];
const MARK: [u8; 4] = [250, 0, 250, 255];
const GLYPH: [u8; 4] = [255, 255, 255, 255];
const BACKGROUND: [u8; 4] = [30, 30, 30, 255];

fn solid(width: u32, height: u32, colour: [u8; 4]) -> Image {
    let mut image = Image::new(width, height);
    for pixel in image.rgba.chunks_exact_mut(4) {
        pixel.copy_from_slice(&colour);
    }
    image
}

fn set(image: &mut Image, x: u32, y: u32, colour: [u8; 4]) {
    let index = ((y * image.width + x) * 4) as usize;
    image.rgba[index..index + 4].copy_from_slice(&colour);
}

/// A link sheet: four 16 by 16 frames; frame 3 is solid, frame 4 dotted, the line two pixels wide
/// at column 7 and 8 or row 7 and 8, as the game's tiles draw it.
fn link_sheet(up: bool, down: bool, left: bool, right: bool) -> Image {
    let mut image = Image::new(64, 16);
    for (frame, colour) in [(2u32, SOLID), (3, DOTTED)] {
        for i in 0..16u32 {
            let on = |i: u32| frame == 2 || i % 4 < 2;
            if up && i <= 8 && on(i) || down && i >= 7 && on(i) {
                set(&mut image, frame * 16 + 7, i, colour);
                set(&mut image, frame * 16 + 8, i, colour);
            }
            if left && i <= 8 && on(i) || right && i >= 7 && on(i) {
                set(&mut image, frame * 16 + i, 7, colour);
                set(&mut image, frame * 16 + i, 8, colour);
            }
        }
    }
    image
}

fn write_png(root: &Path, relative: &str, image: &Image) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, hoi4_texture::pngio::encode(image, true)).unwrap();
}

/// A game folder with the sprites, textures and font the focus view uses.
fn synthetic_game(root: &Path) {
    let links = [
        ("up_down", true, true, false, false),
        ("left_right", false, false, true, true),
        ("down_left", false, true, true, false),
        ("down_right", false, true, false, true),
        ("up_left", true, false, true, false),
        ("up_right", true, false, false, true),
        ("down_left_right", false, true, true, true),
        ("up_left_right", true, false, true, true),
        ("up_down_left", true, true, true, false),
        ("up_down_right", true, true, false, true),
        ("up_down_left_right", true, true, true, true),
    ];
    let mut gfx = String::from("spriteTypes = {\n");
    for (name, up, down, left, right) in links {
        write_png(root, &format!("gfx/interface/focusview/focus_link_{name}.png"), &link_sheet(up, down, left, right));
        gfx.push_str(&format!(
            "spriteType = {{ name = \"GFX_focus_link_{name}\" textureFile = \"gfx/interface/focusview/focus_link_{name}.png\" noOfFrames = 4 }}\n"
        ));
    }
    let mut mark = Image::new(96, 32);
    for y in 8..24 {
        for x in 8..24 {
            set(&mut mark, x, y, MARK);
        }
    }
    write_png(root, "gfx/interface/focusview/focus_link_exclusive.png", &mark);
    write_png(root, "gfx/interface/plaque_can_start.png", &solid(164, 50, PLAQUE_CAN_START));
    write_png(root, "gfx/interface/plaque_unavailable.png", &solid(164, 50, PLAQUE_UNAVAILABLE));
    write_png(root, "gfx/interface/goals/goal_test.png", &solid(94, 76, ICON));
    write_png(root, "gfx/interface/tiles/tiled_bg.png", &solid(192, 192, BACKGROUND));
    gfx.push_str(
        "spriteType = { name = \"GFX_focus_link_exclusive\" textureFile = \"gfx/interface/focusview/focus_link_exclusive.png\" noOfFrames = 3 }
        spriteType = { name = \"GFX_focus_can_start\" textureFile = \"gfx/interface/plaque_can_start.png\" }
        spriteType = { name = \"GFX_focus_unavailable\" textureFile = \"gfx/interface/plaque_unavailable.png\" }
        spriteType = { name = \"GFX_goal_test\" textureFile = \"gfx//interface//goals//GOAL_TEST.png\" }
        corneredTileSpriteType = { name = \"GFX_tiled_bg\" size = { x = 192 y = 192 } textureFile = \"gfx/interface/tiles/tiled_bg.png\" borderSize = { x = 64 y = 64 } tilingCenter = yes }
        corneredTileSpriteType = { name = \"GFX_tiled_focus_bg\" textureFile = \"gfx/interface/tiles/tiled_bg.png\" borderSize = { x = 16 y = 16 } tilingCenter = no }
        }
        bitmapfonts = {
            bitmapfont = { name = \"hoi_16mbs\" fontfiles = { \"gfx/fonts/test_font\" } color = 0xffffffff }
        }\n",
    );
    fs::create_dir_all(root.join("interface")).unwrap();
    fs::write(root.join("interface/test.gfx"), gfx).unwrap();
    // One 6 by 10 glyph for every letter and digit used, advancing 8 pixels.
    write_png(root, "gfx/fonts/test_font.png", &solid(8, 12, GLYPH));
    let mut fnt = String::from("info face=\"Test\" size=16\ncommon lineHeight=16 base=13 scaleW=8 scaleH=12 pages=1\npage id=0 file=\"test_font.png\"\n");
    for c in "ABEFMOX0123456789(),".chars() {
        fnt.push_str(&format!("char id={} x=0 y=0 width=6 height=10 xoffset=1 yoffset=3 xadvance=8 page=0 chnl=15\n", c as u32));
    }
    fnt.push_str("char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=4 page=0 chnl=15\n");
    fs::write(root.join("gfx/fonts/test_font.fnt"), fnt).unwrap();
}

fn node(id: &str, x: i32, y: i32, prerequisites: &[&[&str]], exclusive: &[&str]) -> FocusNode {
    FocusNode {
        id: id.into(),
        x,
        y,
        icon: Some("GFX_goal_test".into()),
        title: id.to_ascii_uppercase(),
        state: FocusState::Auto,
        prerequisites: prerequisites.iter().map(|g| g.iter().map(|s| s.to_string()).collect()).collect(),
        mutually_exclusive: exclusive.iter().map(|s| s.to_string()).collect(),
    }
}

fn temporary(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("hoi4-preview-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn pixel(image: &Image, x: i32, y: i32) -> [u8; 4] {
    let index = ((y as u32 * image.width + x as u32) * 4) as usize;
    image.rgba[index..index + 4].try_into().unwrap()
}

/// The run27 tree: two roots, a single prerequisite two columns and three rows away, an OR group
/// shared by two children, and an exclusive pair two columns apart.
fn run27() -> FocusRenderRequest {
    FocusRenderRequest {
        focuses: vec![
            node("m1", 0, 0, &[], &[]),
            node("m2", 3, 3, &[&["m1"]], &[]),
            node("b1", 6, 0, &[], &[]),
            node("b2", 8, 0, &[], &[]),
            node("b3", 6, 2, &[&["b1", "b2"]], &[]),
            node("b4", 8, 2, &[&["b1", "b2"]], &[]),
            node("e1", 10, 1, &[], &["e2"]),
            node("e2", 12, 1, &[], &["e1"]),
            node("x", 14, 0, &[], &[]),
        ],
        scale: 1.0,
        max_pixels: None,
    }
}

#[test]
fn draws_the_focus_view_where_the_game_does() {
    let root = temporary("view");
    synthetic_game(&root);
    let mut request = run27();
    request.focuses.last_mut().unwrap().icon = Some("GFX_missing_icon".into());
    let assets = Assets::new(vec![LayerRoot { name: "game".into(), path: root.clone(), replace_paths: Vec::new() }]);
    let rendered = render(&assets, &request).unwrap();
    let image = &rendered.image;
    // Item (0, 0) sits at the margin (13) plus the grid position (50, 50).
    let item = |x: i32, y: i32| (63 + x * 96, 63 + y * 130);

    // Plaques by state, icons centred above them.
    let (mx, my) = item(0, 0);
    assert_eq!(pixel(image, mx + 5, my + 40), PLAQUE_CAN_START);
    assert_eq!(pixel(image, mx + 5 + 163, my + 40 + 49), PLAQUE_CAN_START);
    let (m2x, m2y) = item(3, 3);
    assert_eq!(pixel(image, m2x + 5, m2y + 89), PLAQUE_UNAVAILABLE);
    assert_eq!(pixel(image, m2x + 87 - 47, m2y + 20 - 38), ICON);
    assert_eq!(pixel(image, m2x + 87 + 46, m2y + 20 + 37), ICON);
    assert_eq!(pixel(image, m2x + 87 - 48, m2y + 20 - 38), BACKGROUND);

    // Solid connector: down from m1, along the bar, down into m2.
    let column = mx + 78 + 7;
    assert_eq!(pixel(image, column, my + 96 - 4), SOLID, "drop under the parent");
    assert_eq!(pixel(image, column + 100, my + 96 + 7), SOLID, "the bar");
    assert_eq!(pixel(image, m2x + 78 + 7, my + 96 + 60), SOLID, "drop in the child's column");
    assert_eq!(pixel(image, m2x + 78 + 7, m2y - 30), SOLID, "into the child's icon");
    assert_eq!(pixel(image, column, my + 96 + 20), BACKGROUND, "no drop below the bar in the parent's column");

    // The OR group shares one dotted bar from b1's column to b2's.
    let (b1x, b1y) = item(6, 0);
    let (b2x, _) = item(8, 0);
    let bar = b1y + 96 + 7;
    let dotted: usize = (b1x + 78..b2x + 78).filter(|&x| pixel(image, x, bar) == DOTTED).count();
    assert!(dotted > 40, "dotted bar pixels: {dotted}");
    assert!((b1x + 78..b2x + 78).all(|x| pixel(image, x, bar) != SOLID));

    // The exclusive mark at the left item + (167, 52), centred in the 32-pixel gap.
    let (ex, ey) = item(10, 1);
    assert_eq!(pixel(image, ex + 167 + 8, ey + 52 + 8), MARK);
    assert_eq!(pixel(image, ex + 167 + 23, ey + 52 + 23), MARK);
    assert_eq!(rendered.report.drawn.exclusive_marks, 1);

    // Titles: glyphs inside the name box, centred.
    let text_row = my + 58 + (20 - 16) / 2 + 3 + 4;
    let lit: Vec<i32> = (mx + 15..mx + 162).filter(|&x| pixel(image, x, text_row) == GLYPH).collect();
    assert!(!lit.is_empty(), "title drawn");
    let centre = (lit.first().unwrap() + lit.last().unwrap()) / 2;
    assert!((centre - (mx + 15 + 73)).abs() <= 2, "title centred: {centre}");

    // The missing icon is reported against its focus, not drawn as something else.
    let missing = &rendered.report.missing;
    assert_eq!(missing.len(), 1, "{missing:?}");
    assert_eq!((missing[0].kind.as_str(), missing[0].name.as_str()), ("sprite", "GFX_missing_icon"));
    assert_eq!(missing[0].focus_ids, ["x"]);
    assert_eq!(rendered.report.drawn.icons, 8);
    assert_eq!(rendered.report.focuses.len(), 9);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_mod_overrides_the_view_and_its_assets() {
    let root = temporary("mod");
    let game = root.join("game");
    let modded = root.join("mod");
    synthetic_game(&game);
    // The mod spaces focuses wider and replaces the can-start plaque.
    fs::create_dir_all(modded.join("interface")).unwrap();
    fs::write(modded.join("interface/nationalfocusview.gui"), "guiTypes = { positionType = { name = \"focus_spacing\" position = { x = 120 y = 150 } } }")
        .unwrap();
    write_png(&modded, "gfx/interface/plaque_can_start.png", &solid(164, 50, [9, 9, 9, 255]));
    let layers = vec![
        LayerRoot { name: "game".into(), path: game, replace_paths: Vec::new() },
        LayerRoot { name: "mod".into(), path: modded, replace_paths: Vec::new() },
    ];
    let request = FocusRenderRequest { focuses: vec![node("a", 0, 0, &[], &[]), node("b", 1, 1, &[&["a"]], &[])], scale: 1.0, max_pixels: None };
    let assets = Assets::new(layers);
    let rendered = render(&assets, &request).unwrap();
    assert_eq!(pixel(&rendered.image, 63 + 5, 63 + 40), [9, 9, 9, 255]);
    assert_eq!(rendered.report.focuses[1].x, 63 + 120 + 5);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_cached_workspace_sees_edits() {
    let root = temporary("cache");
    synthetic_game(&root);
    let preview = hoi4_preview::Preview::new();
    let layers = vec![LayerRoot { name: "game".into(), path: root.clone(), replace_paths: Vec::new() }];
    let request = FocusRenderRequest { focuses: vec![node("a", 0, 0, &[], &[])], scale: 1.0, max_pixels: None };
    let (_, report, _, timings) = preview.focus_png(layers.clone(), &request).unwrap();
    assert!(!timings.warm);
    assert!(report.missing.is_empty());
    // A new sprite file and a changed texture are both picked up by the next render.
    fs::write(
        root.join("interface/extra.gfx"),
        "spriteTypes = { spriteType = { name = \"GFX_goal_new\" textureFile = \"gfx/interface/goals/goal_test.png\" } }",
    )
    .unwrap();
    write_png(&root, "gfx/interface/plaque_can_start.png", &solid(164, 50, [7, 7, 7, 255]));
    let mut request = request;
    request.focuses[0].icon = Some("GFX_goal_new".into());
    let (png, report, cache, timings) = preview.focus_png(layers, &request).unwrap();
    assert!(timings.warm);
    assert!(report.missing.is_empty(), "{:?}", report.missing);
    assert_eq!(cache.gfx_files_parsed, 1, "only the new file is parsed");
    let image = hoi4_texture::pngio::decode(&png, u64::MAX).unwrap().image;
    assert_eq!(pixel(&image, 63 + 5, 63 + 40), [7, 7, 7, 255]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_large_tree_is_scaled_under_the_pixel_ceiling() {
    let root = temporary("large");
    synthetic_game(&root);
    let focuses: Vec<FocusNode> = (0..1000)
        .map(|i| {
            let (x, y) = (i % 100 * 2, i / 100);
            let parent = if y > 0 { vec![format!("f{}", i - 100)] } else { Vec::new() };
            FocusNode { prerequisites: if parent.is_empty() { Vec::new() } else { vec![parent] }, ..node(&format!("f{i}"), x, y, &[], &[]) }
        })
        .collect();
    let assets = Assets::new(vec![LayerRoot { name: "game".into(), path: root.clone(), replace_paths: Vec::new() }]);
    let request = FocusRenderRequest { focuses, scale: 1.0, max_pixels: Some(4_000_000) };
    let rendered = render(&assets, &request).unwrap();
    let pixels = u64::from(rendered.image.width) * u64::from(rendered.image.height);
    assert!(pixels <= 4_000_000, "{pixels}");
    assert!(rendered.report.scale < 1.0);
    assert_eq!(rendered.report.focuses.len(), 1000);
    assert_eq!(rendered.report.drawn.plaques, 1000);
    fs::remove_dir_all(root).unwrap();
}
