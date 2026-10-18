//! Deterministic content-defined chunking (GEAR-CDC-V1).
//!
//! A rolling gear hash `h = (h << 1) + GEAR[byte]` is evaluated from the start
//! of each chunk; the chunk ends after the first byte at which the top
//! `chunk_mask_bits` of `h` are zero, provided at least `chunk_min` bytes have
//! been consumed, and never later than `chunk_max`. Because a boundary depends
//! only on the preceding 64 bytes, an insertion or deletion disturbs only the
//! chunks around it, which is what lets overlapping snapshots deduplicate.
//!
//! The gear table is not a magic constant: entry `i` is the first eight bytes
//! (big-endian) of `SHA256("NQC-CENSUS-STORE-GEAR-V1" || 0x00 || i)`.

use crate::canonical::{self, GEAR_DOMAIN};
use crate::config::StoreConfig;

#[derive(Clone)]
pub(crate) struct GearTable([u64; 256]);

impl GearTable {
    pub(crate) fn derive() -> Self {
        let mut table = [0_u64; 256];
        for (byte, slot) in (0..=u8::MAX).zip(table.iter_mut()) {
            let digest = canonical::domain_digest(GEAR_DOMAIN, &[byte]);
            let mut head = [0_u8; 8];
            head.copy_from_slice(&digest[..8]);
            *slot = u64::from_be_bytes(head);
        }
        Self(table)
    }
}

/// Returns the lengths of consecutive chunks covering `data` exactly.
pub(crate) fn chunk_lengths(data: &[u8], config: &StoreConfig, gear: &GearTable) -> Vec<usize> {
    let min = usize_from(config.chunk_min());
    let max = usize_from(config.chunk_max());
    let mask = u64::MAX << (64 - u32::from(config.chunk_mask_bits()));
    let mut lengths = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let cut = next_cut(rest, min, max, mask, gear);
        lengths.push(cut);
        rest = rest.get(cut..).unwrap_or_default();
    }
    lengths
}

fn next_cut(data: &[u8], min: usize, max: usize, mask: u64, gear: &GearTable) -> usize {
    if data.len() <= min {
        return data.len();
    }
    let end = data.len().min(max);
    let mut hash = 0_u64;
    for (index, byte) in data.iter().take(end).enumerate() {
        hash = (hash << 1).wrapping_add(gear.0[usize::from(*byte)]);
        if index + 1 >= min && hash & mask == 0 {
            return index + 1;
        }
    }
    end
}

fn usize_from(value: u32) -> usize {
    // Chunk bounds are validated to at most 4 MiB, which fits every supported usize.
    usize::try_from(value).unwrap_or(usize::MAX)
}
