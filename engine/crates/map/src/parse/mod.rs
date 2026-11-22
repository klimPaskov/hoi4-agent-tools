//! Parsing of the map source files (packet P13a).
//!
//! - [`source`]: Clausewitz script with the TypeScript parser's semantics and findings.
//! - [`text`]: the line-based tables and the number readers.
//! - [`localisation`]: localisation keys and findings.
//! - [`bmp`]: the map bitmaps.
//! - [`records`]: the map's records.

pub mod bmp;
pub mod localisation;
pub mod records;
pub mod source;
pub mod text;
