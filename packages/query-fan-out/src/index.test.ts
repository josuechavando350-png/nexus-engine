import { describe, expect, it } from "vitest";
import { simulateQueryFanOut, validateFanOut, type FanOutRequest } from "./index.js";

const request = (): FanOutRequest => ({ tenantId: "tenant-a", scope: "public", query: "  Best CRM? ", maxDepth: 2, maxNodes: 8, seeds: [
  { kind: "INTENT", text: "Compare CRM", parentText: "best crm" },
  { kind: "ENTITY", text: "CRM", parentText: "compare crm", evidenceClass: "INFERRED" },
  { kind: "RELATED_QUESTION", text: "CRM!", parentText: "compare crm" },
  { kind: "PERSPECTIVE", text: "not CRM", parentText: "compare crm" },
] });

describe("query fan-out", () => {
  it("replays deterministically with bounded semantic deduplication", () => { const first = simulateQueryFanOut(request()); expect(simulateQueryFanOut({ ...request(), seeds: [...request().seeds].reverse() })).toEqual(first); expect(first.nodes).toHaveLength(4); expect(first.contradictions).toHaveLength(1); expect(() => validateFanOut(request(), first)).not.toThrow(); });
  it("enforces depth and node budgets without graph explosion", () => { const result = simulateQueryFanOut({ ...request(), maxDepth: 0 }); expect(result.nodes).toHaveLength(1); expect(result.truncated).toBe(true); expect(() => simulateQueryFanOut({ ...request(), maxNodes: 513 })).toThrow(/0-512|1-512/); });
  it("requires provenance for observed external evidence", () => { expect(() => simulateQueryFanOut({ ...request(), seeds: [{ kind: "ENTITY", text: "CRM", evidenceClass: "OBSERVED_EXTERNAL" }] })).toThrow(/requires source/); });
  it("rejects unsafe inputs and tampered replay", () => { expect(() => simulateQueryFanOut({ ...request(), tenantId: "<tenant>" })).toThrow(/unsafe/); const result = simulateQueryFanOut(request()); expect(() => validateFanOut(request(), { ...result, truncated: !result.truncated })).toThrow(/mismatch/); });
});
