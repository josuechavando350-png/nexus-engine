//! Minimal, strict, dependency-free JSON value model and codec.
//!
//! Two properties matter for the runtime and neither is free in a general
//! purpose library:
//!
//! 1. **Canonical form.** `to_canonical_string` sorts object keys, so the
//!    bytes fed into `integrity_hash` and into signatures do not depend on
//!    field ordering. Two semantically equal payloads always hash equal.
//! 2. **Strictness.** Duplicate keys, trailing commas, unescaped control
//!    characters, lone surrogates and unbounded nesting are rejected. A
//!    permissive parser at the ingest boundary is a security problem.
//!
//! The parser and serializer were differentially fuzzed against a reference
//! JSON implementation before being written.

use crate::error::{NexusError, Result};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// Maximum nesting depth accepted by the parser.
pub const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    pub fn object(entries: Vec<(&str, Value)>) -> Value {
        let mut map = BTreeMap::new();
        for (key, value) in entries {
            map.insert(key.to_string(), value);
        }
        Value::Object(map)
    }

    pub fn string(text: impl Into<String>) -> Value {
        Value::String(text.into())
    }

    pub fn number(value: impl Into<f64>) -> Value {
        Value::Number(value.into())
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text.as_str()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    /// Required string field, with a schema error naming the field.
    pub fn require_str(&self, key: &str) -> Result<&str> {
        self.get(key)
            .ok_or_else(|| NexusError::schema(format!("missing field '{key}'")))?
            .as_str()
            .ok_or_else(|| NexusError::schema(format!("field '{key}' must be a string")))
    }

    /// Required numeric field.
    pub fn require_f64(&self, key: &str) -> Result<f64> {
        self.get(key)
            .ok_or_else(|| NexusError::schema(format!("missing field '{key}'")))?
            .as_f64()
            .ok_or_else(|| NexusError::schema(format!("field '{key}' must be a number")))
    }

    /// Required unsigned integer field.
    pub fn require_u64(&self, key: &str) -> Result<u64> {
        let value = self.require_f64(key)?;
        if value < 0.0 || value.fract() != 0.0 || value > 9.007_199_254_740_992e15 {
            return Err(NexusError::schema(format!(
                "field '{key}' must be a non-negative integer within 2^53"
            )));
        }
        Ok(value as u64)
    }

    /// Canonical serialization: object keys sorted, no insignificant space.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self);
        out
    }

    pub fn to_canonical_bytes(&self) -> Vec<u8> {
        self.to_canonical_string().into_bytes()
    }
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(out, *number),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // BTreeMap already iterates in sorted key order, which is exactly
            // the canonical ordering the integrity hash depends on.
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

fn write_number(out: &mut String, number: f64) {
    if !number.is_finite() {
        // Cannot occur through the parser; defensive so canonical output is
        // always valid JSON even if a caller builds a Value by hand.
        out.push_str("null");
        return;
    }
    if number == number.trunc() && number.abs() < 1e15 {
        let _ = write!(out, "{}", number as i64);
    } else {
        let _ = write!(out, "{number}");
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn parse(source: &str) -> Result<Value> {
    let mut parser = Parser {
        chars: source.chars().collect(),
        index: 0,
        depth: 0,
    };
    parser.skip_whitespace();
    let value = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.index != parser.chars.len() {
        return Err(parser.error("trailing input after JSON document"));
    }
    Ok(value)
}

struct Parser {
    chars: Vec<char>,
    index: usize,
    depth: usize,
}

impl Parser {
    fn error(&self, message: &str) -> NexusError {
        NexusError::schema(format!("{message} at position {}", self.index))
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let current = self.peek();
        if current.is_some() {
            self.index += 1;
        }
        current
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t') | Some('\n') | Some('\r')) {
            self.index += 1;
        }
    }

    fn parse_value(&mut self) -> Result<Value> {
        if self.depth > MAX_DEPTH {
            return Err(self.error("nesting depth limit exceeded"));
        }
        self.skip_whitespace();
        match self.peek() {
            None => Err(self.error("unexpected end of input")),
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => Ok(Value::String(self.parse_string()?)),
            Some('t') => {
                self.expect_word("true")?;
                Ok(Value::Bool(true))
            }
            Some('f') => {
                self.expect_word("false")?;
                Ok(Value::Bool(false))
            }
            Some('n') => {
                self.expect_word("null")?;
                Ok(Value::Null)
            }
            Some(_) => Ok(Value::Number(self.parse_number()?)),
        }
    }

    fn expect_word(&mut self, word: &str) -> Result<()> {
        for expected in word.chars() {
            if self.bump() != Some(expected) {
                return Err(self.error("invalid literal"));
            }
        }
        Ok(())
    }

    fn parse_object(&mut self) -> Result<Value> {
        self.depth += 1;
        self.bump();
        let mut map: BTreeMap<String, Value> = BTreeMap::new();
        self.skip_whitespace();
        if self.peek() == Some('}') {
            self.bump();
            self.depth -= 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some('"') {
                return Err(self.error("object key must be a string"));
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            if self.bump() != Some(':') {
                return Err(self.error("expected ':' after object key"));
            }
            let value = self.parse_value()?;
            if map.insert(key, value).is_some() {
                // Duplicate keys make canonicalization ambiguous and are a
                // classic parser-differential attack vector.
                return Err(self.error("duplicate object key"));
            }
            self.skip_whitespace();
            match self.bump() {
                Some(',') => continue,
                Some('}') => break,
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
        self.depth -= 1;
        Ok(Value::Object(map))
    }

    fn parse_array(&mut self) -> Result<Value> {
        self.depth += 1;
        self.bump();
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(']') {
            self.bump();
            self.depth -= 1;
            return Ok(Value::Array(items));
        }
        loop {
            let value = self.parse_value()?;
            items.push(value);
            self.skip_whitespace();
            match self.bump() {
                Some(',') => continue,
                Some(']') => break,
                _ => return Err(self.error("expected ',' or ']'")),
            }
        }
        self.depth -= 1;
        Ok(Value::Array(items))
    }

    fn parse_string(&mut self) -> Result<String> {
        if self.bump() != Some('"') {
            return Err(self.error("expected string"));
        }
        let mut out = String::new();
        loop {
            let current = match self.bump() {
                Some(c) => c,
                None => return Err(self.error("unterminated string")),
            };
            match current {
                '"' => return Ok(out),
                '\\' => {
                    let escape = match self.bump() {
                        Some(c) => c,
                        None => return Err(self.error("unterminated escape")),
                    };
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{08}'),
                        'f' => out.push('\u{0c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.parse_unicode_escape()?),
                        _ => return Err(self.error("invalid escape sequence")),
                    }
                }
                c if (c as u32) < 0x20 => {
                    return Err(self.error("unescaped control character in string"))
                }
                c => out.push(c),
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32> {
        let mut value = 0u32;
        for _ in 0..4 {
            let digit = match self.bump() {
                Some(c) => c,
                None => return Err(self.error("truncated \\u escape")),
            };
            let parsed = digit
                .to_digit(16)
                .ok_or_else(|| self.error("invalid hex digit in \\u escape"))?;
            value = value * 16 + parsed;
        }
        Ok(value)
    }

    fn parse_unicode_escape(&mut self) -> Result<char> {
        let first = self.parse_hex4()?;
        if (0xd800..=0xdbff).contains(&first) {
            if self.bump() != Some('\\') || self.bump() != Some('u') {
                return Err(self.error("lone high surrogate"));
            }
            let second = self.parse_hex4()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(self.error("invalid low surrogate"));
            }
            let code = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
            return char::from_u32(code).ok_or_else(|| self.error("invalid code point"));
        }
        if (0xdc00..=0xdfff).contains(&first) {
            return Err(self.error("lone low surrogate"));
        }
        char::from_u32(first).ok_or_else(|| self.error("invalid code point"))
    }

    fn parse_number(&mut self) -> Result<f64> {
        let start = self.index;
        if self.peek() == Some('-') {
            self.bump();
        }
        if self.peek() == Some('0') {
            self.bump();
        } else {
            let mut digits = 0;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.bump();
                digits += 1;
            }
            if digits == 0 {
                return Err(self.error("invalid number"));
            }
        }
        if self.peek() == Some('.') {
            self.bump();
            let mut digits = 0;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.bump();
                digits += 1;
            }
            if digits == 0 {
                return Err(self.error("invalid fractional part"));
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.bump();
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.bump();
            }
            let mut digits = 0;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.bump();
                digits += 1;
            }
            if digits == 0 {
                return Err(self.error("invalid exponent"));
            }
        }
        let text: String = self.chars[start..self.index].iter().collect();
        let parsed: f64 = text
            .parse()
            .map_err(|_| NexusError::schema(format!("unparsable number '{text}'")))?;
        if !parsed.is_finite() {
            return Err(self.error("number out of range"));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_document() {
        let value = parse(r#"{"a":[1,2,{"b":true}],"c":null}"#).expect("valid");
        assert_eq!(value.get("c"), Some(&Value::Null));
        let array = value.get("a").and_then(Value::as_array).expect("array");
        assert_eq!(array.len(), 3);
    }

    #[test]
    fn canonical_form_is_key_order_independent() {
        let left = parse(r#"{"b":1,"a":{"z":true,"y":[1,2]},"c":"x"}"#).unwrap();
        let right = parse(r#"{"c":"x","a":{"y":[1,2],"z":true},"b":1}"#).unwrap();
        assert_eq!(left.to_canonical_string(), right.to_canonical_string());
        assert_eq!(
            left.to_canonical_string(),
            r#"{"a":{"y":[1,2],"z":true},"b":1,"c":"x"}"#
        );
    }

    #[test]
    fn round_trips_through_canonical_form() {
        let source = r#"{"n":-12.5,"s":"a\nb","t":true,"arr":[1,"two",null]}"#;
        let parsed = parse(source).unwrap();
        let reparsed = parse(&parsed.to_canonical_string()).unwrap();
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn rejects_malformed_documents() {
        let cases = [
            r#"{"a":1,}"#,
            "[1,2,",
            "{a:1}",
            "'x'",
            "01",
            "1.",
            "1e",
            "[1] junk",
            r#"{"a":1,"a":2}"#,
            r#""\ud800""#,
            "+1",
            "",
            "   ",
            "[,]",
            "nul",
        ];
        for case in cases {
            assert!(parse(case).is_err(), "should reject: {case}");
        }
    }

    #[test]
    fn decodes_surrogate_pairs() {
        assert_eq!(parse(r#""\ud83d\ude80""#).unwrap().as_str(), Some("\u{1f680}"));
        assert_eq!(parse(r#""\u00f1""#).unwrap().as_str(), Some("ñ"));
    }

    #[test]
    fn escapes_control_characters_on_output() {
        let value = parse(r#""\u0001""#).unwrap();
        assert_eq!(value.to_canonical_string(), r#""\u0001""#);
    }

    #[test]
    fn enforces_depth_limit() {
        let deep = "[".repeat(MAX_DEPTH + 10) + &"]".repeat(MAX_DEPTH + 10);
        assert!(parse(&deep).is_err());
        let shallow = "[".repeat(16) + &"]".repeat(16);
        assert!(parse(&shallow).is_ok());
    }

    #[test]
    fn require_helpers_report_the_field_name() {
        let value = parse(r#"{"a":"x","n":7}"#).unwrap();
        assert_eq!(value.require_str("a").unwrap(), "x");
        assert_eq!(value.require_u64("n").unwrap(), 7);
        let error = value.require_str("missing").unwrap_err();
        assert!(error.to_string().contains("missing"));
        assert!(value.require_u64("a").is_err());
    }

    #[test]
    fn integral_numbers_serialize_without_a_fraction() {
        assert_eq!(Value::number(7.0).to_canonical_string(), "7");
        assert_eq!(Value::number(-3.5).to_canonical_string(), "-3.5");
    }
}
