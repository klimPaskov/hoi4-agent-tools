//! The uncompressed BMP variants of HOI4 maps: 8-bit indexed and 24-bit RGB, DIB40 or DIB124.
//!
//! Ported from `src/hoi4_agent_tools/map/bmp.ts` (`BmpImage.decode`, `rgbAt`, `paletteIndexAt`,
//! `diffBounds`, `offsetAt`, `rgbKey`) and `src/hoi4_agent_tools/core/render-budget.ts`
//! (`renderDimensionViolation`), commit `9b7dc80d`. The read side only: map writes (packet P13b)
//! add the mutations. Error codes and messages are the TypeScript ones, because the map model
//! reports a bitmap that does not decode as a finding with the decoder's code and message.

use serde_json::json;

use crate::model::MapError;

pub const RENDER_MAX_DIMENSION: i64 = 16_384;
pub const RENDER_MAX_PIXELS: i64 = 50_331_648;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// `rgbKey`: `r,g,b`.
    pub fn key(self) -> String {
        format!("{},{},{}", self.r, self.g, self.b)
    }

    pub fn packed(self) -> u32 {
        (u32::from(self.r) << 16) | (u32::from(self.g) << 8) | u32::from(self.b)
    }
}

/// `renderDimensionViolation` as an error (`assertRenderDimensions`), with an optional stricter
/// pixel ceiling.
pub fn check_render_dimensions(width: i64, height: i64, label: &str, maximum_pixels: Option<i64>) -> Result<(), MapError> {
    let maximum_dimension = RENDER_MAX_DIMENSION;
    let maximum_pixels = maximum_pixels.map_or(RENDER_MAX_PIXELS, |m| m.min(RENDER_MAX_PIXELS));
    if width <= 0 || height <= 0 {
        return Err(MapError::new(
            "RENDER_DIMENSIONS_BLOCKED",
            format!("{label} dimensions must be positive safe integers"),
            json!({ "label": label, "width": width, "height": height, "maximumDimension": maximum_dimension }),
        ));
    }
    if width > maximum_dimension || height > maximum_dimension {
        return Err(MapError::new(
            "RENDER_DIMENSIONS_BLOCKED",
            format!("{label} dimensions {width}x{height} exceed the fixed dimension ceiling"),
            json!({ "label": label, "width": width, "height": height, "maximumDimension": maximum_dimension }),
        ));
    }
    if maximum_pixels <= 0 || height > maximum_pixels / width {
        return Err(MapError::new(
            "RENDER_PIXELS_BLOCKED",
            format!("{label} area {width}x{height} exceeds the fixed per-artifact pixel ceiling"),
            json!({ "label": label, "width": width, "height": height, "pixels": width * height, "maximumPixels": maximum_pixels }),
        ));
    }
    Ok(())
}

/// A decoded BMP. Coordinates are top-left based, whatever the storage order.
#[derive(Clone, Debug)]
pub struct BmpImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub top_down: bool,
    pub bits_per_pixel: u8,
    pub dib_size: u32,
    pub pixel_offset: usize,
    pub row_stride: usize,
    pub palette: Vec<Rgb>,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

impl BmpImage {
    /// `BmpImage.decode`.
    pub fn decode(bytes: &[u8]) -> Result<BmpImage, MapError> {
        if bytes.len() < 54 || &bytes[0..2] != b"BM" {
            return Err(MapError::plain("MAP_BMP_SIGNATURE_INVALID", "File is not a Windows BMP"));
        }
        let pixel_offset = u32_at(bytes, 10) as usize;
        let dib_size = u32_at(bytes, 14);
        if dib_size != 40 && dib_size != 124 {
            return Err(MapError::new("MAP_BMP_DIB_UNSUPPORTED", "Only DIB40 and DIB124 BMP headers are supported", json!({ "dibSize": dib_size })));
        }
        if bytes.len() < 14 + dib_size as usize {
            return Err(MapError::plain("MAP_BMP_TRUNCATED", "BMP ends inside its DIB header"));
        }
        let width = i64::from(u32_at(bytes, 18) as i32);
        let signed_height = u32_at(bytes, 22) as i32;
        if signed_height == i32::MIN {
            return Err(MapError::plain("MAP_BMP_DIMENSIONS_INVALID", "BMP height cannot be INT32_MIN"));
        }
        let height = i64::from(signed_height).abs();
        if width <= 0 || height <= 0 {
            return Err(MapError::new("MAP_BMP_DIMENSIONS_INVALID", "BMP dimensions must be positive integers", json!({ "width": width, "height": height })));
        }
        check_render_dimensions(width, height, "map BMP", None)?;
        if u16_at(bytes, 26) != 1 {
            return Err(MapError::plain("MAP_BMP_PLANES_INVALID", "BMP must contain exactly one plane"));
        }
        let bits = u16_at(bytes, 28);
        if bits != 8 && bits != 24 {
            return Err(MapError::new(
                "MAP_BMP_BPP_UNSUPPORTED",
                "HOI4 map BMP codec supports only 8-bit indexed and 24-bit RGB files",
                json!({ "bitsPerPixel": bits }),
            ));
        }
        if u32_at(bytes, 30) != 0 {
            return Err(MapError::plain("MAP_BMP_COMPRESSION_UNSUPPORTED", "Compressed map BMP files are not supported"));
        }
        let (width, height) = (width as usize, height as usize);
        let stride = (width * bits as usize).div_ceil(32) * 4;
        let pixel_bytes = stride * height;
        if pixel_offset < 14 + dib_size as usize || pixel_offset + pixel_bytes > bytes.len() {
            return Err(MapError::new(
                "MAP_BMP_TRUNCATED",
                "BMP pixel array is outside the file bounds",
                json!({ "pixelOffset": pixel_offset, "pixelBytes": pixel_bytes, "fileSize": bytes.len() }),
            ));
        }
        let mut palette = Vec::new();
        if bits == 8 {
            let available = (pixel_offset - (14 + dib_size as usize)) / 4;
            let colors_used = u32_at(bytes, 46) as usize;
            let count = if colors_used == 0 { available.min(256) } else { colors_used };
            if count > 256 || count > available {
                return Err(MapError::new(
                    "MAP_BMP_PALETTE_INVALID",
                    "Indexed BMP palette is incomplete",
                    json!({ "colorsUsed": colors_used, "availableEntries": available }),
                ));
            }
            for index in 0..count {
                let at = 14 + dib_size as usize + index * 4;
                palette.push(Rgb { r: bytes[at + 2], g: bytes[at + 1], b: bytes[at] });
            }
        }
        Ok(BmpImage {
            bytes: bytes.to_vec(),
            width: width as u32,
            height: height as u32,
            top_down: signed_height < 0,
            bits_per_pixel: bits as u8,
            dib_size,
            pixel_offset,
            row_stride: stride,
            palette,
        })
    }

    fn offset_at(&self, x: u32, y: u32) -> usize {
        let row = if self.top_down { y } else { self.height - 1 - y } as usize;
        self.pixel_offset + row * self.row_stride + x as usize * (self.bits_per_pixel as usize / 8)
    }

    /// `rgbAt`; `None` with the index when an 8-bit pixel refers outside the palette.
    pub fn rgb_at(&self, x: u32, y: u32) -> Result<Rgb, MapError> {
        let offset = self.offset_at(x, y);
        if self.bits_per_pixel == 24 {
            return Ok(Rgb { r: self.bytes[offset + 2], g: self.bytes[offset + 1], b: self.bytes[offset] });
        }
        let index = self.bytes[offset];
        self.palette
            .get(index as usize)
            .copied()
            .ok_or_else(|| MapError::new("MAP_BMP_PALETTE_INDEX_INVALID", "Pixel refers outside the BMP palette", json!({ "x": x, "y": y, "index": index })))
    }

    /// `paletteIndexAt` of an 8-bit bitmap.
    pub fn palette_index_at(&self, x: u32, y: u32) -> u8 {
        self.bytes[self.offset_at(x, y)]
    }

    /// `diffBounds`: the box of the pixels whose colour differs, and their count.
    pub fn diff_bounds(&self, other: &BmpImage) -> Result<Option<[u32; 5]>, MapError> {
        if self.width != other.width || self.height != other.height {
            return Err(MapError::plain("MAP_BMP_DIMENSION_MISMATCH", "Cannot diff BMPs with different dimensions"));
        }
        let (mut min_x, mut min_y, mut max_x, mut max_y, mut count) = (self.width, self.height, 0, 0, 0u32);
        for y in 0..self.height {
            for x in 0..self.width {
                if self.rgb_at(x, y)? == other.rgb_at(x, y)? {
                    continue;
                }
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                count += 1;
            }
        }
        Ok((count > 0).then_some([min_x, min_y, max_x, max_y, count]))
    }
}

/// A synthetic bitmap for tests and fixtures: 24-bit bottom-up DIB40, or 8-bit with a palette.
pub fn encode_bmp(width: u32, height: u32, bits: u8, palette: &[Rgb], pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let stride = (width as usize * bits as usize).div_ceil(32) * 4;
    let palette_bytes = if bits == 8 { palette.len() * 4 } else { 0 };
    let pixel_offset = 54 + palette_bytes;
    let size = pixel_offset + stride * height as usize;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&u16::from(bits).to_le_bytes());
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&(if bits == 8 { palette.len() as u32 } else { 0 }).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    for color in palette.iter().take(if bits == 8 { palette.len() } else { 0 }) {
        out.extend_from_slice(&[color.b, color.g, color.r, 0]);
    }
    for row in 0..height {
        let y = height - 1 - row;
        let start = out.len();
        for x in 0..width {
            let p = pixel(x, y);
            if bits == 8 {
                out.push(p[0]);
            } else {
                out.extend_from_slice(&[p[2], p[1], p[0]]);
            }
        }
        out.resize(start + stride, 0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_rgb_and_indexed_bitmaps_top_left_based() {
        let bytes = encode_bmp(3, 2, 24, &[], |x, y| [x as u8, y as u8, 7]);
        let image = BmpImage::decode(&bytes).unwrap();
        assert_eq!((image.width, image.height, image.top_down, image.row_stride), (3, 2, false, 12));
        assert_eq!(image.rgb_at(2, 1).unwrap(), Rgb { r: 2, g: 1, b: 7 });
        let palette = [Rgb { r: 1, g: 2, b: 3 }];
        let indexed = BmpImage::decode(&encode_bmp(2, 2, 8, &palette, |x, _| [x as u8, 0, 0])).unwrap();
        assert_eq!(indexed.rgb_at(0, 0).unwrap(), palette[0]);
        assert_eq!(indexed.rgb_at(1, 0).unwrap_err().code, "MAP_BMP_PALETTE_INDEX_INVALID");
    }

    #[test]
    fn refuses_what_the_typescript_codec_refuses() {
        assert_eq!(BmpImage::decode(b"XX").unwrap_err().code, "MAP_BMP_SIGNATURE_INVALID");
        let mut bytes = encode_bmp(2, 2, 24, &[], |_, _| [0, 0, 0]);
        bytes[28] = 32;
        assert_eq!(BmpImage::decode(&bytes).unwrap_err().code, "MAP_BMP_BPP_UNSUPPORTED");
        let mut bytes = encode_bmp(2, 2, 24, &[], |_, _| [0, 0, 0]);
        bytes[30] = 1;
        assert_eq!(BmpImage::decode(&bytes).unwrap_err().code, "MAP_BMP_COMPRESSION_UNSUPPORTED");
        let bytes = encode_bmp(2, 2, 24, &[], |_, _| [0, 0, 0]);
        assert_eq!(BmpImage::decode(&bytes[..60]).unwrap_err().code, "MAP_BMP_TRUNCATED");
        let mut bytes = encode_bmp(2, 2, 24, &[], |_, _| [0, 0, 0]);
        bytes[18..22].copy_from_slice(&20_000i32.to_le_bytes());
        assert_eq!(BmpImage::decode(&bytes).unwrap_err().code, "RENDER_DIMENSIONS_BLOCKED");
    }

    #[test]
    fn bounds_the_changed_pixels() {
        let left = BmpImage::decode(&encode_bmp(4, 4, 24, &[], |_, _| [0, 0, 0])).unwrap();
        let right = BmpImage::decode(&encode_bmp(4, 4, 24, &[], |x, y| if (x, y) == (1, 2) || (x, y) == (3, 0) { [9, 9, 9] } else { [0, 0, 0] })).unwrap();
        assert_eq!(left.diff_bounds(&right).unwrap(), Some([1, 0, 3, 2, 2]));
        assert_eq!(left.diff_bounds(&left).unwrap(), None);
    }
}
