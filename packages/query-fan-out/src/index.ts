import { createHash } from "node:crypto";

export type FanOutEvidenceClass = "INTERNAL_SIMULATION" | "OBSERVED_EXTERNAL" | "INFERRED";
export type FanOutNodeKind = "QUERY" | "SUBQUERY" | "INTENT" | "ENTITY" | "PERSPECTIVE" | "RELATED_QUESTION" | "INFORMATION_ROUTE";

export interface FanOutSeed { kind: Exclude<FanOutNodeKind, "QUERY">; text: string; parentText?: string; evidenceClass?: FanOutEvidenceClass; source?: string }
export interface FanOutRequest { tenantId: string; scope: string; query: string; seeds: readonly FanOutSeed[]; maxDepth: number; maxNodes: number }
export interface FanOutNode { id: string; kind: FanOutNodeKind; text: string; canonicalText: string; depth: number; evidenceClass: FanOutEvidenceClass; source: string }
export interface FanOutEdge { from: string; to: string }
export interface Contradiction { left: string; right: string; term: string }
export interface FanOutSimulation { version: "1"; tenantId: string; scope: string; nodes: readonly FanOutNode[]; edges: readonly FanOutEdge[]; contradictions: readonly Contradiction[]; truncated: boolean; requestDigest: string; digest: string }

const MAX_TEXT = 2_000;
const HARD_MAX_NODES = 512;
const HARD_MAX_DEPTH = 8;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function canonicalJson(value: unknown): string {
  const walk = (item: unknown, seen: WeakSet<object>): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("non-finite number"); return Object.is(item, -0) ? 0 : item; }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, seen));
    if (typeof item === "object") {
      if (seen.has(item)) throw new Error("cyclic input");
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("non-plain input");
      seen.add(item); const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) { if (RESERVED.has(key)) throw new Error("reserved key"); const entry = (item as Record<string, unknown>)[key]; if (entry === undefined) throw new Error("undefined input"); output[key] = walk(entry, seen); }
      seen.delete(item); return output;
    }
    throw new Error(`unsupported ${typeof item}`);
  };
  return JSON.stringify(walk(value, new WeakSet()));
}

export function stableDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function canonicalQuery(value: string): string {
  if (typeof value !== "string") throw new Error("text must be a string");
  const safe = [...value.normalize("NFKC")].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  const text = safe.replace(/\s+/gu, " ").trim();
  if (!text || text.length > MAX_TEXT) throw new Error(`text must contain 1-${MAX_TEXT} safe characters`);
  return text.toLocaleLowerCase("und").replace(/[?!.;,]+$/u, "");
}

function cleanIdentity(value: string, label: string): string {
  const result = canonicalQuery(value);
  if (result.length > 160 || /[<>\u2028\u2029]/u.test(result)) throw new Error(`${label} is unsafe`);
  return result;
}

function nodeId(kind: FanOutNodeKind, canonicalText: string): string { return `${kind.toLowerCase()}:${stableDigest(canonicalText).slice(0, 24)}`; }

export function simulateQueryFanOut(request: FanOutRequest): FanOutSimulation {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request must be an object");
  const tenantId = cleanIdentity(request.tenantId, "tenantId");
  const scope = cleanIdentity(request.scope, "scope");
  if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0 || request.maxDepth > HARD_MAX_DEPTH) throw new Error(`maxDepth must be 0-${HARD_MAX_DEPTH}`);
  if (!Number.isInteger(request.maxNodes) || request.maxNodes < 1 || request.maxNodes > HARD_MAX_NODES) throw new Error(`maxNodes must be 1-${HARD_MAX_NODES}`);
  if (!Array.isArray(request.seeds) || request.seeds.length > HARD_MAX_NODES * 4) throw new Error("seed budget exceeded");

  const query = canonicalQuery(request.query);
  const root: FanOutNode = { id: nodeId("QUERY", query), kind: "QUERY", text: request.query.trim(), canonicalText: query, depth: 0, evidenceClass: "INTERNAL_SIMULATION", source: "nexus-query-fan-out@1" };
  const normalized = request.seeds.map((seed) => {
    if (!seed || typeof seed !== "object" || Array.isArray(seed)) throw new Error("seed must be an object");
    if (!["SUBQUERY", "INTENT", "ENTITY", "PERSPECTIVE", "RELATED_QUESTION", "INFORMATION_ROUTE"].includes(seed.kind)) throw new Error("invalid seed kind");
    const canonicalText = canonicalQuery(seed.text);
    const parent = seed.parentText === undefined ? query : canonicalQuery(seed.parentText);
    const evidenceClass = seed.evidenceClass ?? "INTERNAL_SIMULATION";
    if (!["INTERNAL_SIMULATION", "OBSERVED_EXTERNAL", "INFERRED"].includes(evidenceClass)) throw new Error("invalid evidence class");
    if (evidenceClass === "OBSERVED_EXTERNAL" && !seed.source) throw new Error("observed external seed requires source");
    return { seed, canonicalText, parent, evidenceClass, source: seed.source ? canonicalQuery(seed.source) : "nexus-query-fan-out@1" };
  }).sort((a, b) => `${a.seed.kind}:${a.canonicalText}:${a.parent}`.localeCompare(`${b.seed.kind}:${b.canonicalText}:${b.parent}`));

  const candidates = new Map<string, typeof normalized[number]>();
  for (const item of normalized) candidates.set(`${item.seed.kind}:${item.canonicalText}`, item); // deterministic semantic deduplication
  const nodes = new Map<string, FanOutNode>([[query, root]]); const edges: FanOutEdge[] = [];
  let changed = true;
  while (changed && nodes.size < request.maxNodes) {
    changed = false;
    for (const item of candidates.values()) {
      if (nodes.has(item.canonicalText)) continue;
      const parent = nodes.get(item.parent); if (!parent || parent.depth >= request.maxDepth) continue;
      const node: FanOutNode = { id: nodeId(item.seed.kind, item.canonicalText), kind: item.seed.kind, text: item.seed.text.trim(), canonicalText: item.canonicalText, depth: parent.depth + 1, evidenceClass: item.evidenceClass, source: item.source };
      nodes.set(item.canonicalText, node); edges.push({ from: parent.id, to: node.id }); changed = true;
      if (nodes.size >= request.maxNodes) break;
    }
  }
  const outputNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const outputEdges = edges.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
  const positive = new Map<string, string>(); const negative = new Map<string, string>();
  for (const node of outputNodes) { const match = /^(?:not|no)\s+(.+)$/u.exec(node.canonicalText); if (match) negative.set(match[1]!, node.id); else positive.set(node.canonicalText, node.id); }
  const contradictions = [...negative].filter(([term]) => positive.has(term)).map(([term, right]) => ({ left: positive.get(term)!, right, term })).sort((a, b) => a.term.localeCompare(b.term));
  const requestDigest = stableDigest({ tenantId, scope, query, seeds: normalized.map(({ seed, canonicalText, parent, evidenceClass, source }) => ({ kind: seed.kind, canonicalText, parent, evidenceClass, source })), maxDepth: request.maxDepth, maxNodes: request.maxNodes });
  const core = { version: "1" as const, tenantId, scope, nodes: outputNodes, edges: outputEdges, contradictions, truncated: nodes.size < candidates.size + 1, requestDigest };
  return Object.freeze({ ...core, digest: stableDigest(core) });
}

export function validateFanOut(request: FanOutRequest, result: FanOutSimulation): void {
  const replay = simulateQueryFanOut(request);
  if (stableDigest(result) !== stableDigest(replay)) throw new Error("fan-out replay or digest mismatch");
}
