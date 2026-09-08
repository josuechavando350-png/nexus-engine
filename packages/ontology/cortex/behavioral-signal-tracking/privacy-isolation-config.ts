import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BehavioralSignalError } from "./index";
import {
  createPrivacyIsolationPolicy,
  type CreatePrivacyIsolationPolicyInput,
  type PrivacyIsolationKeyRingConfig,
  type PrivacyIsolationPolicy,
} from "./privacy-isolation";

const MAX_BYTES = 64 * 1024;
const POLICY_KEYS = new Set(["version", "sessionTtlMs", "aggregateRetentionMs", "retentionSweepIntervalMs", "maxTrackedSessionsPerSite", "maxActiveKeyAgeMs", "allowedSiteIds"]);
const KEYRING_KEYS = new Set(["version", "bootstrapActiveKeyId", "keys"]);
const KEY_KEYS = new Set(["keyId", "key"]);

function plain(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new BehavioralSignalError("INVALID_INPUT", `${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function exact(raw: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new BehavioralSignalError("INVALID_INPUT", `${field} contains unknown field ${key}`);
  for (const key of allowed) if (!(key in raw)) throw new BehavioralSignalError("INVALID_INPUT", `${field}.${key} is required`);
}

function loadJson(path: string, envName: string, label: string): unknown {
  if (!isAbsolute(path)) throw new BehavioralSignalError("INVALID_INPUT", `${envName} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new BehavioralSignalError("INVALID_INPUT", `${label} must be a regular file of 1..${MAX_BYTES} bytes`);
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new BehavioralSignalError("INVALID_INPUT", `${label} contains malformed JSON`); }
}

export function parsePrivacyIsolationPolicy(value: unknown): PrivacyIsolationPolicy {
  const raw = plain(value, "privacy isolation config");
  exact(raw, POLICY_KEYS, "privacy isolation config");
  return createPrivacyIsolationPolicy(raw as unknown as CreatePrivacyIsolationPolicyInput);
}

export function loadPrivacyIsolationPolicy(path: string): PrivacyIsolationPolicy {
  return parsePrivacyIsolationPolicy(loadJson(path, "NEXUS_CORTEX_BEHAVIORAL_PRIVACY_ISOLATION_CONFIG", "privacy isolation config"));
}

export function parsePrivacyIsolationKeyRing(value: unknown): PrivacyIsolationKeyRingConfig {
  const raw = plain(value, "privacy keyring");
  exact(raw, KEYRING_KEYS, "privacy keyring");
  if (raw.version !== 1 || typeof raw.bootstrapActiveKeyId !== "string" || !Array.isArray(raw.keys)) throw new BehavioralSignalError("INVALID_INPUT", "privacy keyring fields are invalid");
  const keys = raw.keys.map((item, index) => {
    const entry = plain(item, `privacy keyring.keys[${index}]`);
    exact(entry, KEY_KEYS, `privacy keyring.keys[${index}]`);
    if (typeof entry.keyId !== "string" || typeof entry.key !== "string") throw new BehavioralSignalError("INVALID_INPUT", `privacy keyring.keys[${index}] fields are invalid`);
    return Object.freeze({ keyId: entry.keyId, key: entry.key });
  });
  return Object.freeze({ version: 1, bootstrapActiveKeyId: raw.bootstrapActiveKeyId, keys: Object.freeze(keys) });
}

export function loadPrivacyIsolationKeyRing(path: string): PrivacyIsolationKeyRingConfig {
  return parsePrivacyIsolationKeyRing(loadJson(path, "NEXUS_CORTEX_BEHAVIORAL_PRIVACY_KEYRING", "privacy keyring"));
}
