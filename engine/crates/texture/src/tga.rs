//! TGA: true-colour (16, 24 and 32 bit), greyscale and colour-mapped images, uncompressed or
//! run-length encoded, with any origin. Matches the TypeScript decoder pixel for pixel.

use crate::{DecodeError, Decoded, ErrorKind, Image, check_size};

fn err(kind: ErrorKind, format: impl Into<String>, message: impl Into<String>) -> DecodeError {
    DecodeError::new(kind, format, message)
}

fn scale5(value: u16) -> u8 {
    ((u32::from(value) * 255 * 2 + 31) / 62) as u8
}

pub fn decode(b: &[u8], max_pixels: u64) -> Result<Decoded, DecodeError> {
    if b.len() < 18 {
        return Err(err(ErrorKind::Invalid, "tga", "the TGA header is truncated"));
    }
    let id_length = usize::from(b[0]);
    let map_type = b[1];
    let image_type = b[2];
    let map_first = usize::from(u16::from_le_bytes([b[3], b[4]]));
    let map_length = usize::from(u16::from_le_bytes([b[5], b[6]]));
    let map_depth = b[7];
    let width = u32::from(u16::from_le_bytes([b[12], b[13]]));
    let height = u32::from(u16::from_le_bytes([b[14], b[15]]));
    let depth = b[16];
    let descriptor = b[17];
    let rle = matches!(image_type, 9..=11);
    let base = if rle { image_type - 8 } else { image_type };
    let format = match base {
        1 => format!("TGA indexed {depth} bit"),
        2 => format!("TGA {depth} bit"),
        3 => format!("TGA grey {depth} bit"),
        _ => format!("tga-type-{image_type}"),
    };
    let format = if rle { format!("{format} RLE") } else { format };
    if !(1..=3).contains(&base) {
        return Err(err(ErrorKind::Unsupported, format, format!("TGA image type {image_type} is not indexed, true-colour or greyscale")));
    }
    check_size(width, height, max_pixels, &format)?;
    let depth_ok = match base {
        1 => map_type == 1 && matches!(depth, 8 | 16),
        2 => matches!(depth, 16 | 24 | 32),
        _ => matches!(depth, 8 | 16),
    };
    if !depth_ok {
        return Err(err(ErrorKind::Unsupported, format.clone(), format!("{format} is not a supported depth")));
    }
    let attribute_bits = descriptor & 0x0f;
    let mut cursor = 18 + id_length;
    let mut palette = vec![[255u8, 0, 255, 255]; map_first + map_length];
    if map_type == 1 {
        let entry = usize::from(map_depth).div_ceil(8);
        if !matches!(entry, 2..=4) {
            return Err(err(ErrorKind::Unsupported, format, format!("TGA palette depth {map_depth} is not supported")));
        }
        let table = b.get(cursor..cursor + map_length * entry).ok_or_else(|| err(ErrorKind::Truncated, format.clone(), "the colour map is truncated"))?;
        for (index, source) in table.chunks_exact(entry).enumerate() {
            palette[map_first + index] = if entry == 2 {
                let packed = u16::from_le_bytes([source[0], source[1]]);
                [
                    scale5((packed >> 10) & 0x1f),
                    scale5((packed >> 5) & 0x1f),
                    scale5(packed & 0x1f),
                    if attribute_bits == 0 || packed & 0x8000 != 0 { 255 } else { 0 },
                ]
            } else {
                [source[2], source[1], source[0], if entry == 4 { source[3] } else { 255 }]
            };
        }
        cursor += map_length * entry;
    }
    let pixel_bytes = usize::from(depth).div_ceil(8);
    let read = |px: &[u8]| -> [u8; 4] {
        match (base, depth) {
            (1, 8) => palette.get(usize::from(px[0])).copied().unwrap_or([255, 0, 255, 255]),
            (1, _) => palette.get(usize::from(u16::from_le_bytes([px[0], px[1]]))).copied().unwrap_or([255, 0, 255, 255]),
            (3, 8) => [px[0], px[0], px[0], 255],
            (3, _) => [px[0], px[0], px[0], px[1]],
            (_, 16) => {
                let packed = u16::from_le_bytes([px[0], px[1]]);
                [
                    scale5((packed >> 10) & 0x1f),
                    scale5((packed >> 5) & 0x1f),
                    scale5(packed & 0x1f),
                    if attribute_bits == 0 || packed & 0x8000 != 0 { 255 } else { 0 },
                ]
            }
            (_, 24) => [px[2], px[1], px[0], 255],
            _ => [px[2], px[1], px[0], px[3]],
        }
    };
    let total = width as usize * height as usize;
    let mut pixels: Vec<[u8; 4]> = Vec::with_capacity(total);
    let truncated = || err(ErrorKind::Truncated, format.clone(), "the pixel data is truncated");
    if rle {
        while pixels.len() < total {
            let header = *b.get(cursor).ok_or_else(truncated)?;
            cursor += 1;
            let count = usize::from(header & 0x7f) + 1;
            if header & 0x80 != 0 {
                let px = b.get(cursor..cursor + pixel_bytes).ok_or_else(truncated)?;
                cursor += pixel_bytes;
                let colour = read(px);
                for _ in 0..count.min(total - pixels.len()) {
                    pixels.push(colour);
                }
            } else {
                for _ in 0..count {
                    let px = b.get(cursor..cursor + pixel_bytes).ok_or_else(truncated)?;
                    cursor += pixel_bytes;
                    if pixels.len() < total {
                        pixels.push(read(px));
                    }
                }
            }
        }
    } else {
        let data = b.get(cursor..cursor + total * pixel_bytes).ok_or_else(truncated)?;
        pixels.extend(data.chunks_exact(pixel_bytes).map(read));
    }
    let top_origin = descriptor & 0x20 != 0;
    let right_origin = descriptor & 0x10 != 0;
    let mut image = Image::new(width, height);
    let (w, h) = (width as usize, height as usize);
    for (index, colour) in pixels.into_iter().enumerate() {
        let (sx, sy) = (index % w, index / w);
        let tx = if right_origin { w - sx - 1 } else { sx };
        let ty = if top_origin { sy } else { h - sy - 1 };
        let target = (ty * w + tx) * 4;
        image.rgba[target..target + 4].copy_from_slice(&colour);
    }
    Ok(Decoded { image, format })
}
