//! Parsing of the map source files (packet P13a).
//!
//! - [`script`]: Clausewitz script and localisation through the engine's TypeScript-compatible
//!   reader, with TypeScript locations.
//! - [`text`]: the line-based tables and the number readers.
//! - [`bmp`]: the map bitmaps.
//! - [`records`]: the map's records.

pub mod bmp;
pub mod records;
pub mod script;
pub mod text;
