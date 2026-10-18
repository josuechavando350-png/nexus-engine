#!/usr/bin/env python3
"""Independent offline verifier for RMC-004 evidence stores.

A second, non-Rust implementation of ci/nqc-census/STORE_CONTRACT.md written
from the contract, using only the Python standard library. It shares no code
with nqc-census-store. It needs only the store directory: no network, RPC,
secret, signer, SaaS or CI service.

Usage:
  verify_store_independent.py --store DIR
      [--require-range SCOPE_HEX:FIRST:LAST]... [--expect-root HEX]

Exit status: 0 verified, 1 verification failed, 2 usage error.
"""

import argparse
import hashlib
import os
import stat
import sys

MAGIC = b"NQC-CENSUS-STORE"
VERSION = 1
KIND = {"config": 1, "frame": 2, "manifest": 3, "scope": 4, "checkpoint": 5,
        "head": 6, "anchor": 7, "deployment": 8}
FRAME_RAW, FRAME_LZ = 1, 2
POLICY_RAW, POLICY_LZ = 1, 2
MASK64 = (1 << 64) - 1
PROTOCOL_TAGS = {0x0102, 0x0103, 0x0104, 0x0202}
SMALL_LIMIT = 4096
CHECKPOINT_LIMIT = 4 * 1024 * 1024
MAX_EVIDENCE = 65536


class Fail(Exception):
    def __init__(self, code, path, reason):
        super().__init__(reason)
        self.code, self.path, self.reason = code, path, reason


def sha256(data):
    return hashlib.sha256(data).digest()


def domain(name, payload):
    return sha256(name + b"\x00" + payload)


def tlv(kind, fields):
    out = bytearray(MAGIC + VERSION.to_bytes(2, "big") + bytes([KIND[kind]]))
    for tag, value in fields:
        out += bytes([tag]) + len(value).to_bytes(4, "big") + value
    return bytes(out)


def parse(data, kind, allowed, path):
    if len(data) < 19 or data[:16] != MAGIC:
        raise Fail("MALFORMED", path, f"{kind}: header")
    if int.from_bytes(data[16:18], "big") != VERSION:
        raise Fail("UNSUPPORTED_FORMAT_VERSION", path, kind)
    if data[18] != KIND[kind]:
        raise Fail("MALFORMED", path, f"{kind}: object kind")
    fields, cursor, last = {}, 19, 0
    while cursor < len(data):
        if cursor + 5 > len(data):
            raise Fail("MALFORMED", path, f"{kind}: truncated field header")
        tag = data[cursor]
        if tag <= last:
            raise Fail("MALFORMED", path, f"{kind}: tag order")
        last = tag
        length = int.from_bytes(data[cursor + 1:cursor + 5], "big")
        end = cursor + 5 + length
        if end > len(data):
            raise Fail("MALFORMED", path, f"{kind}: truncated field value")
        fields[tag] = data[cursor + 5:end]
        cursor = end
    if sorted(fields) not in [list(a) for a in allowed]:
        raise Fail("MALFORMED", path, f"{kind}: field set {sorted(fields)}")
    return fields


def uint(value, width, path, what):
    if len(value) != width:
        raise Fail("MALFORMED", path, f"{what}: width")
    return int.from_bytes(value, "big")


def fixed(value, width, path, what, nonzero=False):
    if len(value) != width:
        raise Fail("MALFORMED", path, f"{what}: width")
    if nonzero and value == bytes(width):
        raise Fail("IDENTITY", path, f"{what}: zero")
    return value


# ---------------------------------------------------------------- policy
class Config:
    def __init__(self, data, path):
        f = parse(data, "config", [[1, 2, 3, 4, 5, 6, 7]], path)
        if uint(f[1], 1, path, "chunker") != 1:
            raise Fail("INVALID_CONFIG", path, "chunker")
        self.min = uint(f[2], 4, path, "chunk_min")
        self.bits = uint(f[3], 1, path, "mask bits")
        self.max = uint(f[4], 4, path, "chunk_max")
        self.policy = uint(f[5], 1, path, "compression")
        self.max_artifact = uint(f[6], 8, path, "max artifact")
        if not (self.min >= 64 and self.max > self.min and self.max <= 4 * 1024 * 1024
                and 4 <= self.bits <= 24 and self.policy in (POLICY_RAW, POLICY_LZ)
                and 1 <= self.max_artifact <= 1 << 30
                and -(-self.max_artifact // self.min) <= 1 << 20):
            raise Fail("INVALID_CONFIG", path, "policy bounds")
        body = tlv("config", [(t, f[t]) for t in range(1, 7)])
        self.id = domain(b"NQC-CENSUS-STORE-CONFIG-V1", body)
        if f[7] != self.id:
            raise Fail("DIGEST_MISMATCH", path, "store config seal")
        if tlv("config", [(t, f[t]) for t in range(1, 8)]) != data:
            raise Fail("NON_CANONICAL", path, "store config")
        self.max_chunks = -(-self.max_artifact // self.min)
        self.max_frame = self.max + 64
        self.gear = [int.from_bytes(domain(b"NQC-CENSUS-STORE-GEAR-V1", bytes([i]))[:8], "big")
                     for i in range(256)]


def chunk_lengths(data, cfg):
    mask = ((1 << cfg.bits) - 1) << (64 - cfg.bits)
    out, start = [], 0
    while start < len(data):
        rest = len(data) - start
        if rest <= cfg.min:
            out.append(rest)
            break
        end, h, cut = min(rest, cfg.max), 0, None
        for k in range(end):
            h = ((h << 1) + cfg.gear[data[start + k]]) & MASK64
            if k + 1 >= cfg.min and h & mask == 0:
                cut = k + 1
                break
        cut = end if cut is None else cut
        out.append(cut)
        start += cut
    return out


# ------------------------------------------------------------- NQC-LZ-V1
def hash4(key):
    return ((int.from_bytes(key, "little") * 0x9E3779B1) & 0xFFFFFFFF) >> 18


def push_literals(out, literals):
    for i in range(0, len(literals), 128):
        run = literals[i:i + 128]
        out.append(len(run) - 1)
        out += run


def lz_compress(data):
    n, out, table = len(data), bytearray(), [-1] * (1 << 14)
    literal_start = pos = 0
    while pos + 4 <= n:
        key = data[pos:pos + 4]
        slot = hash4(key)
        cand = table[slot]
        table[slot] = pos
        if cand != -1 and pos - cand <= 65535 and data[cand:cand + 4] == key:
            length = 4
            while length < 131 and pos + length < n and data[pos + length] == data[cand + length]:
                length += 1
            push_literals(out, data[literal_start:pos])
            out.append(0x80 | (length - 4))
            out += (pos - cand).to_bytes(2, "big")
            end = pos + length
            for inner in range(pos + 1, end):
                if inner + 4 <= n:
                    table[hash4(data[inner:inner + 4])] = inner
            pos = literal_start = end
        else:
            pos += 1
    push_literals(out, data[literal_start:])
    return bytes(out)


def lz_decompress(data, raw_len, path):
    out, cursor = bytearray(), 0
    while cursor < len(data):
        control = data[cursor]
        cursor += 1
        if control & 0x80 == 0:
            run = control + 1
            if cursor + run > len(data):
                raise Fail("CODEC", path, "truncated literal run")
            if len(out) + run > raw_len:
                raise Fail("CODEC", path, "output overflow")
            out += data[cursor:cursor + run]
            cursor += run
        else:
            length = (control & 0x7F) + 4
            if cursor + 2 > len(data):
                raise Fail("CODEC", path, "truncated match")
            distance = int.from_bytes(data[cursor:cursor + 2], "big")
            cursor += 2
            if distance == 0 or distance > len(out):
                raise Fail("CODEC", path, "bad distance")
            if len(out) + length > raw_len:
                raise Fail("CODEC", path, "output overflow")
            start = len(out) - distance
            for k in range(length):
                out.append(out[start + k])
    if len(out) != raw_len:
        raise Fail("CODEC", path, "output short")
    return bytes(out)


def encode_frame(raw, cfg):
    codec, payload = FRAME_RAW, raw
    if cfg.policy == POLICY_LZ:
        packed = lz_compress(raw)
        if len(packed) < len(raw):
            codec, payload = FRAME_LZ, packed
    return tlv("frame", [(1, bytes([codec])), (2, len(raw).to_bytes(4, "big")), (3, payload)])


def decode_frame(frame, cfg, path):
    f = parse(frame, "frame", [[1, 2, 3]], path)
    codec = uint(f[1], 1, path, "codec")
    raw_len = uint(f[2], 4, path, "raw_len")
    if raw_len == 0 or raw_len > cfg.max:
        raise Fail("MALFORMED", path, "raw length outside policy")
    if codec == FRAME_RAW:
        if len(f[3]) != raw_len:
            raise Fail("MALFORMED", path, "raw payload length")
        return f[3]
    if codec == FRAME_LZ:
        if cfg.policy != POLICY_LZ:
            raise Fail("MALFORMED", path, "compressed frame under raw policy")
        if len(f[3]) >= raw_len:
            raise Fail("NON_CANONICAL", path, "lz frame not smaller than raw")
        return lz_decompress(f[3], raw_len, path)
    raise Fail("MALFORMED", path, "unknown frame codec")


def encode_manifest(logical, cfg):
    rows, offset = bytearray(), 0
    for length in chunk_lengths(logical, cfg):
        raw = logical[offset:offset + length]
        offset += length
        frame = encode_frame(raw, cfg)
        rows += domain(b"NQC-CENSUS-STORE-CHUNK-V1", raw) + len(raw).to_bytes(4, "big")
        rows += len(frame).to_bytes(4, "big") + domain(b"NQC-CENSUS-STORE-FRAME-V1", frame)
    return tlv("manifest", [(1, cfg.id), (2, sha256(logical)),
                            (3, len(logical).to_bytes(8, "big")), (4, bytes(rows))])


# ----------------------------------------------------------- filesystem
def read_file(path, limit):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        raise Fail("SYMLINK_REJECTED", path, "symlink")
    if not stat.S_ISREG(info.st_mode):
        raise Fail("NOT_A_REGULAR_FILE", path, "not a regular file")
    if info.st_size > limit:
        raise Fail("OBJECT_TOO_LARGE", path, f"exceeds {limit}")
    with open(path, "rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Fail("OBJECT_TOO_LARGE", path, f"exceeds {limit}")
    return data


def require_dir(path, device):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise Fail("SYMLINK_REJECTED", path, "symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise Fail("NOT_A_DIRECTORY", path, "not a directory")
    if info.st_dev != device:
        raise Fail("CROSS_DEVICE", path, "other filesystem")


def names(path):
    return sorted(os.listdir(path))


def exact(path, expected):
    found = names(path)
    for name in found:
        if name not in expected:
            raise Fail("UNEXPECTED_ENTRY", os.path.join(path, name), "unexpected entry")
    for name in expected:
        if name not in found:
            raise Fail("IO", os.path.join(path, name), "missing entry")


def hex32(name):
    if len(name) == 64 and all(c in "0123456789abcdef" for c in name):
        return bytes.fromhex(name)
    return None


# ------------------------------------------------------ scope/checkpoint
def decode_scope(data, path):
    f = parse(data, "scope", [[1, 2, 3, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8, 9]], path)
    chain_id = uint(f[1], 8, path, "chain_id")
    if chain_id == 0:
        raise Fail("IDENTITY", path, "chain_id zero")
    fixed(f[2], 32, path, "genesis", True)
    fixed(f[3], 32, path, "fork lineage", True)
    if 4 in f:
        d = parse(f[4], "deployment", [[1, 2, 3]], path)
        if uint(d[1], 2, path, "protocol") not in PROTOCOL_TAGS:
            raise Fail("INVALID_SCOPE", path, "protocol family")
        fixed(d[2], 20, path, "deployment address", True)
        fixed(d[3], 32, path, "deployment instance", True)
    if uint(f[5], 2, path, "namespace") == 0 or uint(f[6], 2, path, "version") == 0:
        raise Fail("INVALID_SCOPE", path, "stream kind")
    fixed(f[7], 32, path, "semantics", True)
    origin = uint(f[8], 8, path, "origin")
    if origin == 0:
        raise Fail("INVALID_SCOPE", path, "origin zero")
    origin_parent = fixed(f[9], 32, path, "origin parent", True)
    return {"id": domain(b"NQC-CENSUS-STORE-SCOPE-V1", data), "origin": origin,
            "origin_parent": origin_parent}


def decode_anchor(data, path):
    f = parse(data, "anchor", [[1, 2, 3, 4, 5]], path)
    anchor = {"number": uint(f[1], 8, path, "block"), "hash": fixed(f[2], 32, path, "hash", True),
              "parent": fixed(f[3], 32, path, "parent", True),
              "time": uint(f[4], 8, path, "timestamp"),
              "root": fixed(f[5], 32, path, "state root", True)}
    if anchor["number"] == 0 or anchor["time"] == 0 or anchor["hash"] == anchor["parent"]:
        raise Fail("OBSERVATION", path, "invalid state anchor")
    return anchor


def decode_checkpoint(data, scope, path):
    f = parse(data, "checkpoint", [[1, 2, 4, 5, 6], [1, 2, 3, 4, 5, 6]], path)
    if f[1] != scope["id"]:
        raise Fail("SCOPE_MISMATCH", path, "scope id")
    seq = uint(f[2], 8, path, "sequence")
    pred = fixed(f[3], 32, path, "predecessor") if 3 in f else None
    first, last = decode_anchor(f[4], path), decode_anchor(f[5], path)
    ev = f[6]
    if len(ev) % 32 or not ev or len(ev) // 32 > MAX_EVIDENCE:
        raise Fail("INVALID_CHECKPOINT", path, "evidence table")
    evidence = [ev[i:i + 32] for i in range(0, len(ev), 32)]
    if any(evidence[i] >= evidence[i + 1] for i in range(len(evidence) - 1)):
        raise Fail("NON_CANONICAL", path, "evidence not strictly increasing")
    if (seq == 0) != (pred is None):
        raise Fail("INVALID_CHECKPOINT", path, "predecessor presence")
    if seq == 0 and (first["number"] != scope["origin"] or first["parent"] != scope["origin_parent"]):
        raise Fail("INVALID_CHECKPOINT", path, "genesis not at origin")
    if first["number"] < scope["origin"] or first["number"] > last["number"]:
        raise Fail("INVALID_CHECKPOINT", path, "range bounds")
    if last["number"] == MASK64:
        raise Fail("INVALID_CHECKPOINT", path, "range end")
    if first["number"] == last["number"] and first != last:
        raise Fail("INVALID_CHECKPOINT", path, "single-block anchors differ")
    if last["number"] == first["number"] + 1 and last["parent"] != first["hash"]:
        raise Fail("INVALID_CHECKPOINT", path, "adjacent anchors unlinked")
    if first["time"] > last["time"]:
        raise Fail("INVALID_CHECKPOINT", path, "timestamp regresses within range")
    return {"seq": seq, "pred": pred, "first": first, "last": last, "evidence": evidence,
            "id": domain(b"NQC-CENSUS-STORE-CHECKPOINT-V1", data)}


def check_successor(prev, cur, path):
    if cur["seq"] != prev["seq"] + 1:
        raise Fail("DISCONTINUITY", path, "sequence")
    if cur["pred"] != prev["id"]:
        raise Fail("PREDECESSOR_MISMATCH", path, "predecessor")
    if cur["first"]["number"] != prev["last"]["number"] + 1:
        raise Fail("DISCONTINUITY", path, "gap or overlap")
    if cur["first"]["parent"] != prev["last"]["hash"]:
        raise Fail("DISCONTINUITY", path, "lineage")
    if cur["first"]["time"] < prev["last"]["time"]:
        raise Fail("DISCONTINUITY", path, "timestamp")


def decode_head(data, path):
    try:
        f = parse(data, "head", [[1, 2, 3, 4]], path)
        unsealed = tlv("head", [(1, f[1]), (2, f[2]), (3, f[3])])
        ok = (len(f[1]) == 32 and len(f[2]) == 8 and len(f[3]) == 32
              and f[4] == domain(b"NQC-CENSUS-STORE-HEAD-SEAL-V1", unsealed)
              and tlv("head", [(t, f[t]) for t in (1, 2, 3, 4)]) == data)
    except Fail:
        ok = False
    if not ok:
        raise Fail("HEAD_CORRUPT", path, "HEAD cache corrupt")
    return {"scope": f[1], "seq": int.from_bytes(f[2], "big"), "id": f[3]}


# ---------------------------------------------------------------- verify
def verify(root, ranges):
    device = os.lstat(root).st_dev
    require_dir(root, device)
    exact(root, ["STORE", "objects", "streams", "tmp"])
    cfg_bytes = read_file(os.path.join(root, "STORE"), SMALL_LIMIT)
    cfg = Config(cfg_bytes, os.path.join(root, "STORE"))
    objects = os.path.join(root, "objects")
    require_dir(objects, device)
    exact(objects, ["artifacts", "chunks"])

    def fanout(kind):
        base = os.path.join(objects, kind)
        require_dir(base, device)
        for fan in names(base):
            fan_dir = os.path.join(base, fan)
            if len(fan) != 2 or any(c not in "0123456789abcdef" for c in fan):
                raise Fail("INVALID_OBJECT_NAME", fan_dir, "fan-out name")
            require_dir(fan_dir, device)
            for name in names(fan_dir):
                ident = hex32(name)
                if ident is None or name[:2] != fan:
                    raise Fail("INVALID_OBJECT_NAME", os.path.join(fan_dir, name), "name")
                yield ident, os.path.join(fan_dir, name)

    chunks, stored = {}, 0
    for ident, path in fanout("chunks"):
        frame = read_file(path, cfg.max_frame)
        raw = decode_frame(frame, cfg, path)
        if domain(b"NQC-CENSUS-STORE-CHUNK-V1", raw) != ident:
            raise Fail("DIGEST_MISMATCH", path, "chunk id")
        if encode_frame(raw, cfg) != frame:
            raise Fail("NON_CANONICAL", path, "chunk frame")
        chunks[ident] = (domain(b"NQC-CENSUS-STORE-FRAME-V1", frame), raw, len(frame))
        stored += len(frame)

    artifacts, used_chunks, logical_total = set(), set(), 0
    for ident, path in fanout("artifacts"):
        data = read_file(path, 256 + cfg.max_chunks * 72)
        f = parse(data, "manifest", [[1, 2, 3, 4]], path)
        if f[1] != cfg.id:
            raise Fail("FOREIGN_CONFIG", path, "manifest policy")
        if f[2] != ident:
            raise Fail("DIGEST_MISMATCH", path, "manifest artifact id")
        declared_len = uint(f[3], 8, path, "logical length")
        if declared_len > cfg.max_artifact:
            raise Fail("OBJECT_TOO_LARGE", path, "logical artifact exceeds sealed maximum")
        rows = f[4]
        if not rows or len(rows) % 72:
            raise Fail("MALFORMED", path, "chunk table")
        row_count = len(rows) // 72
        if row_count > cfg.max_chunks:
            raise Fail("OBJECT_TOO_LARGE", path, "chunk count exceeds sealed maximum")
        logical = bytearray()
        for i in range(0, len(rows), 72):
            row = rows[i:i + 72]
            cid, digest = row[:32], row[40:72]
            entry = chunks.get(cid)
            if entry is None or entry[0] != digest:
                raise Fail("CHUNK_MISSING", path, cid.hex())
            if int.from_bytes(row[32:36], "big") != len(entry[1]):
                raise Fail("MALFORMED", path, "raw length")
            if int.from_bytes(row[36:40], "big") != entry[2]:
                raise Fail("MALFORMED", path, "stored length")
            if len(logical) + len(entry[1]) > declared_len or len(logical) + len(entry[1]) > cfg.max_artifact:
                raise Fail("OBJECT_TOO_LARGE", path, "logical reconstruction exceeds sealed maximum")
            logical += entry[1]
            used_chunks.add(cid)
        logical = bytes(logical)
        if declared_len != len(logical) or sha256(logical) != ident:
            raise Fail("DIGEST_MISMATCH", path, "artifact")
        if encode_manifest(logical, cfg) != data:
            raise Fail("NON_CANONICAL", path, "artifact manifest")
        artifacts.add(ident)
        logical_total += len(logical)

    streams_dir = os.path.join(root, "streams")
    require_dir(streams_dir, device)
    streams, referenced, abandoned = [], set(), 0
    for name in names(streams_dir):
        stream = os.path.join(streams_dir, name)
        require_dir(stream, device)
        sid = hex32(name)
        if sid is None:
            raise Fail("INVALID_OBJECT_NAME", stream, "scope dir name")
        entries = names(stream)
        for entry in entries:
            if entry not in ("SCOPE", "checkpoints", "HEAD"):
                raise Fail("UNEXPECTED_ENTRY", os.path.join(stream, entry), "unexpected")
        catalog = os.path.join(stream, "checkpoints")
        if "SCOPE" not in entries:
            if entries == []:
                abandoned += 1
                continue
            if entries == ["checkpoints"]:
                # Even an abandoned registration carries a path boundary:
                # validate it before listing so an empty external symlink can
                # never be treated as harmless.
                require_dir(catalog, device)
                if not names(catalog):
                    abandoned += 1
                    continue
            raise Fail("STREAM_NOT_REGISTERED", stream, "no SCOPE")
        scope = decode_scope(read_file(os.path.join(stream, "SCOPE"), SMALL_LIMIT), stream)
        if scope["id"] != sid:
            raise Fail("DIGEST_MISMATCH", stream, "scope id")
        require_dir(catalog, device)
        seqs = []
        for cp_name in names(catalog):
            if len(cp_name) != 20 or not cp_name.isdigit() or f"{int(cp_name):020d}" != cp_name:
                raise Fail("INVALID_OBJECT_NAME", os.path.join(catalog, cp_name), "sequence name")
            seqs.append(int(cp_name))
        seqs.sort()
        for expected, found in enumerate(seqs):
            if found != expected:
                raise Fail("CATALOG_GAP", catalog, f"missing {expected}")
        head_path = os.path.join(stream, "HEAD")
        try:
            head_bytes = read_file(head_path, SMALL_LIMIT)
        except Fail as failure:
            if failure.code == "OBJECT_TOO_LARGE":
                raise Fail("HEAD_CORRUPT", head_path, "oversized") from failure
            raise
        head = decode_head(head_bytes, head_path) if head_bytes is not None else None
        if head and head["scope"] != sid:
            raise Fail("HEAD_CONFLICTS_WITH_AUTHORITY", head_path, "scope")
        prev = None
        for seq in seqs:
            path = os.path.join(catalog, f"{seq:020d}")
            cp = decode_checkpoint(read_file(path, CHECKPOINT_LIMIT), scope, path)
            if cp["seq"] != seq:
                raise Fail("INVALID_CHECKPOINT", path, "sequence field")
            if prev:
                check_successor(prev, cp, path)
            for ident in cp["evidence"]:
                if ident not in artifacts:
                    raise Fail("ARTIFACT_MISSING", path, ident.hex())
                referenced.add(ident)
            if head and head["seq"] == seq and head["id"] != cp["id"]:
                raise Fail("HEAD_CONFLICTS_WITH_AUTHORITY", head_path, "identity")
            prev = cp
        if head and (prev is None or head["seq"] > prev["seq"]):
            raise Fail("HEAD_AHEAD_OF_AUTHORITY", head_path, "ahead")
        streams.append({"id": sid, "count": len(seqs), "origin": scope["origin"],
                        "last": prev["last"]["number"] if prev else None,
                        "tip": prev["id"] if prev else bytes(32)})

    for scope_hex, first, last in ranges:
        match = [s for s in streams if s["id"].hex() == scope_hex]
        if not match:
            raise Fail("STREAM_NOT_REGISTERED", streams_dir, scope_hex)
        s = match[0]
        if first > last or first < s["origin"] or s["last"] is None or s["last"] < last:
            raise Fail("RANGE_INCOMPLETE", streams_dir, f"{scope_hex}:{first}:{last}")

    staging = os.path.join(root, "tmp")
    require_dir(staging, device)
    for name in names(staging):
        if not stat.S_ISREG(os.lstat(os.path.join(staging, name)).st_mode):
            raise Fail("UNEXPECTED_ENTRY", os.path.join(staging, name), "staging entry")

    payload = bytearray(cfg.id)
    for s in streams:
        payload += s["id"] + s["count"].to_bytes(8, "big") + s["tip"]
    return {
        "config_id": cfg.id.hex(), "chunks": len(chunks), "artifacts": len(artifacts),
        "logical_bytes": logical_total, "stored_bytes": stored,
        "orphan_chunks": len(set(chunks) - used_chunks),
        "orphan_artifacts": len(artifacts - referenced), "streams": len(streams),
        "abandoned_registrations": abandoned, "staging_files": len(names(staging)),
        "evidence_root": domain(b"NQC-CENSUS-STORE-EVIDENCE-ROOT-V1", bytes(payload)).hex(),
    }


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--require-range", action="append", default=[])
    parser.add_argument("--expect-root")
    try:
        args = parser.parse_args()
        ranges = []
        for item in args.require_range:
            scope_hex, first, last = item.split(":")
            if hex32(scope_hex) is None:
                raise ValueError(item)
            ranges.append((scope_hex, int(first), int(last)))
    except (SystemExit, ValueError) as error:
        print(f"PYTHON_INDEPENDENT_VERIFY=USAGE_ERROR {error}", file=sys.stderr)
        return 2
    try:
        report = verify(os.path.abspath(args.store), ranges)
        if args.expect_root and report["evidence_root"] != args.expect_root:
            raise Fail("TIP_MISMATCH", args.store, "evidence root differs from expected")
    except Fail as failure:
        print(f"PYTHON_INDEPENDENT_VERIFY=FAIL code={failure.code} path={failure.path} "
              f"reason={failure.reason}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"PYTHON_INDEPENDENT_VERIFY=FAIL code=IO reason={error}", file=sys.stderr)
        return 1
    print("PYTHON_INDEPENDENT_VERIFY=PASS")
    for key, value in report.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
