//! Strict `0x` hexadecimal codecs for JSON-RPC values.
//!
//! DATA values must have an even number of digits. QUANTITY values must be
//! minimal (`0x0` for zero, otherwise no leading zero digit). Mixed case is
//! accepted on input because EIP-55 addresses are mixed case; output is always
//! lowercase.

use crate::error::ChainError;

fn digits(text: &str) -> Result<&str, ChainError> {
    text.strip_prefix("0x")
        .ok_or(ChainError::Hex("missing 0x prefix"))
}

fn nibble(byte: u8) -> Result<u8, ChainError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(ChainError::Hex("non-hex digit")),
    }
}

/// Decodes a DATA value of any length.
pub fn decode_data(text: &str) -> Result<Vec<u8>, ChainError> {
    let body = digits(text)?.as_bytes();
    if body.len() % 2 != 0 {
        return Err(ChainError::Hex("odd-length data"));
    }
    body.chunks(2)
        .map(|pair| Ok((nibble(pair[0])? << 4) | nibble(pair[1])?))
        .collect()
}

/// Decodes a DATA value that must be exactly `N` bytes.
pub fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N], ChainError> {
    let bytes = decode_data(text)?;
    <[u8; N]>::try_from(bytes.as_slice()).map_err(|_| ChainError::Hex("unexpected data width"))
}

/// Decodes a minimal QUANTITY into big-endian bytes without leading zeros.
pub fn decode_quantity_bytes(text: &str) -> Result<Vec<u8>, ChainError> {
    let body = digits(text)?;
    if body.is_empty() {
        return Err(ChainError::Hex("empty quantity"));
    }
    if body.len() > 1 && body.starts_with('0') {
        return Err(ChainError::Hex("non-minimal quantity"));
    }
    if body == "0" {
        return Ok(Vec::new());
    }
    let padded = if body.len() % 2 == 1 {
        format!("0x0{body}")
    } else {
        format!("0x{body}")
    };
    decode_data(&padded)
}

pub fn decode_quantity_u64(text: &str) -> Result<u64, ChainError> {
    let bytes = decode_quantity_bytes(text)?;
    if bytes.len() > 8 {
        return Err(ChainError::Hex("quantity exceeds u64"));
    }
    Ok(bytes
        .iter()
        .fold(0_u64, |value, byte| (value << 8) | u64::from(*byte)))
}

pub fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Plain lowercase hex without prefix.
pub fn plain(bytes: &[u8]) -> String {
    encode(bytes).split_off(2)
}

pub fn quantity(value: u64) -> String {
    format!("{value:#x}")
}
