#!/usr/bin/env python3
"""Recover two known transfer omissions only if the original SHA-256 matches."""
import hashlib
from pathlib import Path

path = Path(__file__).with_name('higher-order-b1.b64')
source = path.read_bytes()
assert len(source) == 12499, 'unexpected transfer length'
assert hashlib.sha256(source).hexdigest() == 'c666c1012e46161270c4eb189be3ad230c57db2b1c8fe3cd8c204a8f1c372c92', 'unexpected transfer source'
missing = b'TFzegL91iEP3ryQ2CxqHdJTPrQw7'
assert len(missing) == 28
source = source[:9178] + missing + source[9178:]
assert len(source) == 12527
expected = 'e3a24f217045585355cea3b76b20d95828d4806c9bfb5a71cd12096368ba5aea'
alphabet = b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for index in range(len(source) + 1):
    left, right = source[:index], source[index:]
    for char in alphabet:
        candidate = left + bytes((char,)) + right
        if hashlib.sha256(candidate).hexdigest() == expected:
            path.write_bytes(candidate)
            print(f'Exact source restored: second insertion at {index}, character {chr(char)!r}; SHA-256 {expected}', flush=True)
            raise SystemExit(0)
raise SystemExit('Source transfer cannot be restored to the expected SHA-256')
