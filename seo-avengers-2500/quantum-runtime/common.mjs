import { canonicalOptimizationValueSha256 } from "../optimization-problem/problem-builder.mjs";

export const QUANTUM_CONTRACT_SCHEMA_VERSION = 1;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be object`);
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`unexpected ${label} keys`);
}

export function text(value, label, { pattern = null, maxBytes = 4_096 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} invalid length`);
  if (pattern && !pattern.test(normalized)) throw new Error(`${label} invalid format`);
  return normalized;
}

export function nullableText(value, label, options = {}) { return value === null ? null : text(value, label, options); }

export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be integer in range`);
  return value;
}

export function nullableInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return value === null ? null : integer(value, label, min, max);
}

export function bool(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function sha(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

export function nullableSha(value, label) { return value === null ? null : sha(value, label); }

export function timestamp(value, label) {
  const normalized = text(value, label, { maxBytes: 64 });
  if (!ISO_UTC_RE.test(normalized) || Number.isNaN(Date.parse(normalized))) throw new Error(`${label} must be UTC ISO-8601 timestamp`);
  return normalized;
}

export function nullableTimestamp(value, label) { return value === null ? null : timestamp(value, label); }

export function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function canonicalQuantumSha256(value) { return canonicalOptimizationValueSha256(value); }
