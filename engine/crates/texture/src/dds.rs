//! DDS: the legacy 128-byte header and the 20-byte DX10 extension. The first mip level of the first
//! surface is decoded. Uncompressed pixels are copied as stored: an `_SRGB` format keeps its sRGB
//! bytes, which is what the game shows on screen.

use crate::{DecodeError, Decoded, ErrorKind, Image, bc, bc7, check_size};

const DDPF_ALPHAPIXELS: u32 = 0x1;
const DDPF_ALPHA: u32 = 0x2;
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
const DDPF_YUV: u32 = 0x200;
const DDPF_LUMINANCE: u32 = 0x20000;
const DDSD_PITCH: u32 = 0x8;
const DDSCAPS2_CUBEMAP: u32 = 0x200;
const DDSCAPS2_VOLUME: u32 = 0x20_0000;

/// The pixel layouts the decoder reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    /// Legacy uncompressed pixels described by bit masks (RGB, luminance or alpha only).
    Masked {
        bits: u32,
        masks: [u32; 4],
        luminance: bool,
    },
    Bc1,
    Bc2,
    Bc3,
    /// DXT5 with red stored in alpha (`RXGB`).
    Rxgb,
    Bc4,
    Bc5,
    Bc7,
    /// 32-bit with bytes in memory order red, green, blue, alpha.
    Rgba8,
    /// 32-bit with bytes blue, green, red, alpha; `opaque` ignores the fourth byte (`X8`).
    Bgra8 {
        opaque: bool,
    },
    Rgb10a2,
    B5g6r5,
    B5g5r5a1,
    B4g4r4a4,
    R8,
    R8g8,
    A8,
}

/// What a DDS header says, before any pixel is decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DdsInfo {
    pub width: u32,
    pub height: u32,
    pub mip_count: u32,
    /// Readable format name: `DXT5`, `BC7_UNORM`, `B8G8R8A8_UNORM_SRGB`, `RGBA32`.
    pub format_name: String,
    /// DXGI number when the file has a DX10 header.
    pub dxgi_format: Option<u32>,
    pub pixel_format: PixelFormat,
    /// Byte offset of the first pixel.
    pub data_offset: usize,
    /// Row pitch from the header when it declares one (uncompressed only).
    pub pitch: Option<u32>,
    /// Faces, slices or depth beyond the first surface, which the decoder ignores.
    pub extra_surfaces: bool,
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn err(kind: ErrorKind, format: impl Into<String>, message: impl Into<String>) -> DecodeError {
    DecodeError::new(kind, format, message)
}

/// DXGI formats by number: the name and the layout, when the decoder supports it.
fn dxgi(format: u32) -> (&'static str, Option<PixelFormat>) {
    use PixelFormat::*;
    match format {
        2 => ("R32G32B32A32_FLOAT", None),
        10 => ("R16G16B16A16_FLOAT", None),
        11 => ("R16G16B16A16_UNORM", None),
        24 => ("R10G10B10A2_UNORM", Some(Rgb10a2)),
        27 => ("R8G8B8A8_TYPELESS", Some(Rgba8)),
        28 => ("R8G8B8A8_UNORM", Some(Rgba8)),
        29 => ("R8G8B8A8_UNORM_SRGB", Some(Rgba8)),
        30 => ("R8G8B8A8_UINT", Some(Rgba8)),
        49 => ("R8G8_UNORM", Some(R8g8)),
        61 => ("R8_UNORM", Some(R8)),
        65 => ("A8_UNORM", Some(A8)),
        70 => ("BC1_TYPELESS", Some(Bc1)),
        71 => ("BC1_UNORM", Some(Bc1)),
        72 => ("BC1_UNORM_SRGB", Some(Bc1)),
        73 => ("BC2_TYPELESS", Some(Bc2)),
        74 => ("BC2_UNORM", Some(Bc2)),
        75 => ("BC2_UNORM_SRGB", Some(Bc2)),
        76 => ("BC3_TYPELESS", Some(Bc3)),
        77 => ("BC3_UNORM", Some(Bc3)),
        78 => ("BC3_UNORM_SRGB", Some(Bc3)),
        79 => ("BC4_TYPELESS", Some(Bc4)),
        80 => ("BC4_UNORM", Some(Bc4)),
        81 => ("BC4_SNORM", None),
        82 => ("BC5_TYPELESS", Some(Bc5)),
        83 => ("BC5_UNORM", Some(Bc5)),
        84 => ("BC5_SNORM", None),
        85 => ("B5G6R5_UNORM", Some(B5g6r5)),
        86 => ("B5G5R5A1_UNORM", Some(B5g5r5a1)),
        87 => ("B8G8R8A8_UNORM", Some(Bgra8 { opaque: false })),
        88 => ("B8G8R8X8_UNORM", Some(Bgra8 { opaque: true })),
        90 => ("B8G8R8A8_TYPELESS", Some(Bgra8 { opaque: false })),
        91 => ("B8G8R8A8_UNORM_SRGB", Some(Bgra8 { opaque: false })),
        92 => ("B8G8R8X8_TYPELESS", Some(Bgra8 { opaque: true })),
        93 => ("B8G8R8X8_UNORM_SRGB", Some(Bgra8 { opaque: true })),
        94 => ("BC6H_TYPELESS", None),
        95 => ("BC6H_UF16", None),
        96 => ("BC6H_SF16", None),
        97 => ("BC7_TYPELESS", Some(Bc7)),
        98 => ("BC7_UNORM", Some(Bc7)),
        99 => ("BC7_UNORM_SRGB", Some(Bc7)),
        115 => ("B4G4R4A4_UNORM", Some(B4g4r4a4)),
        _ => ("", None),
    }
}

/// Reads the header. `Err` says why the file is not a DDS this decoder reads.
pub fn info(b: &[u8]) -> Result<DdsInfo, DecodeError> {
    if b.len() < 128 || &b[0..4] != b"DDS " {
        return Err(err(ErrorKind::Invalid, "not-dds", "not a DDS file (missing magic or header truncated)"));
    }
    if u32_at(b, 4) != 124 || u32_at(b, 76) != 32 {
        return Err(err(ErrorKind::Invalid, "invalid-header", "the DDS header or pixel format size is wrong"));
    }
    let flags = u32_at(b, 8);
    let height = u32_at(b, 12);
    let width = u32_at(b, 16);
    let pitch = (flags & DDSD_PITCH != 0).then(|| u32_at(b, 20)).filter(|&p| p > 0);
    let depth = u32_at(b, 24);
    let mip_count = u32_at(b, 28).max(1);
    let pf_flags = u32_at(b, 80);
    let fourcc = [b[84], b[85], b[86], b[87]];
    let caps2 = u32_at(b, 112);
    let mut extra_surfaces = caps2 & (DDSCAPS2_CUBEMAP | DDSCAPS2_VOLUME) != 0 || depth > 1;
    let mut info = DdsInfo {
        width,
        height,
        mip_count,
        format_name: String::new(),
        dxgi_format: None,
        pixel_format: PixelFormat::Rgba8,
        data_offset: 128,
        pitch,
        extra_surfaces,
    };
    if pf_flags & DDPF_FOURCC != 0 {
        let code = String::from_utf8_lossy(&fourcc).trim_end_matches('\0').to_string();
        let format = match &fourcc {
            b"DXT1" => PixelFormat::Bc1,
            b"DXT2" | b"DXT3" => PixelFormat::Bc2,
            b"DXT4" | b"DXT5" => PixelFormat::Bc3,
            b"RXGB" => PixelFormat::Rxgb,
            b"ATI1" | b"BC4U" => PixelFormat::Bc4,
            b"ATI2" | b"BC5U" => PixelFormat::Bc5,
            b"DX10" => {
                if b.len() < 148 {
                    return Err(err(ErrorKind::Truncated, "DX10", "the DX10 extension header is truncated"));
                }
                let dxgi_format = u32_at(b, 128);
                let dimension = u32_at(b, 132);
                let misc = u32_at(b, 136);
                let array_size = u32_at(b, 140);
                let (name, layout) = dxgi(dxgi_format);
                let label = if name.is_empty() { format!("DX10/{dxgi_format}") } else { name.to_string() };
                info.dxgi_format = Some(dxgi_format);
                info.data_offset = 148;
                info.format_name = label.clone();
                // A texture array, a cube map (misc flag 0x4) or a 3D texture (dimension 4) still
                // starts with the first surface's first mip.
                extra_surfaces |= array_size > 1 || misc & 0x4 != 0 || dimension == 4;
                info.extra_surfaces = extra_surfaces;
                info.pixel_format = layout.ok_or_else(|| {
                    err(
                        ErrorKind::Unsupported,
                        label.clone(),
                        if name.is_empty() {
                            format!("DXGI format {dxgi_format} is not a known texture format")
                        } else {
                            format!("{name} (DXGI {dxgi_format}) is not decoded: it is a floating point, high dynamic range or signed format")
                        },
                    )
                })?;
                return Ok(info);
            }
            _ => {
                let label = if code.is_empty() { "fourcc-empty".to_string() } else { code.clone() };
                let numeric = u32::from_le_bytes(fourcc);
                return Err(err(ErrorKind::Unsupported, label, format!("DDS FourCC {code:?} (0x{numeric:08x}) is not a supported format")));
            }
        };
        info.format_name = code;
        info.pixel_format = format;
        return Ok(info);
    }
    if pf_flags & DDPF_YUV != 0 {
        return Err(err(ErrorKind::Unsupported, "YUV", "YUV DDS textures are not decoded"));
    }
    if pf_flags & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA) == 0 {
        return Err(err(ErrorKind::Unsupported, "non-rgb", "the DDS is neither RGB, luminance, alpha nor a compressed format"));
    }
    let bits = u32_at(b, 88);
    if !matches!(bits, 8 | 16 | 24 | 32) {
        return Err(err(ErrorKind::Unsupported, format!("rgb{bits}"), format!("uncompressed bit depth {bits} is not 8, 16, 24 or 32")));
    }
    let alpha_mask = if pf_flags & (DDPF_ALPHAPIXELS | DDPF_ALPHA) != 0 { u32_at(b, 104) } else { 0 };
    let luminance = pf_flags & DDPF_LUMINANCE != 0;
    let alpha_only = pf_flags & DDPF_ALPHA != 0 && pf_flags & (DDPF_RGB | DDPF_LUMINANCE) == 0;
    let masks = if alpha_only { [0, 0, 0, alpha_mask] } else { [u32_at(b, 92), u32_at(b, 96), u32_at(b, 100), alpha_mask] };
    info.format_name = match (luminance, alpha_only, bits) {
        (true, _, _) => format!("L{bits}"),
        (_, true, _) => format!("A{bits}"),
        (_, _, 32) => "RGBA32".to_string(),
        (_, _, 24) => "RGB24".to_string(),
        _ => format!("RGB{bits}"),
    };
    info.pixel_format = PixelFormat::Masked { bits, masks, luminance };
    Ok(info)
}

/// Decodes the first mip level.
pub fn decode(b: &[u8], max_pixels: u64) -> Result<Decoded, DecodeError> {
    let info = info(b)?;
    check_size(info.width, info.height, max_pixels, &info.format_name)?;
    let image = decode_with(b, &info)?;
    Ok(Decoded { image, format: info.format_name })
}

fn decode_with(b: &[u8], info: &DdsInfo) -> Result<Image, DecodeError> {
    let (width, height) = (info.width, info.height);
    let data = &b[info.data_offset..];
    let truncated = || err(ErrorKind::Truncated, info.format_name.clone(), "the pixel data is shorter than the header says");
    let blocks = |block_bytes: usize| -> Result<&[u8], DecodeError> {
        let needed = width.div_ceil(4) as usize * height.div_ceil(4) as usize * block_bytes;
        data.get(..needed).ok_or_else(truncated)
    };
    use PixelFormat::*;
    Ok(match info.pixel_format {
        Bc1 => bc::decode_blocks(blocks(8)?, width, height, 8, |block, out| bc::bc1(block, out, true)),
        Bc2 => bc::decode_blocks(blocks(16)?, width, height, 16, bc::bc2),
        Bc3 => bc::decode_blocks(blocks(16)?, width, height, 16, bc::bc3),
        Rxgb => bc::decode_blocks(blocks(16)?, width, height, 16, |block, out| {
            bc::bc3(block, out);
            for pixel in out.chunks_exact_mut(4) {
                pixel[0] = pixel[3];
                pixel[3] = 255;
            }
        }),
        Bc4 => bc::decode_blocks(blocks(8)?, width, height, 8, bc::bc4),
        Bc5 => bc::decode_blocks(blocks(16)?, width, height, 16, bc::bc5),
        Bc7 => bc::decode_blocks(blocks(16)?, width, height, 16, bc7::decode_block),
        Masked { bits, masks, luminance } => {
            let bytes_per_pixel = (bits / 8) as usize;
            decode_rows(data, info, bytes_per_pixel, |px, out| {
                let value = px.iter().rev().fold(0u32, |acc, &byte| (acc << 8) | u32::from(byte));
                let red = channel(value, masks[0], 0);
                if luminance {
                    out.copy_from_slice(&[red, red, red, channel(value, masks[3], 255)]);
                } else {
                    out.copy_from_slice(&[red, channel(value, masks[1], 0), channel(value, masks[2], 0), channel(value, masks[3], 255)]);
                }
            })
            .ok_or_else(truncated)?
        }
        Rgba8 => decode_rows(data, info, 4, |px, out| out.copy_from_slice(px)).ok_or_else(truncated)?,
        Bgra8 { opaque } => decode_rows(data, info, 4, |px, out| {
            out.copy_from_slice(&[px[2], px[1], px[0], if opaque { 255 } else { px[3] }]);
        })
        .ok_or_else(truncated)?,
        Rgb10a2 => decode_rows(data, info, 4, |px, out| {
            let v = u32::from_le_bytes([px[0], px[1], px[2], px[3]]);
            out.copy_from_slice(&[channel(v, 0x3ff, 0), channel(v, 0x3ff << 10, 0), channel(v, 0x3ff << 20, 0), channel(v, 0x3 << 30, 255)]);
        })
        .ok_or_else(truncated)?,
        B5g6r5 => decode_rows(data, info, 2, |px, out| {
            let v = u32::from(u16::from_le_bytes([px[0], px[1]]));
            out.copy_from_slice(&[channel(v, 0xf800, 0), channel(v, 0x07e0, 0), channel(v, 0x001f, 0), 255]);
        })
        .ok_or_else(truncated)?,
        B5g5r5a1 => decode_rows(data, info, 2, |px, out| {
            let v = u32::from(u16::from_le_bytes([px[0], px[1]]));
            out.copy_from_slice(&[channel(v, 0x7c00, 0), channel(v, 0x03e0, 0), channel(v, 0x001f, 0), channel(v, 0x8000, 255)]);
        })
        .ok_or_else(truncated)?,
        B4g4r4a4 => decode_rows(data, info, 2, |px, out| {
            let v = u32::from(u16::from_le_bytes([px[0], px[1]]));
            out.copy_from_slice(&[channel(v, 0x0f00, 0), channel(v, 0x00f0, 0), channel(v, 0x000f, 0), channel(v, 0xf000, 255)]);
        })
        .ok_or_else(truncated)?,
        R8 => decode_rows(data, info, 1, |px, out| out.copy_from_slice(&[px[0], 0, 0, 255])).ok_or_else(truncated)?,
        R8g8 => decode_rows(data, info, 2, |px, out| out.copy_from_slice(&[px[0], px[1], 0, 255])).ok_or_else(truncated)?,
        A8 => decode_rows(data, info, 1, |px, out| out.copy_from_slice(&[0, 0, 0, px[0]])).ok_or_else(truncated)?,
    })
}

/// Scales the bits under `mask` to 0..=255, rounding like the TypeScript decoder.
fn channel(value: u32, mask: u32, absent: u8) -> u8 {
    if mask == 0 {
        return absent;
    }
    let shift = mask.trailing_zeros();
    let max = u64::from(mask >> shift);
    let raw = u64::from((value & mask) >> shift);
    ((raw * 255 * 2 + max) / (max * 2)) as u8
}

/// Uncompressed rows: honours a declared pitch, else rows are `width * bytes_per_pixel` bytes.
fn decode_rows(data: &[u8], info: &DdsInfo, bytes_per_pixel: usize, pixel: impl Fn(&[u8], &mut [u8])) -> Option<Image> {
    let (width, height) = (info.width as usize, info.height as usize);
    let tight = width * bytes_per_pixel;
    // Only a pitch that fits a row is honoured; writers that store the linear size there instead
    // would otherwise shear the image.
    let pitch = info.pitch.map(|p| p as usize).filter(|&p| p >= tight && p < tight + 4 * bytes_per_pixel).unwrap_or(tight);
    let needed = pitch * (height - 1) + tight;
    let data = data.get(..needed)?;
    let mut image = Image::new(info.width, info.height);
    for (y, row) in image.rgba.chunks_exact_mut(width * 4).enumerate() {
        let source = &data[y * pitch..y * pitch + tight];
        for (out, px) in row.chunks_exact_mut(4).zip(source.chunks_exact(bytes_per_pixel)) {
            pixel(px, out);
        }
    }
    Some(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_scales_masks() {
        assert_eq!(channel(0x1f, 0x1f, 0), 255);
        assert_eq!(channel(0x10, 0x1f, 0), 132);
        assert_eq!(channel(0, 0, 7), 7);
        assert_eq!(channel(0xff00_0000, 0xff00_0000, 0), 255);
    }
}
