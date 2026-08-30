import { describe, expect, it } from "vitest";
import {
  NON_CLAIM,
  assessAuthority,
  assessTopics,
  canonicalJson,
  createGraph,
  diagnostics,
  pageRank,
  validateAssessment,
  validateGraph,
  type AuthorityGraphInput,
} from "./index.js";

function graphInput(overrides: Partial<AuthorityGraphInput> = {}): AuthorityGraphInput {
  return {
    nodes: [
      { id: "home", type: "PAGE", label: "Inicio", url: "https://example.com/", indexable: true, crawlable: true },
      { id: "fiscal", type: "PAGE", label: "Defensa fiscal", url: "https://example.com/fiscal", indexable: true, crawlable: true },
      { id: "amparo", type: "PAGE", label: "Amparo", url: "https://example.com/amparo", indexable: true, crawlable: true },
      { id: "topic-tax", type: "TOPIC", label: "Defensa fiscal" },
      { id: "intent-tax", type: "INTENT", label: "contratar defensa fiscal" },
      { id: "entity-sat", type: "ENTITY", label: "SAT" },
      { id: "evidence-tax", type: "EVIDENCE", label: "Fuente fiscal primaria", primary: true, url: "https://example.com/source" },
    ],
    edges: [
      { from: "home", to: "fiscal", type: "INTERNAL_LINK", weight: 1, anchor: "defensa fiscal" },
      { from: "fiscal", to: "amparo", type: "INTERNAL_LINK", weight: 1, anchor: "amparo relacionado" },
      { from: "amparo", to: "home", type: "INTERNAL_LINK", weight: 1, anchor: "inicio" },
      { from: "home", to: "topic-tax", type: "COVERS_TOPIC", weight: 0.7 },
      { from: "fiscal", to: "topic-tax", type: "COVERS_TOPIC", weight: 1 },
      { from: "amparo", to: "topic-tax", type: "COVERS_TOPIC", weight: 0.65 },
      { from: "intent-tax", to: "topic-tax", type: "INTENT_TOPIC", weight: 1 },
      { from: "fiscal", to: "intent-tax", type: "SERVES_INTENT", weight: 1 },
      { from: "fiscal", to: "entity-sat", type: "MENTIONS_ENTITY", weight: 1 },
      { from: "home", to: "evidence-tax", type: "CITES_EVIDENCE", weight: 1 },
      { from: "fiscal", to: "evidence-tax", type: "CITES_EVIDENCE", weight: 1 },
      { from: "amparo", to: "evidence-tax", type: "CITES_EVIDENCE", weight: 1 },
    ],
    ...overrides,
  };
}

describe("topical authority graph", () => {
  it("creates deterministic replay-verifiable assessments", () => {
    const graph = createGraph(graphInput());
    const assessment = assessAuthority(graph);
    expect(assessment.status).toBe("READY");
    expect(assessment.nonClaim).toBe(NON_CLAIM);
    expect(() => validateGraph(graph)).not.toThrow();
    expect(() => validateAssessment(graph, assessment)).not.toThrow();
    expect(canonicalJson(assessment)).toBe(canonicalJson(assessAuthority(graph)));
  });

  it("computes bounded internal PageRank and topical scores", () => {
    const graph = createGraph(graphInput());
    const rank = pageRank(graph);
    expect(Object.keys(rank).sort()).toEqual(["amparo", "fiscal", "home"]);
    expect(Object.values(rank).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    const topic = assessTopics(graph)[0]!;
    expect(topic.topicId).toBe("topic-tax");
    expect(topic.coverage).toBe(1);
    expect(topic.intentCoverage).toBe(1);
    expect(topic.primaryEvidence).toBe(1);
    expect(topic.authority).toBeGreaterThanOrEqual(0.6);
  });

  it("rejects endpoint-type confusion, dangling nodes and duplicate edges", () => {
    expect(() => createGraph(graphInput({ edges: [{ from: "topic-tax", to: "fiscal", type: "COVERS_TOPIC", weight: 1 }] }))).toThrow(/PAGE->TOPIC/);
    expect(() => createGraph(graphInput({ edges: [{ from: "home", to: "missing", type: "INTERNAL_LINK", weight: 1 }] }))).toThrow(/unknown node/);
    const duplicate = { from: "home", to: "fiscal", type: "INTERNAL_LINK" as const, weight: 1 };
    expect(() => createGraph(graphInput({ edges: [duplicate, duplicate] }))).toThrow(/duplicate edges/);
  });

  it("rejects topic hierarchy cycles and invalid relation weights", () => {
    const nodes = [...graphInput().nodes, { id: "topic-parent", type: "TOPIC" as const, label: "Fiscal" }];
    expect(() => createGraph({ nodes, edges: [
      { from: "topic-tax", to: "topic-parent", type: "TOPIC_PARENT", weight: 1 },
      { from: "topic-parent", to: "topic-tax", type: "TOPIC_PARENT", weight: 1 },
    ] })).toThrow(/cycle/);
    expect(() => createGraph(graphInput({ edges: [{ from: "home", to: "fiscal", type: "INTERNAL_LINK", weight: 0 }] }))).toThrow(/\(0, 1\]/);
  });

  it("detects orphan, weak-anchor, crawl and cannibalization candidates without external ranking claims", () => {
    const nodes = graphInput().nodes.map((node) => node.id === "amparo" ? { ...node, crawlable: false } : node);
    const edges = graphInput().edges.filter((edge) => !(edge.type === "INTERNAL_LINK" && edge.to === "home"));
    edges.push({ from: "home", to: "fiscal", type: "SERVES_INTENT", weight: 0.8 });
    edges.push({ from: "fiscal", to: "amparo", type: "INTERNAL_LINK", weight: 0.5, anchor: "more" });
    const graph = createGraph({ nodes, edges });
    const result = diagnostics(graph);
    expect(result.orphans).toContain("home");
    expect(result.weakAnchors.some((item) => item.anchor === "more")).toBe(true);
    expect(result.blocked).toContain("amparo");
    expect(result.cannibalization).toEqual([{ intentId: "intent-tax", pageIds: ["fiscal", "home"] }]);
    expect(result.nonClaim).toBe(NON_CLAIM);
    expect(assessAuthority(graph).status).toBe("BLOCKED");
  });

  it("rejects unsafe URLs, credentials and fields outside the bound model", () => {
    const badPage = graphInput().nodes.map((node) => node.id === "home" ? { ...node, url: "javascript:alert(1)" } : node);
    expect(() => createGraph({ nodes: badPage, edges: graphInput().edges })).toThrow(/HTTP\(S\)/);
    const credentialPage = graphInput().nodes.map((node) => node.id === "home" ? { ...node, url: "https://user:pass@example.com/" } : node);
    expect(() => createGraph({ nodes: credentialPage, edges: graphInput().edges })).toThrow(/credentials/);
    expect(() => createGraph({ nodes: [{ ...graphInput().nodes[0], hiddenMetric: 1 }], edges: [] })).toThrow(/unknown key/);
  });

  it("rejects tampered graph and mutually rehashed-looking assessment output by replay", () => {
    const graph = createGraph(graphInput());
    expect(() => validateGraph({ ...graph, nodes: graph.nodes.map((node) => node.id === "home" ? { ...node, label: "Alterado" } : node) })).toThrow(/digest mismatch/);
    const assessment = assessAuthority(graph);
    const forged = { ...assessment, status: "BLOCKED" as const, assessmentDigest: "f".repeat(64) };
    expect(() => validateAssessment(graph, forged)).toThrow(/replay mismatch/);
  });

  it("enforces graph budgets and PageRank iteration bounds", () => {
    const nodes = Array.from({ length: 5_001 }, (_, index) => ({
      id: `p-${index}`,
      type: "PAGE" as const,
      label: `Page ${index}`,
      url: `https://example.com/${index}`,
      indexable: true,
      crawlable: true,
    }));
    expect(() => createGraph({ nodes, edges: [] })).toThrow(/5000 nodes/);
    const graph = createGraph(graphInput());
    expect(() => pageRank(graph, { iterations: 129 })).toThrow(/128/);
  });

  it("rejects cyclic canonical inputs", () => {
    const cyclic: { value?: unknown } = {};
    cyclic.value = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});
