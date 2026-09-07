import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInventoryCreativePolicy, type InventoryCreativePolicy, InventoryIntelligenceError } from "./inventory-intelligence";

const MAX_BYTES = 1024 * 1024;
const ROOT_KEYS = new Set(["version", "compositeSourceId", "maxInventoryAgeMs", "allowedInventorySourceIds", "bindings"]);
const BINDING_KEYS = new Set(["sku", "attributeName", "type", "scopeKind", "scopeResourceName"]);

export function parseInventoryCreativePolicy(value: unknown): InventoryCreativePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory creative config must be a plain object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!ROOT_KEYS.has(key)) throw new InventoryIntelligenceError("INVALID_CONFIG", `inventory creative config contains unknown field ${key}`);
  for (const key of ROOT_KEYS) if (!(key in raw)) throw new InventoryIntelligenceError("INVALID_CONFIG", `inventory creative config.${key} is required`);
  if (!Array.isArray(raw.bindings)) throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory creative config.bindings must be an array");
  for (const [index, item] of raw.bindings.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}] must be a plain object`);
    for (const key of Object.keys(item as object)) if (!BINDING_KEYS.has(key)) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}] contains unknown field ${key}`);
    for (const key of BINDING_KEYS) if (!(key in (item as Record<string, unknown>))) throw new InventoryIntelligenceError("INVALID_CONFIG", `bindings[${index}].${key} is required`);
  }
  return createInventoryCreativePolicy(raw as unknown as InventoryCreativePolicy);
}

export function loadInventoryCreativePolicy(path: string): InventoryCreativePolicy {
  if (!isAbsolute(path)) throw new InventoryIntelligenceError("INVALID_CONFIG", "NEXUS_CORTEX_INVENTORY_CREATIVE_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new InventoryIntelligenceError("INVALID_CONFIG", `inventory creative config must be a regular file of 1..${MAX_BYTES} bytes`);
  try { return parseInventoryCreativePolicy(JSON.parse(readFileSync(path, "utf8")) as unknown); }
  catch (error) { if (error instanceof InventoryIntelligenceError) throw error; throw new InventoryIntelligenceError("INVALID_CONFIG", "inventory creative config contains malformed JSON"); }
}
