//! Keccak-256 as used by EVM chains (original Keccak padding, not SHA3-256).
//!
//! Census needs Keccak-256 to bind a block header to its hash and to derive
//! ABI selectors/topics from declared signatures. It is a pure function with no
//! dependency, so the single implementation lives in the core crate.

const RATE: usize = 136;

const ROUND_CONSTANTS: [u64; 24] = [
    0x0000_0000_0000_0001,
    0x0000_0000_0000_8082,
    0x8000_0000_0000_808a,
    0x8000_0000_8000_8000,
    0x0000_0000_0000_808b,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8009,
    0x0000_0000_0000_008a,
    0x0000_0000_0000_0088,
    0x0000_0000_8000_8009,
    0x0000_0000_8000_000a,
    0x0000_0000_8000_808b,
    0x8000_0000_0000_008b,
    0x8000_0000_0000_8089,
    0x8000_0000_0000_8003,
    0x8000_0000_0000_8002,
    0x8000_0000_0000_0080,
    0x0000_0000_0000_800a,
    0x8000_0000_8000_000a,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8080,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8008,
];

const ROTATIONS: [u32; 24] = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

const PI_LANES: [usize; 24] = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

fn permute(state: &mut [u64; 25]) {
    for round_constant in ROUND_CONSTANTS {
        let mut columns = [0_u64; 5];
        for (x, column) in columns.iter_mut().enumerate() {
            *column = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        }
        for x in 0..5 {
            let delta = columns[(x + 4) % 5] ^ columns[(x + 1) % 5].rotate_left(1);
            for y in (0..25).step_by(5) {
                state[y + x] ^= delta;
            }
        }

        let mut carried = state[1];
        for (lane, rotation) in PI_LANES.iter().zip(ROTATIONS) {
            let next = state[*lane];
            state[*lane] = carried.rotate_left(rotation);
            carried = next;
        }

        for y in (0..25).step_by(5) {
            let row = [
                state[y],
                state[y + 1],
                state[y + 2],
                state[y + 3],
                state[y + 4],
            ];
            for x in 0..5 {
                state[y + x] = row[x] ^ (!row[(x + 1) % 5] & row[(x + 2) % 5]);
            }
        }

        state[0] ^= round_constant;
    }
}

fn absorb(state: &mut [u64; 25], block: &[u8; RATE]) {
    let (words, _) = block.as_chunks::<8>();
    for (lane, word) in state.iter_mut().zip(words) {
        *lane ^= u64::from_le_bytes(*word);
    }
    permute(state);
}

/// Keccak-256 digest of `data`.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut state = [0_u64; 25];
    let (blocks, remainder) = data.as_chunks::<RATE>();
    for block in blocks {
        absorb(&mut state, block);
    }

    let mut last = [0_u8; RATE];
    last[..remainder.len()].copy_from_slice(remainder);
    last[remainder.len()] ^= 0x01;
    last[RATE - 1] ^= 0x80;
    absorb(&mut state, &last);

    let mut out = [0_u8; 32];
    let (chunks, _) = out.as_chunks_mut::<8>();
    for (chunk, lane) in chunks.iter_mut().zip(state) {
        *chunk = lane.to_le_bytes();
    }
    out
}
