import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BiddingSupervisorError } from "./index";
import { createRevenueGuardrailPolicy, type RevenueGuardrailPolicy } from "./revenue-guardrails";

const MAX_BYTES = 64 * 1024;
const KEYS = new Set(["version", "maxSnapshotAgeMs", "minimumRevenueMicros", "minimumProfitAfterAdSpendMicros", "minimumQualifiedConversions", "minimumRevenueToSpendRatio", "allowedSourceIds"]);

export function parseRevenueGuardrailPolicy(value: unknown): RevenueGuardrailPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new BiddingSupervisorError("INVALID_INPUT", "revenue guardrail config must be a plain object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new BiddingSupervisorError("INVALID_INPUT", `revenue guardrail config contains unknown field ${key}`);
  for (const key of KEYS) if (!(key in raw)) throw new BiddingSupervisorError("INVALID_INPUT", `revenue guardrail config.${key} is required`);
  return createRevenueGuardrailPolicy(raw as unknown as RevenueGuardrailPolicy);
}

export function loadRevenueGuardrailPolicy(path: string): RevenueGuardrailPolicy {
  if (!isAbsolute(path)) throw new BiddingSupervisorError("INVALID_INPUT", "NEXUS_CORTEX_REVENUE_GUARD_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new BiddingSupervisorError("INVALID_INPUT", `revenue guardrail config must be a regular file of 1..${MAX_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new BiddingSupervisorError("INVALID_INPUT", "revenue guardrail config contains malformed JSON"); }
  return parseRevenueGuardrailPolicy(parsed);
}
