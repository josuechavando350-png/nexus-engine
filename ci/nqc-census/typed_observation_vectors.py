#!/usr/bin/env python3
"""Independent RMC-003 typed-observation encoder and golden-vector verifier.

This file shares no code with the Rust implementation. It re-derives, from the
contract in OBSERVATION_PIPELINE_CONTRACT.md section 7, the canonical payload
bytes, class-separated raw-payload digests, envelope digests, and canonical
typed-observation bytes for LOG, CONTRACT_CALL, RUNTIME_CODE and BLOCK_HEADER.

All vectors are synthetic serialization vectors, not chain evidence.

Usage:
  typed_observation_vectors.py --write FILE   regenerate the vector file
  typed_observation_vectors.py --check FILE   fail unless FILE is byte-identical
                                              to a fresh regeneration
"""

import hashlib
import json
import sys

RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
# Rotation offsets r[x][y] from the Keccak reference.
ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
MASK = (1 << 64) - 1


def _rol(value, shift):
    return ((value << shift) | (value >> (64 - shift))) & MASK if shift else value


def _keccak_f(a):
    for rc in RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data):
    rate = 136
    padded = bytearray(data) + b"\x01"
    while len(padded) % rate:
        padded += b"\x00"
    padded[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _keccak_f(a)
    out = b""
    for i in range(4):
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return out


def rlp_bytes(value):
    if len(value) == 1 and value[0] < 0x80:
        return value
    if len(value) <= 55:
        return bytes([0x80 + len(value)]) + value
    length = len(value).to_bytes((len(value).bit_length() + 7) // 8, "big")
    return bytes([0xB7 + len(length)]) + length + value


def rlp_list(items):
    payload = b"".join(rlp_bytes(item) for item in items)
    if len(payload) <= 55:
        return bytes([0xC0 + len(payload)]) + payload
    length = len(payload).to_bytes((len(payload).bit_length() + 7) // 8, "big")
    return bytes([0xF7 + len(length)]) + length + payload


def rlp_uint(value):
    return b"" if value == 0 else value.to_bytes((value.bit_length() + 7) // 8, "big")


def u8(value):
    return value.to_bytes(1, "big")


def u16(value):
    return value.to_bytes(2, "big")


def u32(value):
    return value.to_bytes(4, "big")


def u64(value):
    return value.to_bytes(8, "big")


def filled(byte, width):
    return bytes([byte]) * width


def length_prefixed(value):
    return u32(len(value)) + value


def sha256_domain(domain, payload):
    return hashlib.sha256(domain + b"\x00" + payload).digest()


DOMAINS = {
    "LOG": b"NQC-CENSUS-RAW-LOG-V1",
    "CONTRACT_CALL": b"NQC-CENSUS-RAW-CONTRACT-CALL-V1",
    "RUNTIME_CODE": b"NQC-CENSUS-RAW-RUNTIME-CODE-V1",
    "BLOCK_HEADER": b"NQC-CENSUS-RAW-BLOCK-HEADER-V1",
}
CLASS_TAG = {"LOG": 1, "CONTRACT_CALL": 2, "RUNTIME_CODE": 3, "BLOCK_HEADER": 4}
AUTHORITY_TAG = {"BLOCK_HEADER": 1, "CONTRACT_CALL": 2, "LOG": 3, "RUNTIME_CODE": 5}
OBSERVATION_DOMAIN = b"NQC-CENSUS-OBSERVATION-V1"
MAGIC = b"NQC-CENSUS-OBS"
SCHEMA = 1

CHAIN_ID = 1
GENESIS = filled(0x11, 32)
LINEAGE = filled(0x22, 32)
SEMANTICS = (filled(0xC0, 32), filled(0xC1, 32))
PROVENANCE = (1, filled(0x31, 32), filled(0x32, 32), filled(0x33, 32))
# The same 32 arbitrary bytes are placed into every class.
SHARED_BYTES = bytes(range(0xE0, 0x100))


def synthetic_header():
    fields = [
        filled(0xA0, 32),              # 0 parent hash
        filled(0x1D, 32),              # 1 ommers hash
        filled(0xBE, 20),              # 2 beneficiary
        filled(0x5A, 32),              # 3 state root
        filled(0x7A, 32),              # 4 transactions root
        filled(0x8A, 32),              # 5 receipts root
        filled(0x00, 255) + b"\x01",   # 6 logs bloom
        rlp_uint(0),                   # 7 difficulty
        rlp_uint(19_000_000),          # 8 number
        rlp_uint(30_000_000),          # 9 gas limit
        rlp_uint(12_345_678),          # 10 gas used
        rlp_uint(1_700_000_000),       # 11 timestamp
        SHARED_BYTES,                  # 12 extra data
        filled(0x3C, 32),              # 13 mix hash / prev randao
        filled(0x00, 8),               # 14 nonce
        rlp_uint(7),                   # 15 base fee
        filled(0x9A, 32),              # 16 withdrawals root
        rlp_uint(131_072),             # 17 blob gas used
        rlp_uint(0),                   # 18 excess blob gas
        filled(0x4B, 32),              # 19 parent beacon block root
        filled(0x6C, 32),              # 20 requests hash
    ]
    encoded = rlp_list(fields)
    return encoded, keccak256(encoded)


HEADER_RLP, HEADER_HASH = synthetic_header()
ANCHOR = {
    "number": 19_000_000,
    "hash": HEADER_HASH,
    "parent": filled(0xA0, 32),
    "timestamp": 1_700_000_000,
    "state_root": filled(0x5A, 32),
}


def anchor_bytes():
    return (
        u64(CHAIN_ID) + GENESIS + LINEAGE + u64(ANCHOR["number"]) + ANCHOR["hash"]
        + ANCHOR["parent"] + u64(ANCHOR["timestamp"]) + ANCHOR["state_root"]
    )


def envelope_digest(authority_tag, raw_digest):
    namespace, locator, request, response = PROVENANCE
    return hashlib.sha256(
        OBSERVATION_DOMAIN + b"\x00" + anchor_bytes() + SEMANTICS[0] + SEMANTICS[1]
        + u8(authority_tag) + u16(namespace) + locator + request + response + raw_digest
    ).digest()


def tlv(tag, value):
    return u8(tag) + length_prefixed(value)


def typed_observation(klass, payload):
    raw = sha256_domain(DOMAINS[klass], payload)
    authority = AUTHORITY_TAG[klass]
    obs = envelope_digest(authority, raw)
    namespace, locator, request, response = PROVENANCE
    canonical = (
        MAGIC + u16(SCHEMA) + u8(CLASS_TAG[klass])
        + tlv(1, anchor_bytes())
        + tlv(2, SEMANTICS[0] + SEMANTICS[1])
        + tlv(3, u8(authority) + u16(namespace) + locator + request + response)
        + tlv(4, payload)
        + tlv(5, raw)
        + tlv(6, obs)
    )
    return {
        "class": klass,
        "canonical_payload_hex": payload.hex(),
        "raw_payload_digest": raw.hex(),
        "observation_digest": obs.hex(),
        "canonical_observation_sha256": hashlib.sha256(canonical).hexdigest(),
        "canonical_observation_length": len(canonical),
    }


def log_payload(emitter, tx_hash, tx_index, log_index, topics, data, removed):
    return (
        emitter + tx_hash + u32(tx_index) + u32(log_index) + u8(len(topics))
        + b"".join(topics) + length_prefixed(data) + u8(1 if removed else 0)
    )


def call_payload(target, calldata, outcome_tag, output):
    # static read context: no caller, zero value, provider default gas
    return target + u8(0) + filled(0, 32) + u8(0) + length_prefixed(calldata) + u8(outcome_tag) + length_prefixed(output)


def code_payload(account, code):
    return account + length_prefixed(code)


def header_payload():
    return u8(1) + HEADER_HASH + length_prefixed(HEADER_RLP)


def legacy_raw_logs():
    """Pre-extension RawLog digests, recomputed independently. The expected
    values were produced by the RMC-003 code at 8032f550 before any change."""
    anchor = (
        u64(1) + GENESIS + LINEAGE + u64(19_000_000) + filled(0xA1, 32) + filled(0xA0, 32)
        + u64(1_700_000_000) + filled(0x5A, 32)
    )
    namespace, locator, request, response = PROVENANCE
    cases = [
        ("two_topics_data", log_payload(filled(0x41, 20), filled(0x42, 32), 7, 9,
                                        [filled(0x43, 32), filled(0x44, 32)], bytes.fromhex("deadbeef"), False)),
        ("no_topics_empty_removed", log_payload(filled(0x51, 20), filled(0x52, 32), 0, 0, [], b"", True)),
        ("four_topics", log_payload(filled(0x61, 20), filled(0x62, 32), 0xFFFFFFFF, 1,
                                    [filled(i, 32) for i in (1, 2, 3, 4)], bytes(range(65)), False)),
    ]
    out = []
    for name, payload in cases:
        raw = sha256_domain(DOMAINS["LOG"], payload)
        obs = hashlib.sha256(
            OBSERVATION_DOMAIN + b"\x00" + anchor + SEMANTICS[0] + SEMANTICS[1]
            + u8(3) + u16(namespace) + locator + request + response + raw
        ).digest()
        out.append({"name": name, "raw_payload_digest": raw.hex(), "observation_digest": obs.hex()})
    return out


PINNED_LEGACY = {
    "two_topics_data": (
        "e3c859d9a38f61c9ed278c5d016115294f12ef5157d1e6535e7d23aeb3b9ce20",
        "39584a5dad7db7ec899192ec2396bd07ff37a92a3aea78686dceda5e56ece56a",
    ),
    "no_topics_empty_removed": (
        "bcbba7a2e35023c8da5d1002f426be489f9ca55b196834dc361468e37410ef1c",
        "90ebf6cf00583bb331fd92cff1b4b559a436f1a35b5a1f01d4bdae24283c5f34",
    ),
    "four_topics": (
        "ba3c2476fcc21a650734a1e3ff2884eb36cf795716e7bf426381606526766314",
        "baac4fde3452b39a7946c9a2ecbeac0e959ab28e063f784f6f4d4f814db1292c",
    ),
}


def build():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"

    legacy = legacy_raw_logs()
    for vector in legacy:
        pinned = PINNED_LEGACY[vector["name"]]
        assert (vector["raw_payload_digest"], vector["observation_digest"]) == pinned, vector["name"]

    shared = [
        typed_observation("LOG", log_payload(filled(0x41, 20), filled(0x42, 32), 7, 9,
                                             [filled(0x43, 32)], SHARED_BYTES, False)),
        typed_observation("CONTRACT_CALL", call_payload(filled(0x61, 20), bytes.fromhex("72218d04"), 1, SHARED_BYTES)),
        typed_observation("RUNTIME_CODE", code_payload(filled(0x71, 20), SHARED_BYTES)),
        typed_observation("BLOCK_HEADER", header_payload()),
    ]
    digests = {v["observation_digest"] for v in shared} | {v["raw_payload_digest"] for v in shared}
    assert len(digests) == 8, "typed classes collided"

    reverted = typed_observation("CONTRACT_CALL", call_payload(filled(0x61, 20), bytes.fromhex("72218d04"), 2, SHARED_BYTES))
    absent_code = typed_observation("RUNTIME_CODE", code_payload(filled(0x71, 20), b""))

    keccak_vectors = {
        "": keccak256(b"").hex(),
        "abc": keccak256(b"abc").hex(),
        "Transfer(address,address,uint256)": keccak256(b"Transfer(address,address,uint256)").hex(),
        "135_zero_bytes": keccak256(bytes(135)).hex(),
        "136_zero_bytes": keccak256(bytes(136)).hex(),
        "137_zero_bytes": keccak256(bytes(137)).hex(),
    }

    return {
        "schema_version": 1,
        "purpose": "SYNTHETIC_TYPED_OBSERVATION_SERIALIZATION_VECTORS_NOT_CHAIN_EVIDENCE",
        "typed_observation_schema_version": SCHEMA,
        "domains": {k: v.decode() for k, v in DOMAINS.items()},
        "observation_domain": OBSERVATION_DOMAIN.decode(),
        "keccak256": keccak_vectors,
        "synthetic_header": {
            "rlp_hex": HEADER_RLP.hex(),
            "hash": HEADER_HASH.hex(),
            "field_count": 21,
        },
        "shared_bytes_hex": SHARED_BYTES.hex(),
        "shared_payload_vectors": shared,
        "reverted_call_vector": reverted,
        "absent_code_vector": absent_code,
        "legacy_raw_log_vectors": legacy,
    }


def render():
    return json.dumps(build(), indent=2, sort_keys=True) + "\n"


def main(argv):
    if len(argv) != 3 or argv[1] not in ("--write", "--check"):
        print(__doc__, file=sys.stderr)
        return 2
    text = render()
    if argv[1] == "--write":
        with open(argv[2], "w", encoding="utf-8") as handle:
            handle.write(text)
        print("TYPED_OBSERVATION_VECTORS_WRITTEN")
        return 0
    with open(argv[2], encoding="utf-8") as handle:
        committed = handle.read()
    if committed != text:
        print("TYPED_OBSERVATION_VECTORS=FAIL committed vectors differ from independent regeneration", file=sys.stderr)
        return 1
    print("TYPED_OBSERVATION_VECTORS=PASS independent regeneration is byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
