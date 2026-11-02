//! BC1 to BC5 (DXT1 to DXT5, ATI1, ATI2) blocks. Interpolated values round to nearest, as the
//! TypeScript decoder does, so both decoders produce the same pixels.

use crate::Image;

/// Decodes 4x4 blocks in row order into an image, cropping the blocks at the right and bottom edge.
/// `block` writes 16 RGBA pixels, row by row, into its 64-byte output.
pub(crate) fn decode_blocks(data: &[u8], width: u32, height: u32, block_bytes: usize, block: impl Fn(&[u8], &mut [u8; 64])) -> Image {
    let mut image = Image::new(width, height);
    let (width, height) = (width as usize, height as usize);
    let blocks_wide = width.div_ceil(4);
    let mut pixels = [0u8; 64];
    for (index, source) in data.chunks_exact(block_bytes).enumerate() {
        let (bx, by) = (index % blocks_wide * 4, index / blocks_wide * 4);
        if by >= height {
            break;
        }
        block(source, &mut pixels);
        for row in 0..4.min(height - by) {
            let columns = 4.min(width - bx);
            let target = ((by + row) * width + bx) * 4;
            image.rgba[target..target + columns * 4].copy_from_slice(&pixels[row * 16..row * 16 + columns * 4]);
        }
    }
    image
}

fn expand565(value: u16) -> [u8; 3] {
    let r = ((value >> 11) & 0x1f) as u8;
    let g = ((value >> 5) & 0x3f) as u8;
    let b = (value & 0x1f) as u8;
    [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

fn mix(a: u8, b: u8, wa: u32, wb: u32) -> u8 {
    let total = wa + wb;
    ((u32::from(a) * wa + u32::from(b) * wb) * 2 + total).div_euclid(total * 2) as u8
}

/// A BC1 colour block. `punch_through` allows the three-colour mode with transparent black,
/// which BC2 and BC3 colour blocks never use.
pub(crate) fn bc1(block: &[u8], out: &mut [u8; 64], punch_through: bool) {
    let c0 = u16::from_le_bytes([block[0], block[1]]);
    let c1 = u16::from_le_bytes([block[2], block[3]]);
    let (a, b) = (expand565(c0), expand565(c1));
    let mut palette = [[0u8; 4]; 4];
    palette[0] = [a[0], a[1], a[2], 255];
    palette[1] = [b[0], b[1], b[2], 255];
    if punch_through && c0 <= c1 {
        palette[2] = [mix(a[0], b[0], 1, 1), mix(a[1], b[1], 1, 1), mix(a[2], b[2], 1, 1), 255];
        palette[3] = [0, 0, 0, 0];
    } else {
        palette[2] = [mix(a[0], b[0], 2, 1), mix(a[1], b[1], 2, 1), mix(a[2], b[2], 2, 1), 255];
        palette[3] = [mix(a[0], b[0], 1, 2), mix(a[1], b[1], 1, 2), mix(a[2], b[2], 1, 2), 255];
    }
    let indices = u32::from_le_bytes([block[4], block[5], block[6], block[7]]);
    for pixel in 0..16 {
        let entry = palette[((indices >> (pixel * 2)) & 3) as usize];
        out[pixel * 4..pixel * 4 + 4].copy_from_slice(&entry);
    }
}

/// BC2 (DXT3): explicit 4-bit alpha, then a BC1 colour block.
pub(crate) fn bc2(block: &[u8], out: &mut [u8; 64]) {
    bc1(&block[8..16], out, false);
    for pixel in 0..16 {
        let nibble = (block[pixel / 2] >> ((pixel % 2) * 4)) & 0xf;
        out[pixel * 4 + 3] = nibble * 17;
    }
}

/// One 8-byte BC4 channel block (also BC3 alpha) into `channel` of every pixel.
fn bc4_channel(block: &[u8], out: &mut [u8; 64], channel: usize) {
    let (e0, e1) = (block[0], block[1]);
    let mut palette = [0u8; 8];
    palette[0] = e0;
    palette[1] = e1;
    if e0 > e1 {
        for i in 1..7u32 {
            palette[i as usize + 1] = mix(e0, e1, 7 - i, i);
        }
    } else {
        for i in 1..5u32 {
            palette[i as usize + 1] = mix(e0, e1, 5 - i, i);
        }
        palette[6] = 0;
        palette[7] = 255;
    }
    let bits = block[2..8].iter().rev().fold(0u64, |acc, &byte| (acc << 8) | u64::from(byte));
    for pixel in 0..16 {
        out[pixel * 4 + channel] = palette[((bits >> (pixel * 3)) & 7) as usize];
    }
}

/// BC3 (DXT5): interpolated alpha, then a BC1 colour block.
pub(crate) fn bc3(block: &[u8], out: &mut [u8; 64]) {
    bc1(&block[8..16], out, false);
    bc4_channel(&block[0..8], out, 3);
}

/// BC4 (ATI1): one channel, drawn as red.
pub(crate) fn bc4(block: &[u8], out: &mut [u8; 64]) {
    for pixel in out.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[0, 0, 0, 255]);
    }
    bc4_channel(block, out, 0);
}

/// BC5 (ATI2): red and green channels.
pub(crate) fn bc5(block: &[u8], out: &mut [u8; 64]) {
    for pixel in out.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[0, 0, 0, 255]);
    }
    bc4_channel(&block[0..8], out, 0);
    bc4_channel(&block[8..16], out, 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bc1_four_colour_and_punch_through() {
        // c0 = white, c1 = black, indices 0,1,2,3 in the first row.
        let mut out = [0u8; 64];
        bc1(&[0xff, 0xff, 0, 0, 0b1110_0100, 0, 0, 0], &mut out, true);
        assert_eq!(&out[0..16], &[255, 255, 255, 255, 0, 0, 0, 255, 170, 170, 170, 255, 85, 85, 85, 255]);
        // c0 <= c1 switches to three colours and transparent black.
        bc1(&[0, 0, 0xff, 0xff, 0b1110_0100, 0, 0, 0], &mut out, true);
        assert_eq!(&out[8..16], &[128, 128, 128, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn bc3_alpha_palette() {
        let mut out = [0u8; 64];
        // Alpha 255 and 0 with eight-value interpolation. Indices 0, 2, 1: 255, (6*255 + 0)/7, 0.
        let block = [255, 0, 0b0101_0000, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];
        bc3(&block, &mut out);
        assert_eq!(out[3], 255);
        assert_eq!(out[7], 219);
        assert_eq!(out[11], 0);
    }
}
