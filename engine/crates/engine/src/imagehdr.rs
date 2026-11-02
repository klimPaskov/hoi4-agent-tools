//! Texture headers: size, mip count and pixel format of the images a sprite points at, read from
//! the first bytes of the file. No pixel data is decoded.
//!
//! Supported: DDS (legacy header and the DX10 extension), TGA and PNG. Sources: Microsoft's
//! "Programming Guide for DDS" (`DDS_HEADER`, `DDS_PIXELFORMAT`, `DDS_HEADER_DXT10`), the TGA 2.0
//! specification (18-byte header) and the PNG specification (IHDR chunk).

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// What the header of one texture file says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TextureHeader {
    /// `dds`, `tga` or `png`.
    pub container: &'static str,
    pub width: u32,
    pub height: u32,
    /// Mip levels in a DDS (1 when the header says 0 or 1); `None` for other containers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mip_count: Option<u32>,
    /// Readable pixel format: `DXT5`, `BC7_UNORM` (DX10), `A8R8G8B8` style masks as `RGBA32`,
    /// `RGB24`, `TGA 32 bit`, `PNG rgba 8 bit`.
    pub pixel_format: String,
    /// DDS four-character code (`DXT1`, `DXT5`, `DX10`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fourcc: Option<String>,
    /// DDS DX10 header `DXGI_FORMAT` number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dxgi_format: Option<u32>,
    /// Bits per pixel (TGA and uncompressed DDS; PNG bit depth times channels).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bits: Option<u32>,
    /// TGA origin: `top_left` or `bottom_left` (also `top_right`, `bottom_right`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<&'static str>,
}

/// Reads the header of the image at `path`. `Err` names why it is not a readable texture.
pub fn read_header(path: &Path) -> Result<TextureHeader, String> {
    let mut file = File::open(path).map_err(|e| format!("cannot open: {e}"))?;
    let mut buf = Vec::with_capacity(160);
    file.by_ref().take(160).read_to_end(&mut buf).map_err(|e| format!("cannot read: {e}"))?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "dds" => parse_dds(&buf),
        "tga" => parse_tga(&buf),
        "png" => parse_png(&buf),
        other => Err(format!("unsupported texture extension .{other}")),
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u16_at(b: &[u8], at: usize) -> u32 {
    u32::from(u16::from_le_bytes([b[at], b[at + 1]]))
}

/// Parses a DDS header (128 bytes, plus 20 for the DX10 extension).
pub fn parse_dds(b: &[u8]) -> Result<TextureHeader, String> {
    if b.len() < 128 || &b[0..4] != b"DDS " {
        return Err("not a DDS file (missing DDS magic or header truncated)".into());
    }
    if u32_at(b, 4) != 124 {
        return Err("DDS header size is not 124".into());
    }
    let height = u32_at(b, 12);
    let width = u32_at(b, 16);
    let mips = u32_at(b, 28).max(1);
    let pf_flags = u32_at(b, 80);
    let four = [b[84], b[85], b[86], b[87]];
    let bits = u32_at(b, 88);
    let mut header = TextureHeader {
        container: "dds",
        width,
        height,
        mip_count: Some(mips),
        pixel_format: String::new(),
        fourcc: None,
        dxgi_format: None,
        bits: None,
        origin: None,
    };
    if pf_flags & 0x4 != 0 {
        let code: String = four.iter().map(|&c| if c.is_ascii_graphic() { c as char } else { '?' }).collect();
        header.fourcc = Some(code.clone());
        if code == "DX10" {
            if b.len() < 148 {
                return Err("DDS DX10 header truncated".into());
            }
            let dxgi = u32_at(b, 128);
            header.dxgi_format = Some(dxgi);
            header.pixel_format = dxgi_name(dxgi).map_or_else(|| format!("DXGI_{dxgi}"), str::to_string);
        } else {
            header.pixel_format = code;
        }
    } else if pf_flags & 0x40 != 0 {
        header.bits = Some(bits);
        let alpha = pf_flags & 0x1 != 0;
        header.pixel_format = format!("{}{bits}", if alpha { "RGBA" } else { "RGB" });
    } else if pf_flags & 0x20000 != 0 {
        header.bits = Some(bits);
        header.pixel_format = format!("LUMINANCE{bits}");
    } else {
        header.pixel_format = "UNKNOWN".into();
    }
    Ok(header)
}

fn dxgi_name(format: u32) -> Option<&'static str> {
    Some(match format {
        2 => "R32G32B32A32_FLOAT",
        10 => "R16G16B16A16_FLOAT",
        28 => "R8G8B8A8_UNORM",
        29 => "R8G8B8A8_UNORM_SRGB",
        61 => "R8_UNORM",
        71 => "BC1_UNORM",
        72 => "BC1_UNORM_SRGB",
        74 => "BC2_UNORM",
        75 => "BC2_UNORM_SRGB",
        77 => "BC3_UNORM",
        78 => "BC3_UNORM_SRGB",
        80 => "BC4_UNORM",
        83 => "BC5_UNORM",
        87 => "B8G8R8A8_UNORM",
        88 => "B8G8R8X8_UNORM",
        91 => "B8G8R8A8_UNORM_SRGB",
        95 => "BC6H_UF16",
        98 => "BC7_UNORM",
        99 => "BC7_UNORM_SRGB",
        _ => return None,
    })
}

/// Parses an 18-byte TGA header.
pub fn parse_tga(b: &[u8]) -> Result<TextureHeader, String> {
    if b.len() < 18 {
        return Err("TGA header truncated".into());
    }
    let image_type = b[2];
    if !matches!(image_type, 1 | 2 | 3 | 9 | 10 | 11) {
        return Err(format!("TGA image type {image_type} is not a known type"));
    }
    let width = u16_at(b, 12);
    let height = u16_at(b, 14);
    let bits = u32::from(b[16]);
    if width == 0 || height == 0 || !matches!(bits, 8 | 15 | 16 | 24 | 32) {
        return Err("TGA header has an impossible size or depth".into());
    }
    let descriptor = b[17];
    let origin = match (descriptor & 0x10 != 0, descriptor & 0x20 != 0) {
        (false, false) => "bottom_left",
        (false, true) => "top_left",
        (true, false) => "bottom_right",
        (true, true) => "top_right",
    };
    Ok(TextureHeader {
        container: "tga",
        width,
        height,
        mip_count: None,
        pixel_format: format!("TGA {bits} bit"),
        fourcc: None,
        dxgi_format: None,
        bits: Some(bits),
        origin: Some(origin),
    })
}

/// Parses the PNG signature and IHDR chunk.
pub fn parse_png(b: &[u8]) -> Result<TextureHeader, String> {
    if b.len() < 33 || &b[0..8] != b"\x89PNG\r\n\x1a\n" || &b[12..16] != b"IHDR" {
        return Err("not a PNG file".into());
    }
    let be = |at: usize| u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    let depth = u32::from(b[24]);
    let (kind, channels) = match b[25] {
        0 => ("gray", 1),
        2 => ("rgb", 3),
        3 => ("indexed", 1),
        4 => ("gray_alpha", 2),
        6 => ("rgba", 4),
        other => return Err(format!("PNG colour type {other} is not valid")),
    };
    Ok(TextureHeader {
        container: "png",
        width: be(16),
        height: be(20),
        mip_count: None,
        pixel_format: format!("PNG {kind} {depth} bit"),
        fourcc: None,
        dxgi_format: None,
        bits: Some(depth * channels),
        origin: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn dds_bytes(w: u32, h: u32, mips: u32, fourcc: &[u8; 4], dxgi: Option<u32>) -> Vec<u8> {
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

    #[test]
    fn reads_a_dxt5_header() {
        let h = parse_dds(&dds_bytes(100, 88, 7, b"DXT5", None)).unwrap();
        assert_eq!((h.width, h.height, h.mip_count), (100, 88, Some(7)));
        assert_eq!(h.pixel_format, "DXT5");
        assert_eq!(h.fourcc.as_deref(), Some("DXT5"));
    }

    #[test]
    fn reads_the_dx10_extension() {
        let h = parse_dds(&dds_bytes(64, 64, 0, b"DX10", Some(98))).unwrap();
        assert_eq!(h.pixel_format, "BC7_UNORM");
        assert_eq!(h.dxgi_format, Some(98));
        assert_eq!(h.mip_count, Some(1));
    }

    #[test]
    fn rejects_truncated_and_foreign_files() {
        assert!(parse_dds(b"DDS ").is_err());
        assert!(parse_dds(&[0u8; 200]).is_err());
        assert!(parse_tga(&[0u8; 5]).is_err());
        assert!(parse_png(b"nope").is_err());
    }

    #[test]
    fn reads_tga_size_depth_and_origin() {
        let mut b = [0u8; 18];
        b[2] = 2;
        b[12..14].copy_from_slice(&33u16.to_le_bytes());
        b[14..16].copy_from_slice(&32u16.to_le_bytes());
        b[16] = 32;
        b[17] = 0x28;
        let h = parse_tga(&b).unwrap();
        assert_eq!((h.width, h.height, h.bits, h.origin), (33, 32, Some(32), Some("top_left")));
    }
}
