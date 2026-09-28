//! NQC-LZ-V1: a small, byte-aligned, deterministic LZ77 codec (std only).
//!
//! Token stream, repeated until the input is exhausted:
//!
//! * `0b0LLL_LLLL` followed by `L + 1` literal bytes (1..=128);
//! * `0b1MMM_MMMM, d_hi, d_lo` copies `M + 4` bytes (4..=131) from
//!   `distance = d_hi << 8 | d_lo` bytes back (1..=65535). Overlap is allowed.
//!
//! The encoder is a greedy single-candidate matcher over a 2^14-entry table of
//! 4-byte multiplicative hashes. It is part of the frozen format: the same input
//! always produces the same bytes, and verification re-encodes to prove it.
//!
//! The decoder is total over hostile input: it never writes past the declared
//! raw length, rejects zero or out-of-window distances, truncated tokens,
//! trailing tokens and short output, and allocates at most `raw_len` bytes,
//! which callers bound by the persisted `chunk_max` before calling it.

use std::fmt::{Display, Formatter};

const MIN_MATCH: usize = 4;
const MAX_MATCH: usize = 131;
const MAX_LITERAL_RUN: usize = 128;
const MAX_DISTANCE: usize = 65_535;
const HASH_BITS: u32 = 14;
const EMPTY_SLOT: usize = usize::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecError {
    TruncatedLiteral,
    TruncatedMatch,
    ZeroDistance,
    DistanceBeyondOutput,
    OutputOverflow,
    OutputShort,
}

impl CodecError {
    pub const fn reason(self) -> &'static str {
        match self {
            Self::TruncatedLiteral => "truncated literal run",
            Self::TruncatedMatch => "truncated match token",
            Self::ZeroDistance => "zero match distance",
            Self::DistanceBeyondOutput => "match distance precedes output start",
            Self::OutputOverflow => "decoded output exceeds declared length",
            Self::OutputShort => "decoded output shorter than declared length",
        }
    }
}

impl Display for CodecError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for CodecError {}

pub fn compress(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() / 2 + 16);
    let mut table = vec![EMPTY_SLOT; 1 << HASH_BITS];
    let mut literal_start = 0;
    let mut position = 0;

    while let Some(key) = read4(input, position) {
        let slot = hash4(key);
        let candidate = table.get(slot).copied().unwrap_or(EMPTY_SLOT);
        if let Some(entry) = table.get_mut(slot) {
            *entry = position;
        }
        let matched = candidate != EMPTY_SLOT
            && position - candidate <= MAX_DISTANCE
            && read4(input, candidate) == Some(key);
        if !matched {
            position += 1;
            continue;
        }

        let mut length = MIN_MATCH;
        while length < MAX_MATCH {
            match (input.get(position + length), input.get(candidate + length)) {
                (Some(next), Some(previous)) if next == previous => length += 1,
                _ => break,
            }
        }

        push_literals(
            &mut out,
            input.get(literal_start..position).unwrap_or_default(),
        );
        // length - MIN_MATCH <= 127 and distance <= 65535 by construction.
        out.push(0x80 | ((length - MIN_MATCH) as u8));
        out.extend_from_slice(&((position - candidate) as u16).to_be_bytes());

        let match_end = position + length;
        for inner in position + 1..match_end {
            if let Some(inner_key) = read4(input, inner) {
                if let Some(entry) = table.get_mut(hash4(inner_key)) {
                    *entry = inner;
                }
            }
        }
        position = match_end;
        literal_start = match_end;
    }

    push_literals(&mut out, input.get(literal_start..).unwrap_or_default());
    out
}

pub fn decompress(input: &[u8], raw_len: usize) -> Result<Vec<u8>, CodecError> {
    let mut out = Vec::with_capacity(raw_len);
    let mut cursor = 0;
    while let Some(&control) = input.get(cursor) {
        cursor += 1;
        if control & 0x80 == 0 {
            let run = usize::from(control) + 1;
            let literals = input
                .get(cursor..cursor + run)
                .ok_or(CodecError::TruncatedLiteral)?;
            if out.len() + run > raw_len {
                return Err(CodecError::OutputOverflow);
            }
            out.extend_from_slice(literals);
            cursor += run;
        } else {
            let length = usize::from(control & 0x7f) + MIN_MATCH;
            let [high, low] = input
                .get(cursor..cursor + 2)
                .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
                .ok_or(CodecError::TruncatedMatch)?;
            cursor += 2;
            let distance = usize::from(u16::from_be_bytes([high, low]));
            if distance == 0 {
                return Err(CodecError::ZeroDistance);
            }
            if distance > out.len() {
                return Err(CodecError::DistanceBeyondOutput);
            }
            if out.len() + length > raw_len {
                return Err(CodecError::OutputOverflow);
            }
            let start = out.len() - distance;
            for offset in 0..length {
                let byte = out
                    .get(start + offset)
                    .copied()
                    .ok_or(CodecError::DistanceBeyondOutput)?;
                out.push(byte);
            }
        }
    }
    if out.len() != raw_len {
        return Err(CodecError::OutputShort);
    }
    Ok(out)
}

fn push_literals(out: &mut Vec<u8>, mut literals: &[u8]) {
    while !literals.is_empty() {
        let run = literals.len().min(MAX_LITERAL_RUN);
        let (head, tail) = literals.split_at(run);
        // run is within 1..=128, so run - 1 fits the seven-bit length field.
        out.push((run - 1) as u8);
        out.extend_from_slice(head);
        literals = tail;
    }
}

fn read4(input: &[u8], position: usize) -> Option<[u8; 4]> {
    input
        .get(position..position.checked_add(4)?)
        .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
}

fn hash4(key: [u8; 4]) -> usize {
    let value = u32::from_le_bytes(key).wrapping_mul(0x9E37_79B1);
    (value >> (32 - HASH_BITS)) as usize
}
