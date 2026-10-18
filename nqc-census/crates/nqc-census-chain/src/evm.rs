//! Deterministic EVM bytecode scanning.
//!
//! The scanner walks opcodes and skips PUSH immediates exactly, so bytes inside
//! push data are never mistaken for instructions. It reports every push
//! immediate (left-padded to 32 bytes), exact 20-byte pushes (library/contract
//! address candidates), and the presence of context-altering or destructive
//! opcodes. A trailing Solidity CBOR metadata section is excluded when its
//! length footer is self-consistent.
//!
//! This is evidence, not proof of behaviour: a selector push is a necessary
//! condition for a Solidity dispatcher entry and a topic push is a necessary
//! condition for emitting that event. Callers combine it with call results.

use std::collections::BTreeSet;

pub const OP_SELFDESTRUCT: u8 = 0xff;
pub const OP_DELEGATECALL: u8 = 0xf4;
pub const OP_CALLCODE: u8 = 0xf2;
pub const OP_CREATE: u8 = 0xf0;
pub const OP_CREATE2: u8 = 0xf5;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CodeScan {
    pushes: BTreeSet<[u8; 32]>,
    push20: BTreeSet<[u8; 20]>,
    opcodes: BTreeSet<u8>,
    metadata_bytes: usize,
    truncated_push: bool,
    code_len: usize,
}

impl CodeScan {
    pub fn new(code: &[u8]) -> Self {
        let metadata_bytes = metadata_length(code);
        let body = &code[..code.len() - metadata_bytes];
        let mut scan = Self {
            metadata_bytes,
            code_len: code.len(),
            ..Self::default()
        };
        let mut index = 0;
        while index < body.len() {
            let opcode = body[index];
            scan.opcodes.insert(opcode);
            index += 1;
            if (0x60..=0x7f).contains(&opcode) {
                let width = usize::from(opcode - 0x5f);
                let end = index + width;
                if end > body.len() {
                    scan.truncated_push = true;
                    break;
                }
                let immediate = &body[index..end];
                let mut word = [0_u8; 32];
                word[32 - width..].copy_from_slice(immediate);
                scan.pushes.insert(word);
                if width == 20 {
                    let mut address = [0_u8; 20];
                    address.copy_from_slice(immediate);
                    scan.push20.insert(address);
                }
                index = end;
            }
        }
        scan
    }

    /// A 4-byte selector pushed by any PUSH1..PUSH32 (optimizers shorten
    /// selectors with leading zero bytes).
    pub fn has_selector(&self, selector: [u8; 4]) -> bool {
        let mut word = [0_u8; 32];
        word[28..].copy_from_slice(&selector);
        self.pushes.contains(&word)
    }

    pub fn has_word(&self, word: &[u8; 32]) -> bool {
        self.pushes.contains(word)
    }

    pub fn has_opcode(&self, opcode: u8) -> bool {
        self.opcodes.contains(&opcode)
    }

    pub fn push20_candidates(&self) -> &BTreeSet<[u8; 20]> {
        &self.push20
    }

    pub const fn metadata_bytes(&self) -> usize {
        self.metadata_bytes
    }

    pub const fn truncated_push(&self) -> bool {
        self.truncated_push
    }

    pub const fn code_len(&self) -> usize {
        self.code_len
    }
}

/// Length of a trailing Solidity metadata section (CBOR map + 2-byte length),
/// or zero when the footer is not self-consistent.
fn metadata_length(code: &[u8]) -> usize {
    let Some(footer) = code
        .len()
        .checked_sub(2)
        .and_then(|start| code.get(start..))
    else {
        return 0;
    };
    let length = usize::from(u16::from_be_bytes([footer[0], footer[1]]));
    let total = length + 2;
    if length == 0 || total > code.len() {
        return 0;
    }
    let start = code.len() - total;
    match code[start] {
        0xa1..=0xa5 => total,
        _ => 0,
    }
}
