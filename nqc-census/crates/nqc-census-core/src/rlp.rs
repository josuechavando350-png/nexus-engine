//! Strict canonical RLP decoding for the flat byte-string lists used by EVM
//! block headers. Non-minimal encodings are rejected so that one header has
//! exactly one accepted byte representation.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RlpError {
    Empty,
    Truncated,
    TrailingBytes,
    NonCanonical,
    ExpectedList,
    NestedList,
    LengthOverflow,
}

impl RlpError {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Empty => "empty RLP input",
            Self::Truncated => "truncated RLP item",
            Self::TrailingBytes => "trailing bytes after RLP list",
            Self::NonCanonical => "non-canonical RLP encoding",
            Self::ExpectedList => "RLP header must be a list",
            Self::NestedList => "RLP header field must be a byte string",
            Self::LengthOverflow => "RLP length overflows",
        }
    }
}

enum Item<'a> {
    Bytes(&'a [u8]),
    List(&'a [u8]),
}

fn read_length(bytes: &[u8]) -> Result<usize, RlpError> {
    if bytes.first() == Some(&0) {
        return Err(RlpError::NonCanonical);
    }
    if bytes.len() > std::mem::size_of::<usize>() {
        return Err(RlpError::LengthOverflow);
    }
    let mut value = 0_usize;
    for byte in bytes {
        value = (value << 8) | usize::from(*byte);
    }
    Ok(value)
}

fn split_payload(input: &[u8], start: usize, length: usize) -> Result<(&[u8], &[u8]), RlpError> {
    let end = start.checked_add(length).ok_or(RlpError::LengthOverflow)?;
    if end > input.len() {
        return Err(RlpError::Truncated);
    }
    Ok((&input[start..end], &input[end..]))
}

fn decode_item(input: &[u8]) -> Result<(Item<'_>, &[u8]), RlpError> {
    let Some(&prefix) = input.first() else {
        return Err(RlpError::Empty);
    };
    match prefix {
        0x00..=0x7f => Ok((Item::Bytes(&input[..1]), &input[1..])),
        0x80..=0xb7 => {
            let length = usize::from(prefix - 0x80);
            let (payload, rest) = split_payload(input, 1, length)?;
            if length == 1 && payload[0] < 0x80 {
                return Err(RlpError::NonCanonical);
            }
            Ok((Item::Bytes(payload), rest))
        }
        0xb8..=0xbf => {
            let length_of_length = usize::from(prefix - 0xb7);
            let (length_bytes, _) = split_payload(input, 1, length_of_length)?;
            let length = read_length(length_bytes)?;
            if length <= 55 {
                return Err(RlpError::NonCanonical);
            }
            let (payload, rest) = split_payload(input, 1 + length_of_length, length)?;
            Ok((Item::Bytes(payload), rest))
        }
        0xc0..=0xf7 => {
            let length = usize::from(prefix - 0xc0);
            let (payload, rest) = split_payload(input, 1, length)?;
            Ok((Item::List(payload), rest))
        }
        0xf8..=0xff => {
            let length_of_length = usize::from(prefix - 0xf7);
            let (length_bytes, _) = split_payload(input, 1, length_of_length)?;
            let length = read_length(length_bytes)?;
            if length <= 55 {
                return Err(RlpError::NonCanonical);
            }
            let (payload, rest) = split_payload(input, 1 + length_of_length, length)?;
            Ok((Item::List(payload), rest))
        }
    }
}

/// Decodes one canonical RLP list whose elements are all byte strings and which
/// consumes the entire input.
pub(crate) fn decode_flat_list(input: &[u8]) -> Result<Vec<&[u8]>, RlpError> {
    let (item, rest) = decode_item(input)?;
    if !rest.is_empty() {
        return Err(RlpError::TrailingBytes);
    }
    let Item::List(mut payload) = item else {
        return Err(RlpError::ExpectedList);
    };
    let mut fields = Vec::new();
    while !payload.is_empty() {
        let (field, rest) = decode_item(payload)?;
        match field {
            Item::Bytes(bytes) => fields.push(bytes),
            Item::List(_) => return Err(RlpError::NestedList),
        }
        payload = rest;
    }
    Ok(fields)
}

/// Canonical RLP unsigned integer: no leading zero byte, empty means zero.
pub(crate) fn decode_u64(bytes: &[u8]) -> Result<u64, RlpError> {
    if bytes.first() == Some(&0) {
        return Err(RlpError::NonCanonical);
    }
    if bytes.len() > 8 {
        return Err(RlpError::LengthOverflow);
    }
    let mut value = 0_u64;
    for byte in bytes {
        value = (value << 8) | u64::from(*byte);
    }
    Ok(value)
}
