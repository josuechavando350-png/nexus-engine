//! Uniswap V2 pair state decoding and runtime-identity derivation.
//!
//! Pair runtime identity is derived, not sampled per pair: every pair of the
//! admitted factory is created with CREATE2 from one init code that is
//! embedded in the factory's own observed runtime. The census locates that
//! init code inside the factory runtime, hashes it, and requires every pair
//! address to equal `CREATE2(factory, keccak(token0 ‖ token1), init_hash)`.
//! The pair constructor takes no arguments, so all pairs share one runtime;
//! a directly observed pair runtime must be a suffix-bounded slice of the
//! init code and must not contain SELFDESTRUCT.

use crate::uint::U256;
use nqc_census_chain::evm::{CodeScan, OP_SELFDESTRUCT};
use nqc_census_core::{keccak256, Address};

/// `getReserves()` → `(uint112, uint112, uint32)`, strictly canonical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reserves {
    pub reserve0: U256,
    pub reserve1: U256,
    pub block_timestamp_last: u64,
}

impl Reserves {
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != 96 {
            return None;
        }
        let word = |index: usize| {
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes[32 * index..32 * (index + 1)]);
            U256::from_word(&out)
        };
        let (reserve0, reserve1, timestamp) = (word(0), word(1), word(2));
        if reserve0.bits() > 112 || reserve1.bits() > 112 || timestamp.bits() > 32 {
            return None;
        }
        Some(Self {
            reserve0,
            reserve1,
            block_timestamp_last: timestamp.to_u64()?,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.reserve0.is_zero() || self.reserve1.is_zero()
    }
}

/// One canonical uint256 word.
pub fn uint_word(bytes: &[u8]) -> Option<U256> {
    if bytes.len() != 32 {
        return None;
    }
    let mut word = [0u8; 32];
    word.copy_from_slice(bytes);
    Some(U256::from_word(&word))
}

/// One canonical address word (zero allowed as `None`).
pub fn address_word(bytes: &[u8]) -> Option<Option<Address>> {
    if bytes.len() != 32 || bytes[..12].iter().any(|byte| *byte != 0) {
        return None;
    }
    let mut raw = [0u8; 20];
    raw.copy_from_slice(&bytes[12..]);
    Some(Address::new(raw).ok())
}

pub fn create2_address(factory: Address, salt: [u8; 32], init_code_hash: [u8; 32]) -> [u8; 20] {
    let mut preimage = Vec::with_capacity(85);
    preimage.push(0xff);
    preimage.extend_from_slice(factory.as_bytes());
    preimage.extend_from_slice(&salt);
    preimage.extend_from_slice(&init_code_hash);
    let digest = keccak256(&preimage);
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest[12..]);
    out
}

pub fn pair_salt(token0: Address, token1: Address) -> [u8; 32] {
    let mut packed = Vec::with_capacity(40);
    packed.extend_from_slice(token0.as_bytes());
    packed.extend_from_slice(token1.as_bytes());
    keccak256(&packed)
}

/// The init code embedded in a factory runtime, located by exact offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedInitCode {
    pub offset: usize,
    pub length: usize,
    pub hash: [u8; 32],
}

/// Every `(offset, length)` slice of `factory_code` that starts with the
/// Solidity creation prelude and hashes to `expected`. The declared hash is
/// only a search key: the result is the observed bytes' own hash.
pub fn locate_init_code(factory_code: &[u8], expected: [u8; 32]) -> Vec<EmbeddedInitCode> {
    const PRELUDE: [u8; 5] = [0x60, 0x80, 0x60, 0x40, 0x52];
    let mut found = Vec::new();
    for offset in 0..factory_code.len().saturating_sub(PRELUDE.len()) {
        if factory_code[offset..offset + PRELUDE.len()] != PRELUDE {
            continue;
        }
        for end in offset + PRELUDE.len()..=factory_code.len() {
            if keccak256(&factory_code[offset..end]) == expected {
                found.push(EmbeddedInitCode {
                    offset,
                    length: end - offset,
                    hash: expected,
                });
            }
        }
    }
    found
}

/// Whether `runtime` is a contiguous slice of `init_code` (the constructor
/// returns a CODECOPY of its own trailing bytes) and is free of SELFDESTRUCT.
pub fn runtime_from_init_code(init_code: &[u8], runtime: &[u8]) -> bool {
    !runtime.is_empty()
        && init_code
            .windows(runtime.len())
            .any(|window| window == runtime)
        && !CodeScan::new(runtime).has_opcode(OP_SELFDESTRUCT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(hex: &str) -> Address {
        Address::parse_hex(hex).unwrap_or_else(|_| unreachable!("fixture address"))
    }

    #[test]
    fn create2_matches_the_canonical_uniswap_v2_usdc_weth_pair() {
        // Public mainnet constants (factory, init code hash, USDC, WETH and
        // their pair), used here only as a known-answer vector for CREATE2.
        let factory = address("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
        let usdc = address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
        let weth = address("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
        let mut init = [0u8; 32];
        let text = "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";
        for (index, byte) in init.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[2 * index..2 * index + 2], 16).unwrap_or(0);
        }
        let pair = create2_address(factory, pair_salt(usdc, weth), init);
        assert_eq!(
            Address::new(pair).map(|pair| pair.to_hex()).ok(),
            Some("0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc".to_owned())
        );
    }

    #[test]
    fn reserves_decode_is_width_strict() {
        let mut bytes = vec![0u8; 96];
        bytes[31] = 5;
        bytes[63] = 7;
        bytes[95] = 9;
        let reserves = Reserves::decode(&bytes).unwrap_or_else(|| unreachable!("canonical"));
        assert_eq!(reserves.reserve0, U256::from_u64(5));
        assert_eq!(reserves.reserve1, U256::from_u64(7));
        assert_eq!(reserves.block_timestamp_last, 9);
        assert!(!reserves.is_empty());
        let mut wide = bytes.clone();
        wide[17] = 1; // bit 112 of reserve0
        assert!(Reserves::decode(&wide).is_none());
        let mut late = bytes.clone();
        late[91] = 1; // bit 32 of the timestamp
        assert!(Reserves::decode(&late).is_none());
        assert!(Reserves::decode(&bytes[..64]).is_none());
    }

    #[test]
    fn embedded_init_code_is_located_exactly() {
        let init = [0x60, 0x80, 0x60, 0x40, 0x52, 0x34, 0x80, 0x15, 0xaa, 0xbb];
        let mut factory = vec![0x00, 0x60, 0x80];
        factory.extend_from_slice(&init);
        factory.extend_from_slice(&[0xfe, 0x60, 0x80, 0x60, 0x40, 0x52]);
        let found = locate_init_code(&factory, keccak256(&init));
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].offset, found[0].length), (3, init.len()));
        assert!(locate_init_code(&factory, [7u8; 32]).is_empty());
        assert!(runtime_from_init_code(&init, &[0x15, 0xaa, 0xbb]));
        assert!(!runtime_from_init_code(&init, &[0xbb, 0x15]));
        assert!(!runtime_from_init_code(&[0x60, 0xff], &[0xff]));
    }
}
