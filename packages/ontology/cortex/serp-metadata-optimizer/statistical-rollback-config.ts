import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SerpMetadataOptimizerError } from "./index";
import { createStatisticalRollbackPolicy, type StatisticalRollbackPolicy } from "./statistical-rollback";

const MAX_BYTES = 64 * 1024;
const KEYS = new Set([
  "version",
  "evaluationWindowDays",
  "reportingLagDays",
  "minimumTargetImpressionsPerWindow",
  "minimumPeerImpressionsPerWindow",
  "minimumPeerPages",
  "minimumAbsoluteCtrDrop",
  "minimumRelativeCtrDrop",
  "minimumZScore",
  "maximumAveragePositionDelta",
  "maxRows",
]);

export function parseStatisticalRollbackPolicy(value: unknown): StatisticalRollbackPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SerpMetadataOptimizerError("INVALID_INPUT", "statistical rollback config must be a plain object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `statistical rollback config contains unknown field ${key}`);
  for (const key of KEYS) if (!(key in raw)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `statistical rollback config.${key} is required`);
  return createStatisticalRollbackPolicy(raw as unknown as StatisticalRollbackPolicy);
}

export function loadStatisticalRollbackPolicy(path: string): StatisticalRollbackPolicy {
  if (!isAbsolute(path)) throw new SerpMetadataOptimizerError("INVALID_INPUT", "NEXUS_CORTEX_SERP_STATISTICAL_ROLLBACK_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new SerpMetadataOptimizerError("INVALID_INPUT", `statistical rollback config must be a regular file of 1..${MAX_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new SerpMetadataOptimizerError("INVALID_INPUT", "statistical rollback config contains malformed JSON"); }
  return parseStatisticalRollbackPolicy(parsed);
}
