import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ConversionPrivacyError, createConversionPrivacyPolicy, type ConversionPrivacyPolicy } from "./privacy-abstraction";

const MAX_BYTES = 64 * 1024;
const KEYS = new Set(["version", "maxDecisionAgeMs", "allowedPolicyIds"]);

export function parseConversionPrivacyPolicy(value: unknown): ConversionPrivacyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConversionPrivacyError("INVALID_CONFIG", "conversion privacy config must be a plain object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new ConversionPrivacyError("INVALID_CONFIG", `conversion privacy config contains unknown field ${key}`);
  for (const key of KEYS) if (!(key in raw)) throw new ConversionPrivacyError("INVALID_CONFIG", `conversion privacy config.${key} is required`);
  return createConversionPrivacyPolicy(raw as unknown as ConversionPrivacyPolicy);
}

export function loadConversionPrivacyPolicy(path: string): ConversionPrivacyPolicy {
  if (!isAbsolute(path)) throw new ConversionPrivacyError("INVALID_CONFIG", "NEXUS_CORTEX_30_PRIVACY_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) {
    throw new ConversionPrivacyError("INVALID_CONFIG", `conversion privacy config must be a regular file of 1..${MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new ConversionPrivacyError("INVALID_CONFIG", "conversion privacy config contains malformed JSON"); }
  return parseConversionPrivacyPolicy(parsed);
}
