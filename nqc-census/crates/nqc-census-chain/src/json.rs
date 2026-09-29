//! Strict RFC 8259 JSON with a canonical writer.
//!
//! The parser rejects duplicate object keys (a response with two `result`
//! members is ambiguous), unpaired surrogates, leading zeros, trailing content,
//! and nesting deeper than [`MAX_DEPTH`]. Numbers are kept as their validated
//! source text so no precision is ever lost. The writer emits objects with
//! bytewise-sorted keys and no insignificant whitespace, so equal values always
//! serialize to identical bytes.

use crate::error::ChainError;

pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(bytes: &[u8]) -> Result<Self, ChainError> {
        let mut parser = Parser { bytes, position: 0 };
        parser.whitespace();
        let value = parser.value(0)?;
        parser.whitespace();
        if parser.position != bytes.len() {
            return Err(ChainError::Json("trailing content"));
        }
        Ok(value)
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(members) => members
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(members) => Some(members),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// Integer value of a JSON number without fraction or exponent.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(text) if !text.contains(['.', 'e', 'E']) => text.parse().ok(),
            _ => None,
        }
    }

    pub fn str_field(&self, key: &str) -> Result<&str, ChainError> {
        self.get(key)
            .and_then(Self::as_str)
            .ok_or(ChainError::Json("missing string field"))
    }

    pub fn string(value: impl Into<String>) -> Self {
        Self::String(value.into())
    }

    pub fn uint(value: u64) -> Self {
        Self::Number(value.to_string())
    }

    pub fn int(value: i64) -> Self {
        Self::Number(value.to_string())
    }

    /// Builds an object; keys are sorted by the canonical writer.
    pub fn object<K: Into<String>>(members: impl IntoIterator<Item = (K, Self)>) -> Self {
        Self::Object(
            members
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        )
    }

    pub fn array(items: impl IntoIterator<Item = Self>) -> Self {
        Self::Array(items.into_iter().collect())
    }

    /// Canonical bytes: sorted keys, no whitespace, minimal escapes.
    /// Duplicate keys in a constructed object are a programming error and are
    /// rejected here as well.
    pub fn canonical(&self) -> Result<Vec<u8>, ChainError> {
        let mut out = Vec::new();
        write_value(self, &mut out)?;
        Ok(out)
    }

    /// Semantic equality: equal canonical bytes (object member order ignored).
    pub fn same_as(&self, other: &Self) -> Result<bool, ChainError> {
        Ok(self.canonical()? == other.canonical()?)
    }

    pub fn canonical_string(&self) -> Result<String, ChainError> {
        String::from_utf8(self.canonical()?).map_err(|_| ChainError::Json("non-utf8 output"))
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn next(&mut self) -> Result<u8, ChainError> {
        let byte = self.peek().ok_or(ChainError::Json("unexpected end"))?;
        self.position += 1;
        Ok(byte)
    }

    fn expect(&mut self, byte: u8) -> Result<(), ChainError> {
        if self.next()? == byte {
            Ok(())
        } else {
            Err(ChainError::Json("unexpected character"))
        }
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn literal(&mut self, text: &[u8], value: Json) -> Result<Json, ChainError> {
        if self.bytes.get(self.position..self.position + text.len()) == Some(text) {
            self.position += text.len();
            Ok(value)
        } else {
            Err(ChainError::Json("invalid literal"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ChainError> {
        if depth > MAX_DEPTH {
            return Err(ChainError::Json("nesting too deep"));
        }
        match self.peek().ok_or(ChainError::Json("unexpected end"))? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => Ok(Json::String(self.string()?)),
            b't' => self.literal(b"true", Json::Bool(true)),
            b'f' => self.literal(b"false", Json::Bool(false)),
            b'n' => self.literal(b"null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(ChainError::Json("unexpected character")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ChainError> {
        self.expect(b'{')?;
        let mut members: Vec<(String, Json)> = Vec::new();
        self.whitespace();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(Json::Object(members));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return Err(ChainError::Json("object key must be a string"));
            }
            let key = self.string()?;
            if members.iter().any(|(existing, _)| *existing == key) {
                return Err(ChainError::Json("duplicate object key"));
            }
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();
            let value = self.value(depth + 1)?;
            members.push((key, value));
            self.whitespace();
            match self.next()? {
                b',' => continue,
                b'}' => return Ok(Json::Object(members)),
                _ => return Err(ChainError::Json("expected , or }")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ChainError> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.whitespace();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.whitespace();
            items.push(self.value(depth + 1)?);
            self.whitespace();
            match self.next()? {
                b',' => continue,
                b']' => return Ok(Json::Array(items)),
                _ => return Err(ChainError::Json("expected , or ]")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ChainError> {
        let mut value = 0_u32;
        for _ in 0..4 {
            let digit = char::from(self.next()?)
                .to_digit(16)
                .ok_or(ChainError::Json("invalid unicode escape"))?;
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ChainError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.position;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.position += 1;
            }
            let chunk = std::str::from_utf8(&self.bytes[start..self.position])
                .map_err(|_| ChainError::Json("invalid utf-8"))?;
            out.push_str(chunk);
            match self.next()? {
                b'"' => return Ok(out),
                b'\\' => match self.next()? {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{08}'),
                    b'f' => out.push('\u{0c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let high = self.hex4()?;
                        let code = if (0xd800..0xdc00).contains(&high) {
                            self.expect(b'\\')?;
                            self.expect(b'u')?;
                            let low = self.hex4()?;
                            if !(0xdc00..0xe000).contains(&low) {
                                return Err(ChainError::Json("unpaired surrogate"));
                            }
                            0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00)
                        } else if (0xdc00..0xe000).contains(&high) {
                            return Err(ChainError::Json("unpaired surrogate"));
                        } else {
                            high
                        };
                        out.push(
                            char::from_u32(code).ok_or(ChainError::Json("invalid code point"))?,
                        );
                    }
                    _ => return Err(ChainError::Json("invalid escape")),
                },
                _ => return Err(ChainError::Json("control character in string")),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.position;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }
        self.position - start
    }

    fn number(&mut self) -> Result<Json, ChainError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.position += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(ChainError::Json("leading zero"));
                }
            }
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(ChainError::Json("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            if self.digits() == 0 {
                return Err(ChainError::Json("invalid fraction"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if self.digits() == 0 {
                return Err(ChainError::Json("invalid exponent"));
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| ChainError::Json("invalid number"))?;
        Ok(Json::Number(text.to_owned()))
    }
}

fn write_string(text: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for character in text.chars() {
        match character {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            control if (control as u32) < 0x20 => {
                out.extend_from_slice(format!("\\u{:04x}", control as u32).as_bytes());
            }
            other => {
                let mut buffer = [0_u8; 4];
                out.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn write_value(value: &Json, out: &mut Vec<u8>) -> Result<(), ChainError> {
    match value {
        Json::Null => out.extend_from_slice(b"null"),
        Json::Bool(true) => out.extend_from_slice(b"true"),
        Json::Bool(false) => out.extend_from_slice(b"false"),
        Json::Number(text) => {
            // Re-validate so a constructed number can never inject syntax.
            let parsed = Json::parse(text.as_bytes())?;
            if !matches!(parsed, Json::Number(_)) {
                return Err(ChainError::Json("invalid number text"));
            }
            out.extend_from_slice(text.as_bytes());
        }
        Json::String(text) => write_string(text, out),
        Json::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_value(item, out)?;
            }
            out.push(b']');
        }
        Json::Object(members) => {
            let mut sorted: Vec<&(String, Json)> = members.iter().collect();
            sorted.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            if sorted.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                return Err(ChainError::Json("duplicate object key"));
            }
            out.push(b'{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string(key, out);
                out.push(b':');
                write_value(item, out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}
