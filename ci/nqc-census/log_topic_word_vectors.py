#!/usr/bin/env python3
"""Independent RMC-003.2 log-topic-word vectors.

RMC-003.2 allows an EVM log topic to be an all-zero 32-byte word (an indexed
zero address, zero amount or zero bytes32). The canonical LOG payload bytes are
unchanged: a topic is still exactly 32 raw bytes. This file re-derives, with the
independent RMC-003.1 encoder (typed_observation_vectors.py, which shares no
code with Rust), the digests of typed LOG observations that contain zero
topics, and checks that the RMC-003 and RMC-003.1 vectors are unchanged.

All vectors are synthetic serialization vectors, not chain evidence.

Usage:
  log_topic_word_vectors.py --write FILE   regenerate the vector file
  log_topic_word_vectors.py --check FILE   fail unless FILE is byte-identical
                                           to a fresh regeneration
"""

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("typed_vectors", HERE / "typed_observation_vectors.py")
typed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(typed)

ZERO = bytes(32)


def address_word(byte):
    return bytes(12) + typed.filled(byte, 20)


def build():
    base = typed.build()
    committed = json.loads((HERE / "typed-observation-vectors.json").read_text())
    assert base == committed, "RMC-003.1 vectors changed"

    cases = [
        (
            "zero_indexed_address_topic",
            [typed.filled(0x43, 32), ZERO, address_word(0x44)],
            typed.SHARED_BYTES,
        ),
        ("all_zero_topics", [ZERO, ZERO, ZERO, ZERO], b""),
    ]
    vectors = []
    for name, topics, data in cases:
        payload = typed.log_payload(typed.filled(0x41, 20), typed.filled(0x42, 32), 7, 9, topics, data, False)
        vector = typed.typed_observation("LOG", payload)
        vector["name"] = name
        vectors.append(vector)

    # A nonzero-topic LOG is byte-identical to the RMC-003.1 shared LOG vector.
    shared_log = base["shared_payload_vectors"][0]
    regenerated = typed.typed_observation(
        "LOG",
        typed.log_payload(typed.filled(0x41, 20), typed.filled(0x42, 32), 7, 9,
                          [typed.filled(0x43, 32)], typed.SHARED_BYTES, False),
    )
    assert regenerated == shared_log, "nonzero-topic LOG encoding changed"

    return {
        "schema_version": 1,
        "purpose": "SYNTHETIC_LOG_TOPIC_WORD_VECTORS_NOT_CHAIN_EVIDENCE",
        "rule": "LOG topics are 32-byte words that may be zero; transaction, block, code and configuration hashes stay nonzero",
        "unchanged_rmc003_1_log_vector": shared_log,
        "legacy_raw_log_vectors": base["legacy_raw_log_vectors"],
        "zero_topic_vectors": vectors,
    }


def render():
    return json.dumps(build(), indent=2, sort_keys=True) + "\n"


def main(argv):
    if len(argv) != 3 or argv[1] not in ("--write", "--check"):
        print(__doc__, file=sys.stderr)
        return 2
    text = render()
    if argv[1] == "--write":
        Path(argv[2]).write_text(text, encoding="utf-8")
        print("LOG_TOPIC_WORD_VECTORS_WRITTEN")
        return 0
    if Path(argv[2]).read_text(encoding="utf-8") != text:
        print("LOG_TOPIC_WORD_VECTORS=FAIL committed vectors differ from independent regeneration", file=sys.stderr)
        return 1
    print("LOG_TOPIC_WORD_VECTORS=PASS independent regeneration is byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
