//! BC7 blocks, as the Direct3D 11 functional specification defines them: eight modes, 64 two- and
//! three-subset partitions, endpoint p-bits, rotation and index selection. BC7 is bit exact, so
//! every conforming decoder produces the same pixels.

/// Per mode: subsets, partition bits, rotation bits, index-selection bits, colour bits, alpha
/// bits, p-bits per endpoint, shared p-bits per subset, index bits, secondary index bits.
struct Mode {
    subsets: usize,
    partition_bits: u32,
    rotation_bits: u32,
    selection_bits: u32,
    color_bits: u32,
    alpha_bits: u32,
    endpoint_pbits: bool,
    shared_pbits: bool,
    index_bits: u32,
    index2_bits: u32,
}

const MODES: [Mode; 8] = [
    Mode {
        subsets: 3,
        partition_bits: 4,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 4,
        alpha_bits: 0,
        endpoint_pbits: true,
        shared_pbits: false,
        index_bits: 3,
        index2_bits: 0,
    },
    Mode {
        subsets: 2,
        partition_bits: 6,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 6,
        alpha_bits: 0,
        endpoint_pbits: false,
        shared_pbits: true,
        index_bits: 3,
        index2_bits: 0,
    },
    Mode {
        subsets: 3,
        partition_bits: 6,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 5,
        alpha_bits: 0,
        endpoint_pbits: false,
        shared_pbits: false,
        index_bits: 2,
        index2_bits: 0,
    },
    Mode {
        subsets: 2,
        partition_bits: 6,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 7,
        alpha_bits: 0,
        endpoint_pbits: true,
        shared_pbits: false,
        index_bits: 2,
        index2_bits: 0,
    },
    Mode {
        subsets: 1,
        partition_bits: 0,
        rotation_bits: 2,
        selection_bits: 1,
        color_bits: 5,
        alpha_bits: 6,
        endpoint_pbits: false,
        shared_pbits: false,
        index_bits: 2,
        index2_bits: 3,
    },
    Mode {
        subsets: 1,
        partition_bits: 0,
        rotation_bits: 2,
        selection_bits: 0,
        color_bits: 7,
        alpha_bits: 8,
        endpoint_pbits: false,
        shared_pbits: false,
        index_bits: 2,
        index2_bits: 2,
    },
    Mode {
        subsets: 1,
        partition_bits: 0,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 7,
        alpha_bits: 7,
        endpoint_pbits: true,
        shared_pbits: false,
        index_bits: 4,
        index2_bits: 0,
    },
    Mode {
        subsets: 2,
        partition_bits: 6,
        rotation_bits: 0,
        selection_bits: 0,
        color_bits: 5,
        alpha_bits: 5,
        endpoint_pbits: true,
        shared_pbits: false,
        index_bits: 2,
        index2_bits: 0,
    },
];

/// Two-subset partitions: bit `i` set means pixel `i` belongs to subset 1.
const PARTITIONS2: [u16; 64] = [
    0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000, 0xf710, 0x008e, 0x7100,
    0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c, 0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa,
    0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660, 0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336,
    0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
];

/// Three-subset partitions, the subset of each pixel in row order.
const PARTITIONS3: [[u8; 16]; 64] = [
    [0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2],
    [0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1],
    [0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1],
    [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2],
    [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2],
    [0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2],
    [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2],
    [0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2],
    [0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2],
    [0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2],
    [0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2],
    [0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0],
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2],
    [0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0],
    [0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2],
    [0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1],
    [0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2],
    [0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1],
    [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2],
    [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0],
    [0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0],
    [0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2],
    [0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1],
    [0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2],
    [0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2],
    [0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1],
    [0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1],
    [0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2],
    [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1],
    [0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2],
    [0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0],
    [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0],
    [0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0],
    [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1],
    [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1],
    [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2],
    [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1],
    [0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2],
    [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1],
    [0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1],
    [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1],
    [0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2],
    [0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1],
    [0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2],
    [0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2],
    [0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2],
    [0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2],
    [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2],
    [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2],
    [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2],
    [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2],
    [0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2],
    [0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1],
    [0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2],
    [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    [0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0],
];

/// The anchor (first-index) pixel of subset 1 in the two-subset partitions.
const ANCHOR2: [u8; 64] = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2,
    2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

/// The anchor pixels of subsets 1 and 2 in the three-subset partitions.
const ANCHOR3_1: [u8; 64] = [
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15,
    15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];
const ANCHOR3_2: [u8; 64] = [
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8,
    15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];

const WEIGHTS2: [u32; 4] = [0, 21, 43, 64];
const WEIGHTS3: [u32; 8] = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHTS4: [u32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

fn weights(bits: u32) -> &'static [u32] {
    match bits {
        2 => &WEIGHTS2,
        3 => &WEIGHTS3,
        _ => &WEIGHTS4,
    }
}

/// Reads a block's bits from the least significant bit of byte 0 upwards.
struct Bits {
    value: u128,
    position: u32,
}

impl Bits {
    fn read(&mut self, count: u32) -> u32 {
        if count == 0 {
            return 0;
        }
        let value = ((self.value >> self.position) & ((1u128 << count) - 1)) as u32;
        self.position += count;
        value
    }
}

fn subset_of(subsets: usize, partition: usize, pixel: usize) -> usize {
    match subsets {
        2 => usize::from(PARTITIONS2[partition] >> pixel & 1 == 1),
        3 => usize::from(PARTITIONS3[partition][pixel]),
        _ => 0,
    }
}

fn is_anchor(subsets: usize, partition: usize, pixel: usize) -> bool {
    pixel == 0
        || match subsets {
            2 => pixel == usize::from(ANCHOR2[partition]),
            3 => pixel == usize::from(ANCHOR3_1[partition]) || pixel == usize::from(ANCHOR3_2[partition]),
            _ => false,
        }
}

fn interpolate(e0: u8, e1: u8, weight: u32) -> u8 {
    (((64 - weight) * u32::from(e0) + weight * u32::from(e1) + 32) >> 6) as u8
}

/// Decodes one 16-byte block into 16 RGBA pixels. Reserved mode 8 (a zero first byte) decodes
/// to transparent black, as the specification requires.
pub(crate) fn decode_block(block: &[u8], out: &mut [u8; 64]) {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&block[..16]);
    let mut bits = Bits { value: u128::from_le_bytes(bytes), position: 0 };
    let mode_index = block[0].trailing_zeros();
    if mode_index >= 8 {
        out.fill(0);
        return;
    }
    bits.position = mode_index + 1;
    let mode = &MODES[mode_index as usize];
    let partition = bits.read(mode.partition_bits) as usize;
    let rotation = bits.read(mode.rotation_bits);
    let selection = bits.read(mode.selection_bits);

    // endpoints[subset * 2 + end][channel], read channel by channel.
    let mut endpoints = [[0u32; 4]; 6];
    let ends = mode.subsets * 2;
    for channel in 0..3 {
        for endpoint in endpoints.iter_mut().take(ends) {
            endpoint[channel] = bits.read(mode.color_bits);
        }
    }
    if mode.alpha_bits > 0 {
        for endpoint in endpoints.iter_mut().take(ends) {
            endpoint[3] = bits.read(mode.alpha_bits);
        }
    }
    let mut color_bits = mode.color_bits;
    let mut alpha_bits = mode.alpha_bits;
    if mode.endpoint_pbits || mode.shared_pbits {
        let mut pbits = [0u32; 6];
        if mode.endpoint_pbits {
            for pbit in pbits.iter_mut().take(ends) {
                *pbit = bits.read(1);
            }
        } else {
            for subset in 0..mode.subsets {
                let shared = bits.read(1);
                pbits[subset * 2] = shared;
                pbits[subset * 2 + 1] = shared;
            }
        }
        for (endpoint, pbit) in endpoints.iter_mut().zip(pbits).take(ends) {
            for (channel, value) in endpoint.iter_mut().enumerate() {
                if channel < 3 || mode.alpha_bits > 0 {
                    *value = (*value << 1) | pbit;
                }
            }
        }
        color_bits += 1;
        if alpha_bits > 0 {
            alpha_bits += 1;
        }
    }
    // Expand to eight bits by repeating the high bits.
    let expand = |value: u32, width: u32| -> u8 {
        let shifted = value << (8 - width);
        (shifted | (shifted >> width)) as u8
    };
    let mut colors = [[0u8; 4]; 6];
    for (color, endpoint) in colors.iter_mut().zip(endpoints).take(ends) {
        for channel in 0..3 {
            color[channel] = expand(endpoint[channel], color_bits);
        }
        color[3] = if alpha_bits > 0 { expand(endpoint[3], alpha_bits) } else { 255 };
    }

    let mut indices = [0u32; 16];
    for (pixel, index) in indices.iter_mut().enumerate() {
        let anchor = is_anchor(mode.subsets, partition, pixel);
        *index = bits.read(mode.index_bits - u32::from(anchor));
    }
    let mut indices2 = [0u32; 16];
    if mode.index2_bits > 0 {
        for (pixel, index) in indices2.iter_mut().enumerate() {
            *index = bits.read(mode.index2_bits - u32::from(pixel == 0));
        }
    }

    for pixel in 0..16 {
        let subset = subset_of(mode.subsets, partition, pixel);
        let (e0, e1) = (colors[subset * 2], colors[subset * 2 + 1]);
        let (color_weight, alpha_weight) = if mode.index2_bits == 0 {
            let weight = weights(mode.index_bits)[indices[pixel] as usize];
            (weight, weight)
        } else if selection == 0 {
            (weights(mode.index_bits)[indices[pixel] as usize], weights(mode.index2_bits)[indices2[pixel] as usize])
        } else {
            (weights(mode.index2_bits)[indices2[pixel] as usize], weights(mode.index_bits)[indices[pixel] as usize])
        };
        let mut rgba = [
            interpolate(e0[0], e1[0], color_weight),
            interpolate(e0[1], e1[1], color_weight),
            interpolate(e0[2], e1[2], color_weight),
            interpolate(e0[3], e1[3], alpha_weight),
        ];
        match rotation {
            1 => rgba.swap(0, 3),
            2 => rgba.swap(1, 3),
            3 => rgba.swap(2, 3),
            _ => {}
        }
        out[pixel * 4..pixel * 4 + 4].copy_from_slice(&rgba);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_lie_in_their_subset() {
        for partition in 0..64 {
            assert_eq!(subset_of(2, partition, usize::from(ANCHOR2[partition])), 1, "2-subset partition {partition}");
            assert_eq!(subset_of(3, partition, usize::from(ANCHOR3_1[partition])), 1, "3-subset partition {partition}");
            assert_eq!(subset_of(3, partition, usize::from(ANCHOR3_2[partition])), 2, "3-subset partition {partition}");
            assert_eq!(subset_of(2, partition, 0), 0);
            assert_eq!(subset_of(3, partition, 0), 0);
        }
    }

    #[test]
    fn reserved_mode_is_transparent_black() {
        let mut out = [7u8; 64];
        decode_block(&[0u8; 16], &mut out);
        assert_eq!(out, [0u8; 64]);
    }

    #[test]
    fn mode6_solid_white() {
        // Mode 6: bit 6 set. All endpoint and p-bits set gives 255 everywhere, whatever the indices.
        let mut block = [0xffu8; 16];
        block[0] = 0b0100_0000 | 0x80;
        let mut out = [0u8; 64];
        decode_block(&block, &mut out);
        assert!(out.iter().all(|&v| v == 255), "{out:?}");
    }
}
