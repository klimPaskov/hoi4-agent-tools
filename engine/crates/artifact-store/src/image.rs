//! Offline PNG comparison and the transparent review baseline.
//!
//! Ported from `src/hoi4_agent_tools/core/image-diff.ts` (`comparePngImages`,
//! `createTransparentPng`) and `render-budget.ts` (`renderDimensionViolation`, `RenderBudget`),
//! commit `9b7dc80d`. The counts, the pixel colours and the JSON are the TypeScript ones; the
//! encoded PNG bytes are this encoder's (the TypeScript server used libvips), so a comparison of
//! the two servers is by decoded pixels. Two fixes against the TypeScript code: a grayscale or
//! palette PNG is expanded to RGBA before the compare (Sharp's raw output of a grayscale image had
//! fewer channels than the compare read), and every input is decoded at 8 bits per channel.

use std::io::Cursor;

use hoi4_core::canonical::canonical_json;
use serde::Serialize;
use serde_json::json;

use crate::error::{StoreError, StoreResult};

pub const RENDER_MAX_DIMENSION: u64 = 16_384;
pub const RENDER_MAX_PIXELS: u64 = 50_331_648;
pub const RENDER_MAX_AGGREGATE_PIXELS: u64 = 67_108_864;

/// Validates dimensions before any pixel allocation (`assertRenderDimensions`).
pub fn assert_render_dimensions(width: u64, height: u64, label: &str) -> StoreResult<u64> {
    if width == 0 || height == 0 {
        return Err(StoreError::with_details(
            "RENDER_DIMENSIONS_BLOCKED",
            format!("{label} dimensions must be positive safe integers"),
            json!({ "label": label, "width": width, "height": height, "maximumDimension": RENDER_MAX_DIMENSION }),
        ));
    }
    if width > RENDER_MAX_DIMENSION || height > RENDER_MAX_DIMENSION {
        return Err(StoreError::with_details(
            "RENDER_DIMENSIONS_BLOCKED",
            format!("{label} dimensions {width}x{height} exceed the fixed dimension ceiling"),
            json!({ "label": label, "width": width, "height": height, "maximumDimension": RENDER_MAX_DIMENSION }),
        ));
    }
    if height > RENDER_MAX_PIXELS / width {
        return Err(StoreError::with_details(
            "RENDER_PIXELS_BLOCKED",
            format!("{label} area {width}x{height} exceeds the fixed per-artifact pixel ceiling"),
            json!({ "label": label, "width": width, "height": height, "pixels": width * height, "maximumPixels": RENDER_MAX_PIXELS }),
        ));
    }
    Ok(width * height)
}

/// Accumulates RGBA-equivalent pixel planes for one logical request.
#[derive(Debug, Default)]
pub struct RenderBudget {
    pub reserved_pixels: u64,
}

impl RenderBudget {
    pub fn reserve(&mut self, width: u64, height: u64, label: &str) -> StoreResult<u64> {
        let pixels = assert_render_dimensions(width, height, label)?;
        if pixels > RENDER_MAX_AGGREGATE_PIXELS.saturating_sub(self.reserved_pixels) {
            return Err(StoreError::with_details(
                "RENDER_AGGREGATE_BLOCKED",
                format!("{label} exceeds the fixed aggregate render budget for one request"),
                json!({
                    "label": label, "width": width, "height": height, "pixels": pixels,
                    "reservedPixels": self.reserved_pixels, "requestedPixels": self.reserved_pixels + pixels,
                    "maximumAggregatePixels": RENDER_MAX_AGGREGATE_PIXELS,
                }),
            ));
        }
        self.reserved_pixels += pixels;
        Ok(pixels)
    }
}

struct Decoded {
    width: u64,
    height: u64,
    rgba: Vec<u8>,
}

fn pixel_blocked(label: &str) -> StoreError {
    StoreError::with_details(
        "RENDER_PIXELS_BLOCKED",
        format!("{label} exceeds the fixed per-artifact pixel ceiling"),
        json!({ "label": label, "maximumPixels": RENDER_MAX_PIXELS }),
    )
}

fn dimensions_of(png: &[u8], label: &str) -> StoreResult<(u64, u64)> {
    let decoder = png::Decoder::new(Cursor::new(png));
    let reader = decoder.read_info().map_err(|_| StoreError::new("IMAGE_DECODE_FAILED", format!("{label} is not a decodable PNG")))?;
    let info = reader.info();
    let (width, height) = (u64::from(info.width), u64::from(info.height));
    if width.saturating_mul(height) > RENDER_MAX_PIXELS {
        return Err(pixel_blocked(label));
    }
    Ok((width, height))
}

fn decode(png_bytes: &[u8], label: &str) -> StoreResult<Decoded> {
    let failed = |_| StoreError::new("IMAGE_DECODE_FAILED", format!("{label} is not a decodable PNG"));
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(failed)?;
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or_else(|| pixel_blocked(label))?];
    let frame = reader.next_frame(&mut buffer).map_err(failed)?;
    let data = &buffer[..frame.buffer_size()];
    let rgba = match frame.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Indexed => return Err(StoreError::new("IMAGE_DECODE_FAILED", format!("{label} is not a decodable PNG"))),
    };
    Ok(Decoded { width: u64::from(frame.width), height: u64::from(frame.height), rgba })
}

/// The decoded plane padded with transparent black to `width` x `height`.
fn normalize(image: &Decoded, width: u64, height: u64) -> Vec<u8> {
    if image.width == width && image.height == height {
        return image.rgba.clone();
    }
    let mut plane = vec![0u8; (width * height * 4) as usize];
    let row = (image.width * 4) as usize;
    for y in 0..image.height as usize {
        let target = y * (width as usize) * 4;
        plane[target..target + row].copy_from_slice(&image.rgba[y * row..(y + 1) * row]);
    }
    plane
}

fn encode(width: u64, height: u64, rgba: &[u8]) -> StoreResult<Vec<u8>> {
    let failed = |_| StoreError::new("IMAGE_ENCODE_FAILED", "The comparison PNG could not be encoded");
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    encoder.set_filter(png::Filter::NoFilter);
    let mut writer = encoder.write_header().map_err(failed)?;
    writer.write_image_data(rgba).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(out)
}

/// A deterministic transparent PNG for a newly created renderable target.
pub fn create_transparent_png(width: u64, height: u64, label: &str, budget: &mut RenderBudget) -> StoreResult<Vec<u8>> {
    assert_render_dimensions(width, height, label)?;
    budget.reserve(width, height, label)?;
    encode(width, height, &vec![0u8; (width * height * 4) as usize])
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PngComparison {
    pub width: u64,
    pub height: u64,
    pub changed_pixels: u64,
    pub changed_ratio: f64,
    pub json: String,
    #[serde(skip)]
    pub png: Vec<u8>,
}

/// Deterministic exact-channel PNG comparison shared by every workbench.
pub fn compare_png_images(left_png: &[u8], right_png: &[u8], threshold: f64, budget: &mut RenderBudget) -> StoreResult<PngComparison> {
    let (left_width, left_height) = dimensions_of(left_png, "left comparison PNG")?;
    let (right_width, right_height) = dimensions_of(right_png, "right comparison PNG")?;
    assert_render_dimensions(left_width, left_height, "left comparison PNG")?;
    assert_render_dimensions(right_width, right_height, "right comparison PNG")?;
    let (width, height) = (left_width.max(right_width), left_height.max(right_height));
    budget.reserve(width, height, "left comparison normalized plane")?;
    budget.reserve(width, height, "right comparison normalized plane")?;
    budget.reserve(width, height, "comparison diff plane")?;
    let left = normalize(&decode(left_png, "left comparison PNG")?, width, height);
    let right = normalize(&decode(right_png, "right comparison PNG")?, width, height);
    let mut output = vec![0u8; left.len()];
    let mut changed = 0u64;
    for ((l, r), out) in left.chunks_exact(4).zip(right.chunks_exact(4)).zip(output.chunks_exact_mut(4)) {
        let delta = (0..4).map(|c| l[c].abs_diff(r[c])).max().unwrap_or(0);
        if f64::from(delta) > threshold {
            changed += 1;
            out.copy_from_slice(&[255, 58, 94, 255]);
        } else {
            // JavaScript Math.round of a positive average: halves round up.
            let luminance = ((f64::from(l[0]) + f64::from(l[1]) + f64::from(l[2])) / 3.0 + 0.5).floor() as u8;
            out.copy_from_slice(&[luminance, luminance, luminance, 96]);
        }
    }
    assert_render_dimensions(width, height, "comparison diff raster")?;
    let png = encode(width, height, &output)?;
    let ratio = changed as f64 / (width * height) as f64;
    let json = format!(
        "{}\n",
        canonical_json(&json!({ "offline": true, "width": width, "height": height, "changedPixels": changed, "changedRatio": ratio, "threshold": threshold }))
    );
    Ok(PngComparison { width, height, changed_pixels: changed, changed_ratio: ratio, json, png })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        encode(u64::from(width), u64::from(height), &color.repeat((width * height) as usize)).unwrap()
    }

    #[test]
    fn counts_changed_pixels_over_the_threshold() {
        let left = solid(2, 2, [10, 10, 10, 255]);
        let right = solid(2, 2, [30, 10, 10, 255]);
        let same = compare_png_images(&left, &left, 8.0, &mut RenderBudget::default()).unwrap();
        assert_eq!((same.changed_pixels, same.changed_ratio), (0, 0.0));
        let different = compare_png_images(&left, &right, 8.0, &mut RenderBudget::default()).unwrap();
        assert_eq!((different.changed_pixels, different.changed_ratio), (4, 1.0));
        assert_eq!(different.json, "{\"changedPixels\":4,\"changedRatio\":1,\"height\":2,\"offline\":true,\"threshold\":8,\"width\":2}\n");
        let within = compare_png_images(&left, &right, 20.0, &mut RenderBudget::default()).unwrap();
        assert_eq!(within.changed_pixels, 0);
        let decoded = decode(&different.png, "x").unwrap();
        assert_eq!(&decoded.rgba[..4], &[255, 58, 94, 255]);
        let quiet = decode(&within.png, "x").unwrap();
        assert_eq!(&quiet.rgba[..4], &[10, 10, 10, 96]);
    }

    #[test]
    fn pads_the_smaller_image_with_transparent_black() {
        let small = solid(1, 1, [200, 0, 0, 255]);
        let large = solid(2, 1, [200, 0, 0, 255]);
        let result = compare_png_images(&small, &large, 8.0, &mut RenderBudget::default()).unwrap();
        assert_eq!((result.width, result.height, result.changed_pixels), (2, 1, 1));
    }

    #[test]
    fn refuses_oversized_budgets_and_garbage() {
        let image = solid(2, 2, [0, 0, 0, 255]);
        let mut budget = RenderBudget { reserved_pixels: RENDER_MAX_AGGREGATE_PIXELS - 5 };
        assert_eq!(compare_png_images(&image, &image, 8.0, &mut budget).unwrap_err().code, "RENDER_AGGREGATE_BLOCKED");
        assert_eq!(create_transparent_png(16_385, 1, "x", &mut RenderBudget::default()).unwrap_err().code, "RENDER_DIMENSIONS_BLOCKED");
        assert_eq!(create_transparent_png(10_000, 10_000, "x", &mut RenderBudget::default()).unwrap_err().code, "RENDER_PIXELS_BLOCKED");
        assert_eq!(compare_png_images(b"not a png", &image, 8.0, &mut RenderBudget::default()).unwrap_err().code, "IMAGE_DECODE_FAILED");
    }

    #[test]
    fn transparent_png_is_deterministic_and_fully_transparent() {
        let first = create_transparent_png(3, 2, "baseline", &mut RenderBudget::default()).unwrap();
        assert_eq!(first, create_transparent_png(3, 2, "baseline", &mut RenderBudget::default()).unwrap());
        assert!(decode(&first, "x").unwrap().rgba.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn expands_grayscale_before_comparing() {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, 1, 1);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&[77]).unwrap();
        let color = solid(1, 1, [77, 77, 77, 255]);
        assert_eq!(compare_png_images(&out, &color, 8.0, &mut RenderBudget::default()).unwrap().changed_pixels, 0);
    }
}
