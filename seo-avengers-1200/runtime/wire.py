from __future__ import annotations

import hashlib
import re
from typing import Any

_SAFE_INTEGER = 9_007_199_254_740_991
_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


def _wire_bytes(value: Any, path: str = "$") -> bytes:
    if value is None:
        return b"n;"
    if type(value) is bool:
        return b"b1;" if value else b"b0;"
    if isinstance(value, int) and not isinstance(value, bool):
        if not -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            raise TypeError(f"{path} integer is outside the shared JS/Python safe range")
        return b"i" + str(value).encode("ascii") + b";"
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return b"s" + str(len(encoded)).encode("ascii") + b":" + encoded
    if isinstance(value, list):
        parts = [b"a", str(len(value)).encode("ascii"), b"["]
        for index, item in enumerate(value):
            parts.append(_wire_bytes(item, f"{path}[{index}]"))
        parts.append(b"]")
        return b"".join(parts)
    if isinstance(value, dict):
        keys = list(value.keys())
        for key in keys:
            if not isinstance(key, str) or not _KEY_RE.fullmatch(key):
                raise TypeError(f"{path} contains a non-canonical object key")
        keys.sort()
        parts = [b"o", str(len(keys)).encode("ascii"), b"{"]
        for key in keys:
            parts.append(_wire_bytes(key, f"{path}.<key>"))
            parts.append(_wire_bytes(value[key], f"{path}.{key}"))
        parts.append(b"}")
        return b"".join(parts)
    raise TypeError(f"{path} contains a non-wire value")


def envelope_hash_v1(value: Any) -> str:
    """Cross-runtime SHA-256 over a typed canonical byte encoding.

    Unlike runtime receipt hashing, this encoding is intentionally implemented
    byte-for-byte in both Node and Python because the producer and consumer are
    different runtimes. Object keys are restricted to ASCII contract keys,
    integers to the exact JS/Python shared safe range, and strings are framed by
    UTF-8 byte length.
    """
    return "sha256:" + hashlib.sha256(_wire_bytes(value)).hexdigest()
