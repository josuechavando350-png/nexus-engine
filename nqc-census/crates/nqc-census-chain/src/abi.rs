//! Minimal strict Solidity ABI helpers for static words and address arrays.
//!
//! Selectors and topics are derived from declared signatures with the core
//! Keccak-256; whether a declared signature is actually implemented by a
//! deployment is a separate, evidence-backed question answered by callers.

use crate::error::ChainError;
use nqc_census_core::keccak256;

pub fn selector(signature: &str) -> [u8; 4] {
    let digest = keccak256(signature.as_bytes());
    [digest[0], digest[1], digest[2], digest[3]]
}

pub fn event_topic(signature: &str) -> [u8; 32] {
    keccak256(signature.as_bytes())
}

pub fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(address);
    word
}

pub fn uint_word(value: u64) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

/// `selector || words`.
pub fn encode_call(selector: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + words.len() * 32);
    out.extend_from_slice(&selector);
    for word in words {
        out.extend_from_slice(word);
    }
    out
}

/// Splits return data into exact 32-byte words.
pub fn words(data: &[u8]) -> Result<Vec<[u8; 32]>, ChainError> {
    let (words, remainder) = data.as_chunks::<32>();
    if !remainder.is_empty() {
        return Err(ChainError::Abi("return data is not word aligned"));
    }
    Ok(words.to_vec())
}

/// Decodes an address word with canonical zero padding. The zero address is
/// returned as `None` so callers must handle it explicitly.
pub fn decode_address(word: &[u8; 32]) -> Result<Option<[u8; 20]>, ChainError> {
    if word[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Abi("non-canonical address padding"));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&word[12..]);
    Ok((address != [0; 20]).then_some(address))
}

pub fn decode_u64(word: &[u8; 32]) -> Result<u64, ChainError> {
    if word[..24].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Abi("integer exceeds u64"));
    }
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&word[24..]);
    Ok(u64::from_be_bytes(bytes))
}

pub fn decode_bool(word: &[u8; 32]) -> Result<bool, ChainError> {
    match decode_u64(word)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ChainError::Abi("non-canonical bool")),
    }
}

/// Return data that must be exactly one static word.
pub fn single_word(data: &[u8]) -> Result<[u8; 32], ChainError> {
    <[u8; 32]>::try_from(data).map_err(|_| ChainError::Abi("expected exactly one word"))
}

/// Strict canonical `address[]` return value: offset 32, length, exactly
/// `length` canonical address words, nothing after.
pub fn decode_address_array(data: &[u8]) -> Result<Vec<Option<[u8; 20]>>, ChainError> {
    let words = words(data)?;
    let offset = words
        .first()
        .ok_or(ChainError::Abi("empty dynamic array"))
        .and_then(decode_u64)?;
    if offset != 32 {
        return Err(ChainError::Abi("non-canonical array offset"));
    }
    let length = words
        .get(1)
        .ok_or(ChainError::Abi("missing array length"))
        .and_then(decode_u64)?;
    let length = usize::try_from(length).map_err(|_| ChainError::Abi("array too long"))?;
    if words.len()
        != length
            .checked_add(2)
            .ok_or(ChainError::Abi("array too long"))?
    {
        return Err(ChainError::Abi("array length does not match return data"));
    }
    words[2..].iter().map(decode_address).collect()
}
