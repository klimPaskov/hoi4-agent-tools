//! Texture decoding for the shared Hearts of Iron IV engine: the DDS, TGA and PNG files a sprite
//! points at, decoded to 8-bit RGBA, plus PNG encoding for renders.
//!
//! DDS covers the legacy header (RGB and luminance masks, DXT1 to DXT5, ATI1, ATI2, RXGB) and the
//! DX10 extension (uncompressed 8-bit and packed formats, BC1 to BC5 and BC7). Only the first
//! mip level of the first surface is decoded, which is what the game draws in the interface.
//! Sources: Microsoft's "Programming Guide for DDS", the Direct3D 11 functional specification
//! (BC1 to BC7) and the TGA 2.0 specification.

mod bc;
mod bc7;
pub mod dds;
pub mod pngio;
pub mod tga;

use std::fmt;
use std::path::Path;

/// Decoded pixels, 8-bit RGBA, rows top to bottom, not premultiplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    /// A transparent image.
    pub fn new(width: u32, height: u32) -> Self {
        Image { width, height, rgba: vec![0; width as usize * height as usize * 4] }
    }
}

/// A decoded texture and the format it was stored in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub image: Image,
    /// Readable format: `DXT5`, `BC7_UNORM`, `B8G8R8A8_UNORM_SRGB`, `RGBA32`, `TGA 32 bit`, `PNG`.
    pub format: String,
}

/// Why a texture could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// Not a texture this crate reads (wrong magic, unknown container).
    Invalid,
    /// A real format the decoder does not implement, such as BC6H or floating point.
    Unsupported,
    /// The header promises more pixel data than the file holds.
    Truncated,
    /// Larger than the caller's pixel limit.
    TooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError {
    pub kind: ErrorKind,
    /// The format as far as it was read (`BC6H_UF16`, `DX10/2`, `tga-type-32`).
    pub format: String,
    pub message: String,
}

impl DecodeError {
    pub(crate) fn new(kind: ErrorKind, format: impl Into<String>, message: impl Into<String>) -> Self {
        DecodeError { kind, format: format.into(), message: message.into() }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.format, self.message)
    }
}

impl std::error::Error for DecodeError {}

/// The largest texture decoded by default, the same ceiling as the TypeScript renderers.
pub const DEFAULT_MAX_PIXELS: u64 = 16_777_216;

pub(crate) fn check_size(width: u32, height: u32, max_pixels: u64, format: &str) -> Result<(), DecodeError> {
    if width == 0 || height == 0 {
        return Err(DecodeError::new(ErrorKind::Invalid, format, format!("invalid dimensions {width}x{height}")));
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(DecodeError::new(ErrorKind::TooLarge, format, format!("{width}x{height} is more than {max_pixels} pixels")));
    }
    Ok(())
}

/// Decodes texture bytes. The container is read from the first bytes when they say (a PNG named
/// `.dds` is still a PNG, as Kaiserreich ships 402 of them); otherwise `extension` (`dds`, `tga`,
/// `png`, any case) picks it. A file whose content does not match its extension says so in `format`.
pub fn decode(bytes: &[u8], extension: &str, max_pixels: u64) -> Result<Decoded, DecodeError> {
    let extension = extension.to_ascii_lowercase();
    let sniffed = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"DDS ") {
        Some("dds")
    } else {
        None
    };
    if let Some(actual) = sniffed
        && actual != extension
    {
        let mut decoded = decode(bytes, actual, max_pixels)?;
        decoded.format = format!("{} (in a .{extension} file)", decoded.format);
        return Ok(decoded);
    }
    match extension.as_str() {
        "dds" => dds::decode(bytes, max_pixels),
        "tga" => tga::decode(bytes, max_pixels),
        "png" => pngio::decode(bytes, max_pixels),
        other => Err(DecodeError::new(ErrorKind::Invalid, other, format!("unsupported texture extension .{other}"))),
    }
}

/// Reads and decodes the texture at `path`.
pub fn decode_file(path: &Path, max_pixels: u64) -> Result<Decoded, DecodeError> {
    let extension = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let bytes = std::fs::read(path).map_err(|e| DecodeError::new(ErrorKind::Invalid, extension.clone(), format!("cannot read: {e}")))?;
    decode(&bytes, &extension, max_pixels)
}
