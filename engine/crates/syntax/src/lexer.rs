//! Byte lexer for Clausewitz script. Every byte of the input belongs to exactly one token, so the
//! token texts concatenated in order are the input.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    /// A UTF-8 byte order mark, at the start or (rarely) inside a concatenated file.
    Bom,
    Whitespace,
    /// `#` up to, not including, the end of the line.
    Comment,
    LBrace,
    RBrace,
    Operator,
    /// A double-quoted string including both quotes. An unterminated string runs to the end of
    /// the file and is reported by the parser.
    Quoted,
    /// Any other run of bytes: identifiers, numbers, dates, `@constants`, `var:x`, `[?x]`.
    Word,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub start: u32,
    pub end: u32,
}

impl Token {
    pub fn range(&self) -> std::ops::Range<usize> {
        self.start as usize..self.end as usize
    }

    pub fn is_trivia(&self) -> bool {
        matches!(self.kind, TokenKind::Whitespace | TokenKind::Comment | TokenKind::Bom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    EqEq,
    NotEq,
    Lt,
    Gt,
    Le,
    Ge,
    QuestionEq,
}

impl Operator {
    pub fn parse(text: &[u8]) -> Option<Self> {
        Some(match text {
            b"=" => Self::Eq,
            b"==" => Self::EqEq,
            b"!=" => Self::NotEq,
            b"<" => Self::Lt,
            b">" => Self::Gt,
            b"<=" => Self::Le,
            b">=" => Self::Ge,
            b"?=" => Self::QuestionEq,
            _ => return None,
        })
    }

    /// `=` and `?=` assign or test equality; the others compare.
    pub fn is_assignment(self) -> bool {
        matches!(self, Self::Eq | Self::QuestionEq)
    }
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B | 0x0C | 0x00)
}

fn ends_word(bytes: &[u8], i: usize) -> bool {
    let b = bytes[i];
    if is_space(b) || matches!(b, b'{' | b'}' | b'=' | b'<' | b'>' | b'"' | b'#') {
        return true;
    }
    // `!=` and `?=` are operators; a lone `!` or `?` belongs to the word (`[?var]`).
    matches!(b, b'!' | b'?') && bytes.get(i + 1) == Some(&b'=')
}

pub fn lex(bytes: &[u8]) -> Vec<Token> {
    let mut tokens = Vec::with_capacity(bytes.len() / 4 + 1);
    let mut i = 0usize;
    let len = bytes.len();
    while i < len {
        let start = i;
        let b = bytes[i];
        let kind = if bytes[i..].starts_with(crate::encoding::UTF8_BOM) {
            i += 3;
            TokenKind::Bom
        } else if is_space(b) {
            while i < len && is_space(bytes[i]) {
                i += 1;
            }
            TokenKind::Whitespace
        } else if b == b'#' {
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
            TokenKind::Comment
        } else if b == b'{' {
            i += 1;
            TokenKind::LBrace
        } else if b == b'}' {
            i += 1;
            TokenKind::RBrace
        } else if b == b'"' {
            i += 1;
            while i < len {
                match bytes[i] {
                    b'\\' => i = (i + 2).min(len),
                    b'"' => {
                        i += 1;
                        break;
                    }
                    _ => i += 1,
                }
            }
            TokenKind::Quoted
        } else if matches!(b, b'=' | b'<' | b'>') || (matches!(b, b'!' | b'?') && bytes.get(i + 1) == Some(&b'=')) {
            i += 1;
            if i < len && bytes[i] == b'=' {
                i += 1;
            }
            TokenKind::Operator
        } else {
            i += 1;
            while i < len && !ends_word(bytes, i) {
                i += 1;
            }
            TokenKind::Word
        };
        tokens.push(Token { kind, start: start as u32, end: i as u32 });
    }
    tokens
}

/// True when a quoted token has its closing quote.
pub fn quoted_is_terminated(bytes: &[u8], token: &Token) -> bool {
    let text = &bytes[token.range()];
    if text.len() < 2 || text[text.len() - 1] != b'"' {
        return false;
    }
    // The closing quote must not be escaped: count the backslashes before it.
    let backslashes = text[1..text.len() - 1].iter().rev().take_while(|&&b| b == b'\\').count();
    backslashes % 2 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<(TokenKind, &str)> {
        lex(src.as_bytes()).into_iter().map(|t| (t.kind, &src[t.range()])).collect()
    }

    #[test]
    fn covers_every_byte() {
        let src = "a=b # c\n{ \"x y\" >= 3 }\r\n!= ?= [?v] var:x@y";
        let tokens = lex(src.as_bytes());
        let mut pos = 0;
        for t in &tokens {
            assert_eq!(t.start as usize, pos);
            pos = t.end as usize;
        }
        assert_eq!(pos, src.len());
    }

    #[test]
    fn splits_operators_and_words() {
        assert_eq!(
            kinds("a!=b c<=1 [?x] d?=e"),
            vec![
                (TokenKind::Word, "a"),
                (TokenKind::Operator, "!="),
                (TokenKind::Word, "b"),
                (TokenKind::Whitespace, " "),
                (TokenKind::Word, "c"),
                (TokenKind::Operator, "<="),
                (TokenKind::Word, "1"),
                (TokenKind::Whitespace, " "),
                (TokenKind::Word, "[?x]"),
                (TokenKind::Whitespace, " "),
                (TokenKind::Word, "d"),
                (TokenKind::Operator, "?="),
                (TokenKind::Word, "e"),
            ]
        );
    }

    #[test]
    fn quoted_strings_keep_escapes_and_report_termination() {
        let src = br#"a = "say \"hi\"" b = "open"#;
        let tokens = lex(src);
        let quoted: Vec<_> = tokens.iter().filter(|t| t.kind == TokenKind::Quoted).collect();
        assert_eq!(&src[quoted[0].range()], br#""say \"hi\"""#);
        assert!(quoted_is_terminated(src, quoted[0]));
        assert!(!quoted_is_terminated(src, quoted[1]));
    }

    #[test]
    fn comments_stop_at_line_end() {
        assert_eq!(kinds("# x = {\r\ny"), vec![(TokenKind::Comment, "# x = {"), (TokenKind::Whitespace, "\r\n"), (TokenKind::Word, "y")]);
    }

    #[test]
    fn bom_is_its_own_token() {
        let src = b"\xEF\xBB\xBFa";
        let tokens = lex(src);
        assert_eq!(tokens[0].kind, TokenKind::Bom);
        assert_eq!(tokens[1].kind, TokenKind::Word);
    }
}
