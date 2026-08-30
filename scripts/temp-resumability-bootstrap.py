from pathlib import Path

source_path = Path("packages/resumability/src/index.ts")
text = source_path.read_text()
text = text.replace('import { Buffer } from "node:buffer";\nimport { createHash } from "node:crypto";\n\n', "")
text = text.replace("export interface SymbolDef extends SymbolDefInput {}", "export type SymbolDef = SymbolDefInput;")
marker = 'export const STATE_AUTHORITY = "NEXUS_RESUMABLE_STATE_V1" as const;\n'
sha = '''function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256Hex(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const initial = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const input = utf8Bytes(value);
  const bitLength = BigInt(input.byteLength) * 8n;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);
  const hash = [...initial];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

'''
if marker not in text:
    raise SystemExit("authority marker missing")
text = text.replace(marker, sha + marker, 1)
old_digest = 'return createHash("sha256").update(canonicalJson(value)).digest("hex");'
if old_digest not in text:
    raise SystemExit("node digest implementation missing")
text = text.replace(old_digest, 'return sha256Hex(canonicalJson(value));', 1)
text = text.replace('Buffer.byteLength(canonicalJson(value), "utf8")', 'utf8ByteLength(canonicalJson(value))')
text = text.replace('Buffer.byteLength(text, "utf8")', 'utf8ByteLength(text)')
source_path.write_text(text)

test_path = Path("packages/resumability/src/index.test.ts")
test = test_path.read_text()
if 'from "node:crypto"' not in test:
    test = 'import { createHash } from "node:crypto";\n' + test
if "  digest," not in test:
    test = test.replace("  createManifest,\n  createState,", "  createManifest,\n  createState,\n  digest,")
needle = '    expect(createState({ b: 2, a: 1 }).digest).toBe(createState({ a: 1, b: 2 }).digest);'
if needle not in test:
    raise SystemExit("determinism assertion missing")
parity = '    expect(digest({ a: 1 })).toBe(createHash("sha256").update("{\\"a\\":1}").digest("hex"));'
if parity not in test:
    test = test.replace(needle, needle + "\n" + parity, 1)
test_path.write_text(test)
