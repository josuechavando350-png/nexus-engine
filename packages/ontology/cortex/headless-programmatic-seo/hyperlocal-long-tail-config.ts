import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ProgrammaticSeoError } from "./index";
import { createHyperlocalLongTailPolicy, type HyperlocalLongTailPolicy } from "./hyperlocal-long-tail";

const MAX_BYTES = 64 * 1024;
const KEYS = new Set([
  "version",
  "maxHyperlocalCatalogAgeMs",
  "maxHyperlocalPages",
  "minimumHyperlocalDistinctiveStatements",
  "minimumGeoEvidenceRefs",
  "minimumDemandEvidenceRefs",
  "geoEvidencePrefix",
  "demandEvidencePrefix",
  "allowedHyperlocalSourceIds",
]);

export function parseHyperlocalLongTailPolicy(value: unknown): HyperlocalLongTailPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ProgrammaticSeoError("INVALID_INPUT", "hyperlocal long-tail config must be a plain object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new ProgrammaticSeoError("INVALID_INPUT", `hyperlocal long-tail config contains unknown field ${key}`);
  for (const key of KEYS) if (!(key in raw)) throw new ProgrammaticSeoError("INVALID_INPUT", `hyperlocal long-tail config.${key} is required`);
  return createHyperlocalLongTailPolicy(raw as unknown as HyperlocalLongTailPolicy);
}

export function loadHyperlocalLongTailPolicy(path: string): HyperlocalLongTailPolicy {
  if (!isAbsolute(path)) throw new ProgrammaticSeoError("INVALID_INPUT", "NEXUS_CORTEX_HYPERLOCAL_LONG_TAIL_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new ProgrammaticSeoError("INVALID_INPUT", `hyperlocal long-tail config must be a regular file of 1..${MAX_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new ProgrammaticSeoError("INVALID_INPUT", "hyperlocal long-tail config contains malformed JSON"); }
  return parseHyperlocalLongTailPolicy(parsed);
}
