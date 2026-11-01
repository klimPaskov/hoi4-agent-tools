//! Lossless parsers for Hearts of Iron IV sources.
//!
//! * [`Document`] parses Clausewitz script (`.txt`, `.gui`, `.gfx`, `.asset`, `descriptor.mod`).
//! * [`LocFile`] parses localisation (`.yml`).
//!
//! Both keep every byte. Spans are byte offsets into the original file, and positions are 1-based
//! lines and 1-based byte columns.

pub mod ast;
pub mod encoding;
pub mod lexer;
pub mod localisation;

pub use ast::{Block, Document, Entry, Item, SyntaxDiagnostic, Value, line_starts, position_in};
pub use encoding::Encoding;
pub use lexer::{Operator, Token, TokenKind};
pub use localisation::{LocEntry, LocFile};

/// Which grammar a file under the game or a mod root uses, from its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grammar {
    Script,
    Localisation,
}

pub fn grammar_for(relative_path: &str) -> Option<Grammar> {
    let lower = relative_path.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e)?;
    match ext {
        "yml" if lower.starts_with("localisation/") || lower.starts_with("localization/") => Some(Grammar::Localisation),
        "txt" | "gui" | "gfx" | "asset" | "mod" => Some(Grammar::Script),
        _ => None,
    }
}
