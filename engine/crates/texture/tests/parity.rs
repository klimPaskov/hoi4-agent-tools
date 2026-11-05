//! Every synthetic fixture decodes to its reference (`*.ref.png`, from Pillow or the DXGI
//! definition; see `fixtures/generate.py`). BC7 and 8-bit uncompressed formats are bit exact.
//! Three differences are deliberate:
//! - BC1 to BC5 and the 4- and 5-bit legacy masks round where the specification leaves it to the
//!   decoder. Pillow truncates; this decoder rounds to nearest like the TypeScript one, so those
//!   may differ by one step.
//! - BC4 (ATI1) is one channel. Direct3D samples it as red, which this decoder draws; Pillow
//!   shows it as grey, so only red is compared.
//! - A reserved BC7 block (mode 8) is transparent black in the Direct3D 11 specification. Pillow
//!   makes it opaque, so its alpha is not compared.

use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

/// The largest difference allowed per channel for a fixture.
fn tolerance(name: &str) -> u8 {
    let rounded =
        ["dx10_bc1", "dx10_bc2", "dx10_bc3", "dx10_bc4", "dx10_bc5", "legacy_dxt", "legacy_ati", "legacy_r5g6b5", "legacy_a1r5g5b5", "legacy_a4r4g4b4"];
    if rounded.iter().any(|prefix| name.starts_with(prefix)) { 1 } else { 0 }
}

/// Channels compared for pixel `index` of a fixture.
fn compared(name: &str, bytes: &[u8], width: u32, index: usize) -> [bool; 4] {
    if name.starts_with("dx10_bc4") || name.starts_with("legacy_ati1") {
        return [true, false, false, true];
    }
    if name.starts_with("bc7_") {
        let (x, y) = (index as u32 % width, index as u32 / width);
        let block = (y / 4 * width.div_ceil(4) + x / 4) as usize;
        if bytes[148 + block * 16] == 0 {
            return [true, true, true, false];
        }
    }
    [true; 4]
}

#[test]
fn every_fixture_matches_its_reference() {
    let mut checked = 0;
    let mut failures = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(fixtures()).unwrap().map(|e| e.unwrap().path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".dds").or_else(|| name.strip_suffix(".tga")) else { continue };
        let reference = fixtures().join(format!("{stem}.ref.png"));
        let expected = hoi4_texture::decode_file(&reference, u64::MAX).unwrap().image;
        let decoded = match hoi4_texture::decode_file(&path, u64::MAX) {
            Ok(decoded) => decoded.image,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        assert_eq!((decoded.width, decoded.height), (expected.width, expected.height), "{name} size");
        let source = std::fs::read(&path).unwrap();
        let mut worst = (0u8, 0usize);
        for (offset, (a, b)) in decoded.rgba.iter().zip(&expected.rgba).enumerate() {
            if compared(&name, &source, decoded.width, offset / 4)[offset % 4] && a.abs_diff(*b) > worst.0 {
                worst = (a.abs_diff(*b), offset);
            }
        }
        if worst.0 > tolerance(&name) {
            let pixel = worst.1 / 4 * 4;
            failures.push(format!(
                "{name}: differs by {} at pixel {} channel {}: {:?} against {:?}",
                worst.0,
                worst.1 / 4,
                worst.1 % 4,
                &decoded.rgba[pixel..pixel + 4],
                &expected.rgba[pixel..pixel + 4]
            ));
        }
        checked += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(checked, 35, "fixtures checked");
}

#[test]
fn bc7_fixture_covers_every_mode_and_partition() {
    let bytes = std::fs::read(fixtures().join("bc7_modes.dds")).unwrap();
    let blocks = &bytes[148..];
    let mut seen = std::collections::BTreeSet::new();
    for block in blocks.chunks_exact(16) {
        let mode = block[0].trailing_zeros();
        let value = u128::from_le_bytes(block.try_into().unwrap());
        let partition = match mode {
            0 => (value >> 1) & 0xf,
            1 => (value >> 2) & 0x3f,
            2 => (value >> 3) & 0x3f,
            3 => (value >> 4) & 0x3f,
            7 => (value >> 8) & 0x3f,
            _ => 0,
        };
        seen.insert((mode, partition));
    }
    assert_eq!(seen.len(), 16 + 64 + 64 + 64 + 1 + 1 + 1 + 64 + 1, "modes and partitions");
}

#[test]
fn unsupported_and_damaged_files_explain_why() {
    let bc7 = std::fs::read(fixtures().join("bc7_modes.dds")).unwrap();
    // BC6H is a real format the decoder does not implement.
    let mut bc6 = bc7.clone();
    bc6[128..132].copy_from_slice(&95u32.to_le_bytes());
    let error = hoi4_texture::decode(&bc6, "dds", u64::MAX).unwrap_err();
    assert_eq!(error.kind, hoi4_texture::ErrorKind::Unsupported);
    assert_eq!(error.format, "BC6H_UF16");
    // A DXGI number no format has.
    let mut unknown = bc7.clone();
    unknown[128..132].copy_from_slice(&500u32.to_le_bytes());
    let error = hoi4_texture::decode(&unknown, "dds", u64::MAX).unwrap_err();
    assert_eq!((error.kind, error.format.as_str()), (hoi4_texture::ErrorKind::Unsupported, "DX10/500"));
    // Cut short: the header promises more blocks.
    let error = hoi4_texture::decode(&bc7[..bc7.len() - 1], "dds", u64::MAX).unwrap_err();
    assert_eq!((error.kind, error.format.as_str()), (hoi4_texture::ErrorKind::Truncated, "BC7_UNORM"));
    // Above the pixel limit.
    let error = hoi4_texture::decode(&bc7, "dds", 16).unwrap_err();
    assert_eq!(error.kind, hoi4_texture::ErrorKind::TooLarge);
    // Not a DDS at all.
    let error = hoi4_texture::decode(b"not a texture", "dds", u64::MAX).unwrap_err();
    assert_eq!(error.kind, hoi4_texture::ErrorKind::Invalid);
}

#[test]
fn content_wins_over_extension() {
    // Kaiserreich and Old World Blues ship PNG files named `.dds`.
    let image = hoi4_texture::decode_file(&fixtures().join("tga_32.ref.png"), u64::MAX).unwrap().image;
    let png = hoi4_texture::pngio::encode(&image, true);
    let decoded = hoi4_texture::decode(&png, "dds", u64::MAX).unwrap();
    assert_eq!(decoded.format, "PNG (in a .dds file)");
    assert_eq!(decoded.image, image);
    // An empty file is still an error.
    assert_eq!(hoi4_texture::decode(&[], "dds", u64::MAX).unwrap_err().kind, hoi4_texture::ErrorKind::Invalid);
}

#[test]
fn png_round_trip() {
    let decoded = hoi4_texture::decode_file(&fixtures().join("bc7_modes.dds"), u64::MAX).unwrap().image;
    for fast in [false, true] {
        let png = hoi4_texture::pngio::encode(&decoded, fast);
        assert_eq!(hoi4_texture::pngio::decode(&png, u64::MAX).unwrap().image, decoded);
    }
}
