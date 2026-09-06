import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex16Error, SqliteCreativeTraceRegistry, signCreativeTrace, verifyCreativeTrace } from "./index";

const dirs: string[] = [];
function path(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex16-")); dirs.push(dir); return join(dir, "creative.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const creativeA = { creativeId: "creative-alpha", version: "version-0001", assetDigests: [`sha256:${"a".repeat(64)}`], deploymentKeys: ["campaign-0001", "adgroup-0001"], activatedAt: "2026-09-06T00:00:00.000Z" } as const;
const creativeB = { creativeId: "creative-beta", version: "version-0001", assetDigests: [`sha256:${"b".repeat(64)}`], deploymentKeys: ["campaign-0001", "adgroup-0002"], activatedAt: "2026-09-06T00:00:00.000Z" } as const;

describe("CORTEX #16 creative traceability", () => {
  it("registers immutable creative versions with content-derived trace keys", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    const first = registry.register(creativeA);
    expect(first.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.traceKey).toMatch(/^nxc16-/u);
    expect(registry.register(creativeA)).toEqual(first);
    expect(() => registry.register({ ...creativeA, assetDigests: [`sha256:${"c".repeat(64)}`] })).toThrowError(/different assets/u);
    registry.close();
  });

  it("never invents per-creative attribution for aggregated rows", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    const a = registry.register(creativeA);
    const b = registry.register(creativeB);
    const exact = registry.resolveAggregate({ aggregationId: "aggregate-0001", metric: "conversions", value: 12, traceKeys: [a.traceKey] });
    expect(exact.resolution).toBe("EXACT");
    expect(exact.creativeIds).toEqual(["creative-alpha"]);
    const ambiguous = registry.resolveAggregate({ aggregationId: "aggregate-0002", metric: "conversions", value: 30, traceKeys: [a.traceKey, b.traceKey] });
    expect(ambiguous.resolution).toBe("AMBIGUOUS_SET");
    expect(ambiguous.creativeIds).toEqual(["creative-alpha", "creative-beta"]);
    expect(ambiguous.value).toBe(30);
    const unresolved = registry.resolveAggregate({ aggregationId: "aggregate-0003", metric: "conversions", value: 7, traceKeys: ["unknown-trace-0001"] });
    expect(unresolved.resolution).toBe("UNRESOLVED");
    expect(unresolved.creativeIds).toEqual([]);
    registry.close();
  });

  it("signs trace identifiers and detects tampering", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    const record = registry.register(creativeA);
    const secret = "s".repeat(32);
    const signed = signCreativeTrace(record, secret);
    expect(verifyCreativeTrace(signed, secret)).toEqual({ traceKey: record.traceKey, manifestDigest: record.manifestDigest });
    expect(() => verifyCreativeTrace({ ...signed, manifestDigest: `sha256:${"f".repeat(64)}` }, secret)).toThrowError(Cortex16Error);
    registry.close();
  });

  it("persists provenance across reopen", () => {
    const db = path();
    const registry = new SqliteCreativeTraceRegistry(db);
    const record = registry.register(creativeA);
    registry.close();
    const reopened = new SqliteCreativeTraceRegistry(db);
    expect(reopened.getByTraceKey(record.traceKey)?.manifestDigest).toBe(record.manifestDigest);
    reopened.close();
  });
});
