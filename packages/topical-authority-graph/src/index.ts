import { createHash } from "node:crypto";

const MAX_NODES = 5_000;
const MAX_EDGES = 25_000;
const MAX_ID = 160;
const MAX_LABEL = 1_000;
const MAX_URL = 4_096;
const MAX_ANCHOR = 500;
const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 64;
const MAX_ITERATIONS = 128;
const STRONG_RELATION = 0.6;
const MIN_INTERNAL_AUTHORITY = 0.6;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const NON_CLAIM = "INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE" as const;

export type NodeType = "PAGE" | "TOPIC" | "INTENT" | "ENTITY" | "EVIDENCE";
export type EdgeType =
  | "INTERNAL_LINK"
  | "COVERS_TOPIC"
  | "SERVES_INTENT"
  | "MENTIONS_ENTITY"
  | "CITES_EVIDENCE"
  | "TOPIC_PARENT"
  | "INTENT_TOPIC";

export interface AuthorityNodeInput {
  id: string;
  type: NodeType;
  label: string;
  url?: string;
  indexable?: boolean;
  crawlable?: boolean;
  primary?: boolean;
}

export interface AuthorityEdgeInput {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;
  anchor?: string;
}

export interface AuthorityGraphInput {
  nodes: readonly AuthorityNodeInput[];
  edges: readonly AuthorityEdgeInput[];
}

export type AuthorityNode = AuthorityNodeInput;
export type AuthorityEdge = AuthorityEdgeInput;

export interface AuthorityGraph {
  nodes: readonly AuthorityNode[];
  edges: readonly AuthorityEdge[];
  digest: string;
}

export interface PageRankOptions {
  damping?: number;
  iterations?: number;
}

export interface TopicScore {
  topicId: string;
  coverage: number;
  intentCoverage: number;
  primaryEvidence: number;
  cohesion: number;
  centrality: number;
  authority: number;
}

export interface WeakAnchorDiagnostic {
  from: string;
  to: string;
  anchor: string;
}

export interface CannibalizationCandidate {
  intentId: string;
  pageIds: readonly string[];
}

export interface GraphDiagnostics {
  orphans: readonly string[];
  weakAnchors: readonly WeakAnchorDiagnostic[];
  blocked: readonly string[];
  cannibalization: readonly CannibalizationCandidate[];
  nonClaim: typeof NON_CLAIM;
  diagnosticsDigest: string;
}

export type AuthorityStatus = "READY" | "NEEDS_WORK" | "BLOCKED";

export interface AuthorityAssessment {
  status: AuthorityStatus;
  graphDigest: string;
  score: number;
  topics: readonly TopicScore[];
  diagnostics: GraphDiagnostics;
  nonClaim: typeof NON_CLAIM;
  assessmentDigest: string;
}

type JsonRecord = Record<string, unknown>;

const EDGE_ENDPOINTS: Readonly<Record<EdgeType, readonly [NodeType, NodeType]>> = {
  INTERNAL_LINK: ["PAGE", "PAGE"],
  COVERS_TOPIC: ["PAGE", "TOPIC"],
  SERVES_INTENT: ["PAGE", "INTENT"],
  MENTIONS_ENTITY: ["PAGE", "ENTITY"],
  CITES_EVIDENCE: ["PAGE", "EVIDENCE"],
  TOPIC_PARENT: ["TOPIC", "TOPIC"],
  INTENT_TOPIC: ["INTENT", "TOPIC"],
};

const GENERIC_ANCHORS = new Set([
  "click",
  "click here",
  "here",
  "more",
  "read more",
  "learn more",
  "ver más",
  "aquí",
]);

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

function canonicalize(value: unknown, seen = new WeakSet<object>(), path = "$" ): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const result = value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`));
    seen.delete(value);
    return result;
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

function cleanString(label: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function cleanId(label: string, value: unknown): string {
  return cleanString(label, value, MAX_ID);
}

function safeHttpUrl(label: string, value: unknown): string {
  const raw = cleanString(label, value, MAX_URL);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label} must use HTTP(S)`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  parsed.hash = "";
  return parsed.toString();
}

function requiredBoolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function nodeType(value: unknown): NodeType {
  if (value === "PAGE" || value === "TOPIC" || value === "INTENT" || value === "ENTITY" || value === "EVIDENCE") return value;
  throw new Error("invalid node type");
}

function edgeType(value: unknown): EdgeType {
  if (
    value === "INTERNAL_LINK"
    || value === "COVERS_TOPIC"
    || value === "SERVES_INTENT"
    || value === "MENTIONS_ENTITY"
    || value === "CITES_EVIDENCE"
    || value === "TOPIC_PARENT"
    || value === "INTENT_TOPIC"
  ) return value;
  throw new Error("invalid edge type");
}

function normalizeNode(value: unknown): AuthorityNode {
  const record = asRecord(value, "node");
  assertAllowedKeys(record, ["id", "type", "label", "url", "indexable", "crawlable", "primary"], "node");
  const id = cleanId("node.id", record.id);
  const type = nodeType(record.type);
  const label = cleanString("node.label", record.label, MAX_LABEL);

  if (type === "PAGE") {
    return {
      id,
      type,
      label,
      url: safeHttpUrl("page.url", record.url),
      indexable: requiredBoolean("page.indexable", record.indexable),
      crawlable: requiredBoolean("page.crawlable", record.crawlable),
    };
  }

  if (type === "EVIDENCE") {
    const output: AuthorityNode = {
      id,
      type,
      label,
      primary: record.primary === undefined ? false : requiredBoolean("evidence.primary", record.primary),
    };
    if (record.url !== undefined) output.url = safeHttpUrl("evidence.url", record.url);
    if (record.indexable !== undefined || record.crawlable !== undefined) throw new Error("evidence cannot carry page crawl/index fields");
    return output;
  }

  if (record.url !== undefined || record.indexable !== undefined || record.crawlable !== undefined || record.primary !== undefined) {
    throw new Error(`${type} node contains fields reserved for PAGE/EVIDENCE`);
  }
  return { id, type, label };
}

function normalizeEdge(value: unknown): AuthorityEdge {
  const record = asRecord(value, "edge");
  assertAllowedKeys(record, ["from", "to", "type", "weight", "anchor"], "edge");
  const from = cleanId("edge.from", record.from);
  const to = cleanId("edge.to", record.to);
  const type = edgeType(record.type);
  if (from === to) throw new Error("self edges are not allowed");
  if (typeof record.weight !== "number" || !Number.isFinite(record.weight) || record.weight <= 0 || record.weight > 1) {
    throw new Error("edge.weight must be finite and in (0, 1]");
  }
  const output: AuthorityEdge = { from, to, type, weight: record.weight };
  if (record.anchor !== undefined) {
    if (type !== "INTERNAL_LINK") throw new Error("anchor is only valid on INTERNAL_LINK");
    output.anchor = cleanString("edge.anchor", record.anchor, MAX_ANCHOR);
  }
  return output;
}

function edgeIdentity(edge: AuthorityEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
}

function assertTopicAcyclic(nodes: readonly AuthorityNode[], edges: readonly AuthorityEdge[]): void {
  const topicIds = new Set(nodes.filter((node) => node.type === "TOPIC").map((node) => node.id));
  const parents = new Map<string, string[]>();
  for (const id of topicIds) parents.set(id, []);
  for (const edge of edges) {
    if (edge.type === "TOPIC_PARENT") parents.get(edge.from)!.push(edge.to);
  }
  for (const values of parents.values()) values.sort();

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("TOPIC_PARENT cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of parents.get(id) ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...topicIds].sort()) visit(id);
}

function normalizeGraph(input: unknown): AuthorityGraph {
  const record = asRecord(input, "graph");
  assertAllowedKeys(record, ["nodes", "edges"], "graph");
  if (!Array.isArray(record.nodes)) throw new Error("graph.nodes must be an array");
  if (!Array.isArray(record.edges)) throw new Error("graph.edges must be an array");
  if (record.nodes.length === 0) throw new Error("graph requires at least one node");
  if (record.nodes.length > MAX_NODES) throw new Error(`graph exceeds ${MAX_NODES} nodes`);
  if (record.edges.length > MAX_EDGES) throw new Error(`graph exceeds ${MAX_EDGES} edges`);

  const nodes = record.nodes.map(normalizeNode).sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("graph contains duplicate node ids");
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

  const edges = record.edges.map(normalizeEdge).sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right)));
  const edgeIds = edges.map(edgeIdentity);
  if (new Set(edgeIds).size !== edgeIds.length) throw new Error("graph contains duplicate edges");

  for (const edge of edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) throw new Error("edge references unknown node");
    const [expectedFrom, expectedTo] = EDGE_ENDPOINTS[edge.type];
    if (from.type !== expectedFrom || to.type !== expectedTo) {
      throw new Error(`${edge.type} requires ${expectedFrom}->${expectedTo}`);
    }
  }
  assertTopicAcyclic(nodes, edges);
  const core = { nodes, edges };
  return { ...core, digest: digest(core) };
}

export function createGraph(input: unknown): AuthorityGraph {
  return normalizeGraph(input);
}

export function validateGraph(graph: AuthorityGraph): void {
  const record = asRecord(graph, "graph");
  assertAllowedKeys(record, ["nodes", "edges", "digest"], "graph");
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) throw new Error("graph digest must be sha256 hex");
  const expected = normalizeGraph({ nodes: record.nodes, edges: record.edges });
  if (expected.digest !== record.digest) throw new Error("graph digest mismatch");
  if (canonicalJson(expected.nodes) !== canonicalJson(record.nodes) || canonicalJson(expected.edges) !== canonicalJson(record.edges)) {
    throw new Error("graph is not canonical");
  }
}

function roundMetric(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function pageRankParameters(options: PageRankOptions = {}): Required<PageRankOptions> {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isFinite(damping) || damping <= 0 || damping >= 1) throw new Error("damping must be finite and in (0,1)");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new Error(`iterations must be an integer in [1, ${MAX_ITERATIONS}]`);
  }
  return { damping, iterations };
}

function computePageRank(graph: AuthorityGraph, options: PageRankOptions = {}): Readonly<Record<string, number>> {
  const { damping, iterations } = pageRankParameters(options);
  const pages = graph.nodes.filter((node) => node.type === "PAGE").map((node) => node.id).sort();
  const count = pages.length;
  if (count === 0) return {};
  const pageSet = new Set(pages);
  const outgoing = new Map<string, AuthorityEdge[]>();
  for (const page of pages) outgoing.set(page, []);
  for (const edge of graph.edges) {
    if (edge.type === "INTERNAL_LINK" && pageSet.has(edge.from) && pageSet.has(edge.to)) outgoing.get(edge.from)!.push(edge);
  }
  for (const values of outgoing.values()) values.sort((left, right) => left.to.localeCompare(right.to));

  let rank = Object.fromEntries(pages.map((id) => [id, 1 / count])) as Record<string, number>;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = Object.fromEntries(pages.map((id) => [id, (1 - damping) / count])) as Record<string, number>;
    for (const from of pages) {
      const links = outgoing.get(from)!;
      if (links.length === 0) {
        const share = damping * rank[from]! / count;
        for (const page of pages) next[page]! += share;
        continue;
      }
      const total = links.reduce((sum, edge) => sum + edge.weight, 0);
      for (const edge of links) next[edge.to]! += damping * rank[from]! * (edge.weight / total);
    }
    rank = next;
  }
  return Object.fromEntries(pages.map((id) => [id, roundMetric(rank[id] ?? 0)]));
}

export function pageRank(graph: AuthorityGraph, options: PageRankOptions = {}): Readonly<Record<string, number>> {
  validateGraph(graph);
  return computePageRank(graph, options);
}

interface GraphIndexes {
  pages: readonly AuthorityNode[];
  topics: readonly AuthorityNode[];
  primaryEvidenceIds: ReadonlySet<string>;
  coversByTopic: ReadonlyMap<string, readonly string[]>;
  intentsByTopic: ReadonlyMap<string, readonly string[]>;
  servingPagesByIntent: ReadonlyMap<string, readonly string[]>;
  strongServingPagesByIntent: ReadonlyMap<string, readonly string[]>;
  citedEvidenceByPage: ReadonlyMap<string, readonly string[]>;
  inboundLinks: ReadonlyMap<string, number>;
  internalLinks: readonly AuthorityEdge[];
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function indexGraph(graph: AuthorityGraph): GraphIndexes {
  const pages = graph.nodes.filter((node) => node.type === "PAGE").sort((left, right) => left.id.localeCompare(right.id));
  const topics = graph.nodes.filter((node) => node.type === "TOPIC").sort((left, right) => left.id.localeCompare(right.id));
  const primaryEvidenceIds = new Set(graph.nodes.filter((node) => node.type === "EVIDENCE" && node.primary === true).map((node) => node.id));
  const coversByTopic = new Map<string, string[]>();
  const intentsByTopic = new Map<string, string[]>();
  const servingPagesByIntent = new Map<string, string[]>();
  const strongServingPagesByIntent = new Map<string, string[]>();
  const citedEvidenceByPage = new Map<string, string[]>();
  const inboundLinks = new Map<string, number>(pages.map((page) => [page.id, 0]));
  const internalLinks: AuthorityEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.type === "COVERS_TOPIC" && edge.weight >= STRONG_RELATION) pushMap(coversByTopic, edge.to, edge.from);
    if (edge.type === "INTENT_TOPIC") pushMap(intentsByTopic, edge.to, edge.from);
    if (edge.type === "SERVES_INTENT") {
      pushMap(servingPagesByIntent, edge.to, edge.from);
      if (edge.weight >= STRONG_RELATION) pushMap(strongServingPagesByIntent, edge.to, edge.from);
    }
    if (edge.type === "CITES_EVIDENCE") pushMap(citedEvidenceByPage, edge.from, edge.to);
    if (edge.type === "INTERNAL_LINK") {
      internalLinks.push(edge);
      inboundLinks.set(edge.to, (inboundLinks.get(edge.to) ?? 0) + 1);
    }
  }
  for (const map of [coversByTopic, intentsByTopic, servingPagesByIntent, strongServingPagesByIntent, citedEvidenceByPage]) {
    for (const values of map.values()) values.sort();
  }
  internalLinks.sort((left, right) => edgeIdentity(left).localeCompare(edgeIdentity(right)));
  return {
    pages,
    topics,
    primaryEvidenceIds,
    coversByTopic,
    intentsByTopic,
    servingPagesByIntent,
    strongServingPagesByIntent,
    citedEvidenceByPage,
    inboundLinks,
    internalLinks,
  };
}

function topicScores(graph: AuthorityGraph, indexes: GraphIndexes): readonly TopicScore[] {
  const rank = computePageRank(graph);
  return indexes.topics.map((topic) => {
    const pageIds = [...new Set(indexes.coversByTopic.get(topic.id) ?? [])].sort();
    const pageSet = new Set(pageIds);
    const coverage = Math.min(1, pageIds.length / 3);
    const intents = [...new Set(indexes.intentsByTopic.get(topic.id) ?? [])].sort();
    const served = intents.filter((intentId) => (indexes.strongServingPagesByIntent.get(intentId)?.length ?? 0) > 0).length;
    const intentCoverage = intents.length > 0 ? served / intents.length : 1;
    const pagesWithPrimaryEvidence = pageIds.filter((pageId) =>
      (indexes.citedEvidenceByPage.get(pageId) ?? []).some((evidenceId) => indexes.primaryEvidenceIds.has(evidenceId)),
    ).length;
    const primaryEvidence = pageIds.length > 0 ? pagesWithPrimaryEvidence / pageIds.length : 0;
    const linkCount = indexes.internalLinks.filter((edge) => pageSet.has(edge.from) && pageSet.has(edge.to)).length;
    const cohesion = pageIds.length <= 1 ? 1 : Math.min(1, linkCount / (pageIds.length * (pageIds.length - 1)));
    const centrality = pageIds.length > 0 ? pageIds.reduce((sum, pageId) => sum + (rank[pageId] ?? 0), 0) / pageIds.length : 0;
    const authority = coverage * 0.25
      + intentCoverage * 0.25
      + primaryEvidence * 0.20
      + cohesion * 0.15
      + Math.min(1, centrality * 10) * 0.15;
    return {
      topicId: topic.id,
      coverage: roundMetric(coverage),
      intentCoverage: roundMetric(intentCoverage),
      primaryEvidence: roundMetric(primaryEvidence),
      cohesion: roundMetric(cohesion),
      centrality: roundMetric(centrality),
      authority: roundMetric(authority),
    };
  });
}

export function assessTopics(graph: AuthorityGraph): readonly TopicScore[] {
  validateGraph(graph);
  return topicScores(graph, indexGraph(graph));
}

function graphDiagnostics(graph: AuthorityGraph, indexes: GraphIndexes): GraphDiagnostics {
  const orphans = indexes.pages.filter((page) => (indexes.inboundLinks.get(page.id) ?? 0) === 0).map((page) => page.id);
  const weakAnchors = indexes.internalLinks
    .filter((edge) => edge.anchor !== undefined && GENERIC_ANCHORS.has(edge.anchor.toLocaleLowerCase("es-MX").trim()))
    .map((edge) => ({ from: edge.from, to: edge.to, anchor: edge.anchor! }));
  const blocked = indexes.pages.filter((page) => page.indexable === true && page.crawlable === false).map((page) => page.id);
  const intentIds = graph.nodes.filter((node) => node.type === "INTENT").map((node) => node.id).sort();
  const cannibalization = intentIds
    .map((intentId) => ({ intentId, pageIds: [...new Set(indexes.strongServingPagesByIntent.get(intentId) ?? [])].sort() }))
    .filter((candidate) => candidate.pageIds.length > 1);
  const core = { orphans, weakAnchors, blocked, cannibalization, nonClaim: NON_CLAIM };
  return { ...core, diagnosticsDigest: digest(core) };
}

export function diagnostics(graph: AuthorityGraph): GraphDiagnostics {
  validateGraph(graph);
  return graphDiagnostics(graph, indexGraph(graph));
}

export function assessAuthority(graph: AuthorityGraph): AuthorityAssessment {
  validateGraph(graph);
  const indexes = indexGraph(graph);
  const topics = topicScores(graph, indexes);
  const diagnostic = graphDiagnostics(graph, indexes);
  const score = topics.length > 0 ? roundMetric(topics.reduce((sum, topic) => sum + topic.authority, 0) / topics.length) : 0;
  const hasTopologyDebt = diagnostic.orphans.length > 0
    || diagnostic.weakAnchors.length > 0
    || diagnostic.cannibalization.length > 0
    || topics.length === 0
    || topics.some((topic) => topic.authority < MIN_INTERNAL_AUTHORITY);
  const status: AuthorityStatus = diagnostic.blocked.length > 0 ? "BLOCKED" : hasTopologyDebt || score < MIN_INTERNAL_AUTHORITY ? "NEEDS_WORK" : "READY";
  const core = {
    status,
    graphDigest: graph.digest,
    score,
    topics,
    diagnostics: diagnostic,
    nonClaim: NON_CLAIM,
  };
  return { ...core, assessmentDigest: digest(core) };
}

export function validateAssessment(graph: AuthorityGraph, assessment: AuthorityAssessment): void {
  validateGraph(graph);
  const record = asRecord(assessment, "assessment");
  assertAllowedKeys(record, ["status", "graphDigest", "score", "topics", "diagnostics", "nonClaim", "assessmentDigest"], "assessment");
  if (record.graphDigest !== graph.digest) throw new Error("assessment graph digest mismatch");
  if (record.nonClaim !== NON_CLAIM) throw new Error("assessment non-claim marker mismatch");
  if (typeof record.assessmentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.assessmentDigest)) throw new Error("assessment digest must be sha256 hex");
  const expected = assessAuthority(graph);
  if (canonicalJson(expected) !== canonicalJson(assessment)) throw new Error("assessment replay mismatch");
}
