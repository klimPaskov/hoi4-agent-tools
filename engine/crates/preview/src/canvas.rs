//! An RGBA canvas and the drawing operations the game's interface uses: alpha blending,
//! sprite frames, cornered tiles (nine slices) and tiling.

use hoi4_texture::Image;

/// A rectangle in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Rect { x, y, width, height }
    }
}

/// Straight (not premultiplied) RGBA pixels, drawn with source-over blending.
pub struct Canvas {
    pub image: Image,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Canvas { image: Image::new(width, height) }
    }

    pub fn width(&self) -> i32 {
        self.image.width as i32
    }

    pub fn height(&self) -> i32 {
        self.image.height as i32
    }

    pub fn fill(&mut self, rgba: [u8; 4]) {
        for pixel in self.image.rgba.chunks_exact_mut(4) {
            pixel.copy_from_slice(&rgba);
        }
    }

    /// Source-over blend of one pixel; `alpha` scales the source alpha (0..=255).
    #[inline]
    pub fn blend(&mut self, x: i32, y: i32, source: [u8; 4], alpha: u32) {
        if x < 0 || y < 0 || x >= self.width() || y >= self.height() {
            return;
        }
        let sa = u32::from(source[3]) * alpha / 255;
        if sa == 0 {
            return;
        }
        let index = (y as usize * self.image.width as usize + x as usize) * 4;
        let dst = &mut self.image.rgba[index..index + 4];
        if sa == 255 {
            dst.copy_from_slice(&[source[0], source[1], source[2], 255]);
            return;
        }
        let da = u32::from(dst[3]);
        let out_a = sa + da * (255 - sa) / 255;
        if out_a == 0 {
            return;
        }
        for channel in 0..3 {
            let s = u32::from(source[channel]) * sa;
            let d = u32::from(dst[channel]) * da * (255 - sa) / 255;
            dst[channel] = ((s + d + out_a / 2) / out_a).min(255) as u8;
        }
        dst[3] = out_a.min(255) as u8;
    }

    /// Draws `region` of `source` at (`dx`, `dy`), unscaled.
    pub fn blit(&mut self, source: &Image, region: Rect, dx: i32, dy: i32, alpha: u32) {
        let Rect { x: sx, y: sy, width, height } = region;
        let (sw, sh) = (source.width as i32, source.height as i32);
        // Clip the column range once: inside the source and inside the canvas.
        let x0 = 0.max(-sx).max(-dx);
        let x1 = width.min(sw - sx).min(self.width() - dx);
        if x0 >= x1 {
            return;
        }
        let canvas_width = self.image.width as usize;
        for y in 0..height {
            let (py, ty) = (sy + y, dy + y);
            if py < 0 || py >= sh || ty < 0 || ty >= self.height() {
                continue;
            }
            let from = (py as usize * source.width as usize + (sx + x0) as usize) * 4;
            let to = (ty as usize * canvas_width + (dx + x0) as usize) * 4;
            let count = (x1 - x0) as usize * 4;
            let row = &source.rgba[from..from + count];
            if alpha == 255 && row.chunks_exact(4).all(|p| p[3] == 255) {
                self.image.rgba[to..to + count].copy_from_slice(row);
                continue;
            }
            for (offset, pixel) in row.chunks_exact(4).enumerate() {
                match pixel[3] {
                    0 => {}
                    255 if alpha == 255 => self.image.rgba[to + offset * 4..to + offset * 4 + 4].copy_from_slice(pixel),
                    _ => self.blend(dx + x0 + offset as i32, ty, [pixel[0], pixel[1], pixel[2], pixel[3]], alpha),
                }
            }
        }
    }

    /// Repeats `region` of `source` across `target`.
    pub fn tile(&mut self, source: &Image, region: Rect, target: Rect, alpha: u32) {
        if region.width <= 0 || region.height <= 0 {
            return;
        }
        let mut y = 0;
        while y < target.height {
            let h = region.height.min(target.height - y);
            let mut x = 0;
            while x < target.width {
                let w = region.width.min(target.width - x);
                self.blit(source, Rect::new(region.x, region.y, w, h), target.x + x, target.y + y, alpha);
                x += region.width;
            }
            y += region.height;
        }
    }

    /// A cornered tile sprite (`corneredTileSpriteType`): the four corners at their size, the
    /// edges and the centre tiled (`tiling_center`) or the centre left out.
    pub fn cornered_tile(&mut self, source: &Image, border: (i32, i32), tiling_center: bool, target: Rect, alpha: u32) {
        let (sw, sh) = (source.width as i32, source.height as i32);
        // A border larger than half the target shrinks so the corners never overlap.
        let bx = border.0.min(sw / 2).min(target.width / 2).max(0);
        let by = border.1.min(sh / 2).min(target.height / 2).max(0);
        let inner_source = Rect::new(bx, by, sw - 2 * bx, sh - 2 * by);
        let inner_target_w = target.width - 2 * bx;
        let inner_target_h = target.height - 2 * by;
        let (x0, y0) = (target.x, target.y);
        let (x1, y1) = (target.x + target.width - bx, target.y + target.height - by);
        // Corners.
        self.blit(source, Rect::new(0, 0, bx, by), x0, y0, alpha);
        self.blit(source, Rect::new(sw - bx, 0, bx, by), x1, y0, alpha);
        self.blit(source, Rect::new(0, sh - by, bx, by), x0, y1, alpha);
        self.blit(source, Rect::new(sw - bx, sh - by, bx, by), x1, y1, alpha);
        // Edges.
        self.tile(source, Rect::new(bx, 0, inner_source.width, by), Rect::new(x0 + bx, y0, inner_target_w, by), alpha);
        self.tile(source, Rect::new(bx, sh - by, inner_source.width, by), Rect::new(x0 + bx, y1, inner_target_w, by), alpha);
        self.tile(source, Rect::new(0, by, bx, inner_source.height), Rect::new(x0, y0 + by, bx, inner_target_h), alpha);
        self.tile(source, Rect::new(sw - bx, by, bx, inner_source.height), Rect::new(x1, y0 + by, bx, inner_target_h), alpha);
        if tiling_center {
            self.tile(source, inner_source, Rect::new(x0 + bx, y0 + by, inner_target_w, inner_target_h), alpha);
        }
    }
}

/// The alpha-weighted average of `rgba` (`width` pixels per row) over `xs` by `ys`: the area
/// filter that scales a render down.
pub fn average(rgba: &[u8], width: usize, xs: std::ops::Range<usize>, ys: std::ops::Range<usize>) -> [u8; 4] {
    let mut colour = [0u64; 3];
    let (mut alpha, mut count) = (0u64, 0u64);
    for y in ys {
        for pixel in rgba[(y * width + xs.start) * 4..(y * width + xs.end) * 4].chunks_exact(4) {
            let a = u64::from(pixel[3]);
            for (sum, &value) in colour.iter_mut().zip(pixel) {
                *sum += u64::from(value) * a;
            }
            alpha += a;
            count += 1;
        }
    }
    let mean = |sum: u64| sum.checked_add(alpha / 2).and_then(|s| s.checked_div(alpha)).unwrap_or(0) as u8;
    [mean(colour[0]), mean(colour[1]), mean(colour[2]), (alpha + count / 2).checked_div(count).unwrap_or(0) as u8]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blending_over_opaque_and_transparent() {
        let mut canvas = Canvas::new(2, 1);
        canvas.fill([0, 0, 0, 255]);
        let source = Image { width: 2, height: 1, rgba: vec![255, 255, 255, 128, 10, 20, 30, 255] };
        canvas.blit(&source, Rect::new(0, 0, 2, 1), 0, 0, 255);
        assert_eq!(&canvas.image.rgba[0..4], &[128, 128, 128, 255]);
        assert_eq!(&canvas.image.rgba[4..8], &[10, 20, 30, 255]);
        let mut clear = Canvas::new(1, 1);
        clear.blit(&source, Rect::new(0, 0, 1, 1), 0, 0, 255);
        assert_eq!(&clear.image.rgba[0..4], &[255, 255, 255, 128]);
    }

    #[test]
    fn averaging_weighs_by_alpha() {
        let rgba = [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0];
        assert_eq!(average(&rgba, 2, 0..2, 0..2), [255, 0, 0, 128]);
    }
}
