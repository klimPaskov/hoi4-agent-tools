//! Bitmap fonts: the BMFont text files (`.fnt`) the game's `bitmapfont` entries name, with
//! their glyph pages, and text drawn the way the interface draws it, including `§X` colour codes.

use std::collections::HashMap;
use std::sync::Arc;

use hoi4_texture::Image;

use crate::canvas::{Canvas, Rect};

#[derive(Clone, Copy, Debug)]
pub struct Glyph {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub x_offset: i32,
    pub y_offset: i32,
    pub advance: i32,
    pub page: usize,
}

/// One `.fnt` file: its glyphs, kerning pairs and page names (texture files beside it).
#[derive(Clone, Debug, Default)]
pub struct FontFile {
    pub line_height: i32,
    pub base: i32,
    pub glyphs: HashMap<u32, Glyph>,
    pub kerning: HashMap<(u32, u32), i32>,
    pub pages: Vec<String>,
}

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    // Fields are `name=value` or `name="quoted value"`, separated by spaces.
    let mut rest = line;
    while let Some(at) = rest.find(name) {
        let before = rest[..at].chars().last();
        let after = &rest[at + name.len()..];
        if (before.is_none() || before == Some(' ') || before == Some('\t')) && after.starts_with('=') {
            let value = &after[1..];
            if let Some(quoted) = value.strip_prefix('"') {
                return quoted.split('"').next();
            }
            return value.split_whitespace().next();
        }
        rest = &rest[at + name.len()..];
    }
    None
}

fn number(line: &str, name: &str) -> i32 {
    field(line, name).and_then(|v| v.parse().ok()).unwrap_or(0)
}

impl FontFile {
    /// Parses the BMFont text format. Unknown lines are ignored.
    pub fn parse(text: &str) -> FontFile {
        let mut font = FontFile::default();
        for line in text.lines() {
            let line = line.trim();
            let kind = line.split_whitespace().next().unwrap_or("");
            match kind {
                "common" => {
                    font.line_height = number(line, "lineHeight");
                    font.base = number(line, "base");
                }
                "page" => {
                    let id = number(line, "id").max(0) as usize;
                    if font.pages.len() <= id {
                        font.pages.resize(id + 1, String::new());
                    }
                    font.pages[id] = field(line, "file").unwrap_or("").to_string();
                }
                "char" => {
                    let id = number(line, "id");
                    if id < 0 {
                        continue;
                    }
                    font.glyphs.insert(
                        id as u32,
                        Glyph {
                            x: number(line, "x"),
                            y: number(line, "y"),
                            width: number(line, "width"),
                            height: number(line, "height"),
                            x_offset: number(line, "xoffset"),
                            y_offset: number(line, "yoffset"),
                            advance: number(line, "xadvance"),
                            page: number(line, "page").max(0) as usize,
                        },
                    );
                }
                "kerning" => {
                    let (first, second) = (number(line, "first"), number(line, "second"));
                    if first >= 0 && second >= 0 {
                        font.kerning.insert((first as u32, second as u32), number(line, "amount"));
                    }
                }
                _ => {}
            }
        }
        font
    }
}

/// A font as a `bitmapfont` entry defines it: several files searched in order, and colours.
pub struct Font {
    pub files: Vec<(FontFile, Vec<Option<Arc<Image>>>)>,
    pub colour: [u8; 4],
    pub text_colours: HashMap<char, [u8; 3]>,
}

/// Colour codes every font knows (interface/core.gfx `textcolors`), used when a font lists none.
pub fn default_text_colours() -> HashMap<char, [u8; 3]> {
    [
        ('G', [86, 172, 91]),
        ('R', [222, 86, 70]),
        ('Y', [238, 201, 35]),
        ('O', [238, 123, 35]),
        ('H', [238, 201, 35]),
        ('T', [255, 255, 255]),
        ('g', [175, 175, 175]),
        ('W', [255, 255, 255]),
        ('B', [0, 128, 255]),
        ('b', [0, 0, 0]),
        ('C', [35, 206, 255]),
        ('L', [195, 176, 145]),
    ]
    .into_iter()
    .collect()
}

/// A run of text in one colour.
struct Run {
    colour: [u8; 4],
    chars: Vec<char>,
}

impl Font {
    fn glyph(&self, c: char) -> Option<(&Glyph, &FontFile, Option<&Arc<Image>>)> {
        for (file, pages) in &self.files {
            if let Some(glyph) = file.glyphs.get(&(c as u32)) {
                return Some((glyph, file, pages.get(glyph.page).and_then(Option::as_ref)));
            }
        }
        None
    }

    pub fn line_height(&self) -> i32 {
        self.files.first().map_or(16, |(f, _)| f.line_height.max(1))
    }

    fn kerning(&self, a: char, b: char) -> i32 {
        self.files.first().and_then(|(f, _)| f.kerning.get(&(a as u32, b as u32)).copied()).unwrap_or(0)
    }

    /// Width of plain text in pixels.
    pub fn measure(&self, text: &str) -> i32 {
        let chars: Vec<char> = strip_codes(text).chars().collect();
        let mut width = 0;
        for (index, &c) in chars.iter().enumerate() {
            if let Some((glyph, _, _)) = self.glyph(c) {
                width += glyph.advance;
            }
            if let Some(&next) = chars.get(index + 1) {
                width += self.kerning(c, next);
            }
        }
        width
    }

    /// Splits text into lines no wider than `max_width`, breaking at spaces (and at `\n`).
    pub fn wrap(&self, text: &str, max_width: i32) -> Vec<String> {
        let mut lines = Vec::new();
        for paragraph in text.split('\n') {
            let mut line = String::new();
            for word in paragraph.split(' ') {
                let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                if !line.is_empty() && self.measure(&candidate) > max_width {
                    lines.push(std::mem::take(&mut line));
                    line = word.to_string();
                } else {
                    line = candidate;
                }
            }
            lines.push(line);
        }
        lines
    }

    fn runs(&self, text: &str) -> Vec<Run> {
        let mut runs = vec![Run { colour: self.colour, chars: Vec::new() }];
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '§' {
                let Some(code) = chars.next() else { break };
                let colour = if code == '!' {
                    self.colour
                } else {
                    match self.text_colours.get(&code) {
                        Some(rgb) => [rgb[0], rgb[1], rgb[2], 255],
                        None => self.colour,
                    }
                };
                runs.push(Run { colour, chars: Vec::new() });
            } else if let Some(run) = runs.last_mut() {
                run.chars.push(c);
            }
        }
        runs
    }

    /// Draws one line with its top-left at (`x`, `y`). Characters the font lacks are skipped
    /// and returned.
    pub fn draw_line(&self, canvas: &mut Canvas, text: &str, x: i32, y: i32) -> Vec<char> {
        let mut missing = Vec::new();
        let mut pen = x;
        let mut previous: Option<char> = None;
        for run in self.runs(text) {
            for &c in &run.chars {
                if let Some(p) = previous {
                    pen += self.kerning(p, c);
                }
                previous = Some(c);
                let Some((glyph, _, page)) = self.glyph(c) else {
                    if !c.is_whitespace() {
                        missing.push(c);
                    }
                    continue;
                };
                if let Some(page) = page {
                    draw_glyph(canvas, page, glyph, pen, y, run.colour);
                }
                pen += glyph.advance;
            }
        }
        missing
    }

    /// Draws text in a box the way an `instantTextBoxType` with `format = center` and
    /// `vertical_alignment = center` does: wrapped at the box width, every line centred.
    pub fn draw_centered(&self, canvas: &mut Canvas, text: &str, area: Rect) -> Vec<char> {
        let lines = self.wrap(text, area.width);
        let height = self.line_height() * lines.len() as i32;
        let mut y = area.y + (area.height - height) / 2;
        let mut missing = Vec::new();
        for line in lines {
            let width = self.measure(&line);
            missing.extend(self.draw_line(canvas, &line, area.x + (area.width - width) / 2, y));
            y += self.line_height();
        }
        missing
    }
}

/// Text without `§X` colour codes.
pub fn strip_codes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

fn draw_glyph(canvas: &mut Canvas, page: &Image, glyph: &Glyph, x: i32, y: i32, colour: [u8; 4]) {
    // The page's alpha is the glyph's coverage; its colour tints the text colour.
    for gy in 0..glyph.height {
        for gx in 0..glyph.width {
            let (sx, sy) = (glyph.x + gx, glyph.y + gy);
            if sx < 0 || sy < 0 || sx >= page.width as i32 || sy >= page.height as i32 {
                continue;
            }
            let index = (sy as usize * page.width as usize + sx as usize) * 4;
            let texel = &page.rgba[index..index + 4];
            if texel[3] == 0 {
                continue;
            }
            let tinted = [
                (u32::from(texel[0]) * u32::from(colour[0]) / 255) as u8,
                (u32::from(texel[1]) * u32::from(colour[1]) / 255) as u8,
                (u32::from(texel[2]) * u32::from(colour[2]) / 255) as u8,
                (u32::from(texel[3]) * u32::from(colour[3]) / 255) as u8,
            ];
            canvas.blend(x + glyph.x_offset + gx, y + glyph.y_offset + gy, tinted, 255);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FNT: &str = "info face=\"Test\" size=16\ncommon lineHeight=16 base=13 scaleW=8 scaleH=8 pages=1\npage id=0 file=\"test.dds\"\nchars count=2\nchar id=65 x=0 y=0 width=2 height=2 xoffset=0 yoffset=1 xadvance=3 page=0 chnl=15\nchar id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=4 page=0 chnl=15\nkerning first=65 second=65 amount=-1\n";

    #[test]
    fn parses_and_measures() {
        let file = FontFile::parse(FNT);
        assert_eq!(file.line_height, 16);
        assert_eq!(file.pages, ["test.dds"]);
        assert_eq!(file.glyphs[&65].advance, 3);
        let font = Font { files: vec![(file, vec![None])], colour: [255; 4], text_colours: default_text_colours() };
        assert_eq!(font.measure("AA"), 5);
        assert_eq!(font.measure("§YA A§!"), 10);
        assert_eq!(font.wrap("A A A", 10), ["A A", "A"]);
        assert_eq!(font.wrap("A A A", 7), ["A", "A", "A"]);
    }
}
