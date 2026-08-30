import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const MAX_STATE_VALUES = 5_000;
const MAX_SYMBOLS = 5_000;
const MAX_BINDINGS = 20_000;
const MAX_CAPTURED_STATE_IDS = 1_000;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 64;
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_STRING = 100_000;
const MAX_ID = 200;
const MAX_MODULE = 2_048;
const MAX_EXPORT = 256;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const SAFE_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/u;

export const STATE_AUTHORITY = "NEXUS_RESUMABLE_STATE_V1" as const;
export const MANIFEST_AUTHORITY = "NEXUS_RESUMABILITY_MANIFEST_V1" as const;
export const NON_CLAIM = "NEXUS_RESUMABILITY_EXPLICIT_HANDLER_RUNTIME_NOT_QWIK_OPTIMIZER_OR_MODULE_INTEGRITY_PROOF" as const;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const EVENT_NAMES = [
  "click",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "focusin",
  "focusout",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface StateEnvelope {
  authority: typeof STATE_AUTHORITY;
  values: Readonly<Record<string, Json>>;
  digest: string;
}

export interface SymbolDefInput {
  id: string;
  module: string;
  exportName: string;
}

export interface SymbolDef extends SymbolDefInput {}

export interface BindingInput {
  id: string;
  event: EventName;
  symbolId: string;
  stateIds?: readonly string[];
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

export interface Binding {
  id: string;
  event: EventName;
  symbolId: string;
  stateIds: readonly string[];
  preventDefault: boolean;
  stopPropagation: boolean;
}

export interface Manifest {
  authority: typeof MANIFEST_AUTHORITY;
  buildDigest: string;
  symbols: readonly SymbolDef[];
  bindings: readonly Binding[];
  events: readonly EventName[];
  nonClaim: typeof NON_CLAIM;
  digest: string;
}

export interface HandlerContext {
  event: Event;
  host: Element;
  state: {
    get<T extends Json>(id: string): T;
    set(id: string, value: Json): void;
  };
}

export type Handler = (context: HandlerContext) => void | Promise<void>;
export type Importer = (url: string) => Promise<Record<string, unknown>>;

export interface ResumeOptions {
  document?: Document;
  importer?: Importer;
  onError?: (error: unknown, context: { bindingId: string; symbolId: string; event: EventName }) => void;
}

export interface ResumeController {
  readonly loaded: ReadonlySet<string>;
  dispose(): void;
}

type JsonRecord = Record<string, unknown>;

interface JsonBudget {
  nodes: number;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  return value as JsonRecord;
}

function assertAllowedKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (RESERVED_KEYS.has(key)) throw new Error(`${label} contains reserved key ${key}`);
    if (!allowedSet.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function cleanString(label: string, value: unknown, max = MAX_STRING): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function cleanId(label: string, value: unknown): string {
  const id = cleanString(label, value, MAX_ID);
  if (!SAFE_ID.test(id)) throw new Error(`${label} contains unsafe characters`);
  return id;
}

function eventName(value: unknown): EventName {
  if (typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value)) return value as EventName;
  throw new Error("unsupported resumable event");
}

function requiredBoolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function normalizeJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0 }, seen = new WeakSet<object>()): Json {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) throw new Error(`JSON state exceeds ${MAX_JSON_NODES} nodes`);
  if (depth > MAX_JSON_DEPTH) throw new Error(`JSON state exceeds depth ${MAX_JSON_DEPTH}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING) throw new Error(`JSON string exceeds ${MAX_STRING} characters`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON state contains non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("JSON state contains cycle");
    seen.add(value);
    const output = value.map((item) => normalizeJson(item, depth + 1, budget, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const record = asRecord(value, "JSON state object");
    if (seen.has(value)) throw new Error("JSON state contains cycle");
    seen.add(value);
    const output: Record<string, Json> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      if (RESERVED_KEYS.has(key)) throw new Error(`JSON state contains reserved key ${key}`);
      if (!key || key.length > MAX_ID) throw new Error("JSON state object key invalid");
      const item = record[key];
      if (item === undefined) throw new Error(`JSON state contains undefined at ${key}`);
      output[key] = normalizeJson(item, depth + 1, budget, seen);
    }
    seen.delete(value);
    return output;
  }
  throw new Error(`JSON state contains non-serializable ${typeof value}`);
}

function canonicalize(value: unknown, seen = new WeakSet<object>(), path = "$" ): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const output = value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const record = asRecord(value, path);
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const output: JsonRecord = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      if (RESERVED_KEYS.has(key)) throw new Error(`reserved key ${key} at ${path}`);
      const item = record[key];
      if (item === undefined) throw new Error(`undefined at ${path}.${key}`);
      output[key] = canonicalize(item, seen, `${path}.${key}`);
    }
    seen.delete(value);
    return output;
  }
  throw new Error(`unsupported canonical value ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertPayloadBytes(label: string, value: unknown): void {
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`${label} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
}

export function createState(values: Readonly<Record<string, Json>> | unknown): StateEnvelope {
  const record = asRecord(values, "state values");
  if (Object.keys(record).length > MAX_STATE_VALUES) throw new Error(`state exceeds ${MAX_STATE_VALUES} values`);
  const output: Record<string, Json> = Object.create(null);
  for (const key of Object.keys(record).sort()) {
    const id = cleanId("state id", key);
    const value = record[key];
    if (value === undefined) throw new Error(`state ${id} is undefined`);
    output[id] = normalizeJson(value);
  }
  const core = { authority: STATE_AUTHORITY, values: output };
  assertPayloadBytes("state", core);
  return { ...core, digest: digest(core) };
}

export function validateState(state: StateEnvelope): void {
  const record = asRecord(state, "state");
  assertAllowedKeys(record, ["authority", "values", "digest"], "state");
  if (record.authority !== STATE_AUTHORITY) throw new Error("state authority mismatch");
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) throw new Error("state digest invalid");
  const expected = createState(record.values);
  if (canonicalJson(expected) !== canonicalJson(state)) throw new Error("state replay mismatch");
}

function normalizeModule(value: unknown): string {
  const module = cleanString("symbol.module", value, MAX_MODULE);
  if (!module.startsWith("/") || module.startsWith("//") || module.includes("\\")) {
    throw new Error("symbol.module must be a root-relative module path");
  }
  const parsed = new URL(module, "https://nexus.invalid/");
  if (parsed.origin !== "https://nexus.invalid") throw new Error("symbol.module must remain same-origin");
  if (parsed.username || parsed.password || parsed.hash) throw new Error("symbol.module contains unsupported URL components");
  if (!/\.(?:m?js)$/u.test(parsed.pathname)) throw new Error("symbol.module must reference .js or .mjs");
  return `${parsed.pathname}${parsed.search}`;
}

function normalizeSymbol(value: unknown): SymbolDef {
  const record = asRecord(value, "symbol");
  assertAllowedKeys(record, ["id", "module", "exportName"], "symbol");
  const exportName = cleanString("symbol.exportName", record.exportName, MAX_EXPORT);
  if (!SAFE_EXPORT.test(exportName)) throw new Error("symbol.exportName invalid");
  return {
    id: cleanId("symbol.id", record.id),
    module: normalizeModule(record.module),
    exportName,
  };
}

function normalizeBinding(value: unknown, symbolIds: ReadonlySet<string>): Binding {
  const record = asRecord(value, "binding");
  assertAllowedKeys(record, ["id", "event", "symbolId", "stateIds", "preventDefault", "stopPropagation"], "binding");
  const symbolId = cleanId("binding.symbolId", record.symbolId);
  if (!symbolIds.has(symbolId)) throw new Error(`binding references unknown symbol ${symbolId}`);
  const event = eventName(record.event);
  const stateValues = record.stateIds === undefined ? [] : record.stateIds;
  if (!Array.isArray(stateValues) || stateValues.length > MAX_CAPTURED_STATE_IDS) throw new Error("binding.stateIds invalid");
  const stateIds = stateValues.map((id) => cleanId("binding.stateId", id)).sort((left, right) => left.localeCompare(right));
  if (new Set(stateIds).size !== stateIds.length) throw new Error("binding.stateIds contains duplicates");
  const preventDefault = record.preventDefault === undefined ? false : requiredBoolean("binding.preventDefault", record.preventDefault);
  const stopPropagation = record.stopPropagation === undefined ? false : requiredBoolean("binding.stopPropagation", record.stopPropagation);
  if (event === "submit" && preventDefault !== true) throw new Error("submit binding requires preventDefault=true before lazy import");
  return {
    id: cleanId("binding.id", record.id),
    event,
    symbolId,
    stateIds,
    preventDefault,
    stopPropagation,
  };
}

export function createManifest(buildDigest: string, symbols: readonly SymbolDefInput[], bindings: readonly BindingInput[]): Manifest {
  if (!/^[a-f0-9]{64}$/u.test(buildDigest)) throw new Error("buildDigest must be sha256 hex");
  if (!Array.isArray(symbols) || symbols.length > MAX_SYMBOLS) throw new Error(`manifest symbols exceed ${MAX_SYMBOLS}`);
  if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS) throw new Error(`manifest bindings exceed ${MAX_BINDINGS}`);
  const normalizedSymbols = symbols.map(normalizeSymbol).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalizedSymbols.map((symbol) => symbol.id)).size !== normalizedSymbols.length) throw new Error("duplicate symbol id");
  const symbolIds = new Set(normalizedSymbols.map((symbol) => symbol.id));
  const normalizedBindings = bindings.map((binding) => normalizeBinding(binding, symbolIds)).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalizedBindings.map((binding) => binding.id)).size !== normalizedBindings.length) throw new Error("duplicate binding id");
  const events = [...new Set(normalizedBindings.map((binding) => binding.event))].sort((left, right) => left.localeCompare(right)) as EventName[];
  const core = {
    authority: MANIFEST_AUTHORITY,
    buildDigest,
    symbols: normalizedSymbols,
    bindings: normalizedBindings,
    events,
    nonClaim: NON_CLAIM,
  };
  assertPayloadBytes("manifest", core);
  return { ...core, digest: digest(core) };
}

export function validateManifest(manifest: Manifest): void {
  const record = asRecord(manifest, "manifest");
  assertAllowedKeys(record, ["authority", "buildDigest", "symbols", "bindings", "events", "nonClaim", "digest"], "manifest");
  if (record.authority !== MANIFEST_AUTHORITY) throw new Error("manifest authority mismatch");
  if (record.nonClaim !== NON_CLAIM) throw new Error("manifest non-claim marker mismatch");
  if (typeof record.buildDigest !== "string") throw new Error("manifest buildDigest invalid");
  if (!Array.isArray(record.symbols) || !Array.isArray(record.bindings) || !Array.isArray(record.events)) throw new Error("manifest arrays invalid");
  const expected = createManifest(record.buildDigest, record.symbols as unknown as SymbolDefInput[], record.bindings as unknown as BindingInput[]);
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) throw new Error("manifest digest invalid");
  if (canonicalJson(expected) !== canonicalJson(manifest)) throw new Error("manifest replay mismatch");
}

function bindManifestToState(manifest: Manifest, state: StateEnvelope): void {
  const stateIds = new Set(Object.keys(state.values));
  for (const binding of manifest.bindings) {
    for (const id of binding.stateIds) {
      if (!stateIds.has(id)) throw new Error(`binding ${binding.id} captures unknown state ${id}`);
    }
  }
}

function escapeScriptJson(value: unknown): string {
  return canonicalJson(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function renderPayload(manifest: Manifest, state: StateEnvelope): string {
  validateManifest(manifest);
  validateState(state);
  bindManifestToState(manifest, state);
  return `<script type="application/json" id="nexus-resume-manifest">${escapeScriptJson(manifest)}</script><script type="application/json" id="nexus-resume-state">${escapeScriptJson(state)}</script>`;
}

function parsePayloadElement<T>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`missing resumability payload ${id}`);
  const text = element.textContent;
  if (text === null || Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`invalid resumability payload ${id}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${id}`, { cause: error });
  }
  return parsed as T;
}

function sameOriginModuleUrl(module: string, baseURI: string): string {
  const url = new URL(module, baseURI);
  const base = new URL(baseURI);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== base.origin) {
    throw new Error("resumable module resolved outside document origin");
  }
  if (url.username || url.password || url.hash) throw new Error("resumable module URL invalid");
  return url.href;
}

function getDocument(options: ResumeOptions): Document {
  if (options.document) return options.document;
  if (typeof document === "undefined") throw new Error("resumeDocument requires a Document");
  return document;
}

export function resumeDocument(options: ResumeOptions = {}): ResumeController {
  const doc = getDocument(options);
  const importer = options.importer ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>);
  const manifest = parsePayloadElement<Manifest>(doc, "nexus-resume-manifest");
  const state = parsePayloadElement<StateEnvelope>(doc, "nexus-resume-state");
  validateManifest(manifest);
  validateState(state);
  bindManifestToState(manifest, state);

  const values = new Map<string, Json>(Object.entries(state.values));
  const byBinding = new Map(manifest.bindings.map((binding) => [binding.id, binding] as const));
  const bySymbol = new Map(manifest.symbols.map((symbol) => [symbol.id, symbol] as const));
  const loaded = new Set<string>();
  const cache = new Map<string, Promise<Handler>>();
  const listeners = new Map<EventName, EventListener>();

  const escape = (id: string): string => {
    const css = doc.defaultView?.CSS ?? (typeof CSS === "undefined" ? undefined : CSS);
    if (!css || typeof css.escape !== "function") throw new Error("CSS.escape is required for resumable state projection");
    return css.escape(id);
  };

  const apply = (id: string, value: Json): void => {
    const selectorId = escape(id);
    doc.querySelectorAll(`[data-nx-text="${selectorId}"]`).forEach((element) => {
      element.textContent = String(value ?? "");
    });
    doc.querySelectorAll(`[data-nx-hidden="${selectorId}"]`).forEach((element) => {
      if (element instanceof HTMLElement) element.hidden = Boolean(value);
    });
  };

  const loadHandler = (symbolId: string): Promise<Handler> => {
    const existing = cache.get(symbolId);
    if (existing) return existing;
    const symbol = bySymbol.get(symbolId);
    if (!symbol) throw new Error(`unknown resumable symbol ${symbolId}`);
    const url = sameOriginModuleUrl(symbol.module, doc.baseURI);
    const pending = importer(url).then((module) => {
      const handler = module[symbol.exportName];
      if (typeof handler !== "function") throw new Error(`handler export ${symbol.exportName} missing`);
      loaded.add(symbol.id);
      return handler as Handler;
    }).catch((error) => {
      cache.delete(symbolId);
      throw error;
    });
    cache.set(symbolId, pending);
    return pending;
  };

  for (const event of manifest.events) {
    const attribute = `data-nx-on-${event}`;
    const listener: EventListener = (nativeEvent) => {
      const host = nativeEvent.composedPath().find((node) => node instanceof Element && node.hasAttribute(attribute));
      if (!(host instanceof Element)) return;
      const bindingId = host.getAttribute(attribute);
      if (!bindingId) return;
      const binding = byBinding.get(bindingId);
      if (!binding || binding.event !== event) return;

      if (binding.preventDefault) nativeEvent.preventDefault();
      if (binding.stopPropagation) nativeEvent.stopPropagation();

      void loadHandler(binding.symbolId)
        .then((handler) => handler({
          event: nativeEvent,
          host,
          state: {
            get: <T extends Json>(id: string): T => {
              if (!binding.stateIds.includes(id)) throw new Error(`state ${id} not captured by ${binding.id}`);
              if (!values.has(id)) throw new Error(`captured state ${id} is unavailable`);
              return values.get(id) as T;
            },
            set: (id: string, value: Json): void => {
              if (!binding.stateIds.includes(id)) throw new Error(`state ${id} not captured by ${binding.id}`);
              const normalized = normalizeJson(value);
              values.set(id, normalized);
              apply(id, normalized);
            },
          },
        }))
        .catch((error) => {
          options.onError?.(error, { bindingId: binding.id, symbolId: binding.symbolId, event });
        });
    };
    doc.addEventListener(event, listener, true);
    listeners.set(event, listener);
  }

  return {
    loaded,
    dispose(): void {
      for (const [event, listener] of listeners) doc.removeEventListener(event, listener, true);
      listeners.clear();
      cache.clear();
    },
  };
}
