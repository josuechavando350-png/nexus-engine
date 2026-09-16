import { createHash } from "node:crypto";

export const GAUSS_SCHEMA_VERSION = 1;
export const GAUSS_ENGINE_ID = "NEXUS_GAUSS_SCIENTIFIC_KERNEL_V1";
export const GAUSS_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const GAUSS_SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const normalized = Object.entries(value).map(([key, child]) => [key.normalize("NFC"), child]);
    normalized.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const seen = new Set();
    return `{${normalized.map(([key, child]) => {
      if (seen.has(key)) throw new TypeError("canonical JSON normalized key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    }).join(",")}}`;
  }
  throw new TypeError("value is not JSON-compatible");
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new TypeError(`${label} keys mismatch`);
}

export function assertFiniteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} must be a finite number in range`);
  }
  return value;
}

export function assertSafeInteger(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} must be a safe integer in range`);
  return value;
}

export function assertToken(value, label) {
  if (typeof value !== "string" || !GAUSS_TOKEN_RE.test(value)) throw new TypeError(`${label} must be a valid token`);
  return value;
}

export function assertArray(value, label, { min = 0, max = 100_000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${label} must be an array with bounded length`);
  return value;
}

export function normalizeNumberArray(value, label, { minLength = 1, maxLength = 100_000 } = {}) {
  return assertArray(value, label, { min: minLength, max: maxLength }).map((item, index) => assertFiniteNumber(item, `${label}[${index}]`));
}

export function nearlyEqual(left, right, tolerance = 1e-10) {
  return Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

export function seededXorShift32(seedInput) {
  let state = assertSafeInteger(seedInput, "seed", { min: 1, max: 0xffffffff }) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
