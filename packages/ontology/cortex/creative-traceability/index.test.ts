import { DatabaseSync } from "node:sqlite";
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

  it("never invents per-creative attribution for complete, ambiguous, incomplete, or unresolved aggregate trace sets", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    const a = registry.register(creativeA);
    const b = registry.register(creativeB);
    const exact = registry.resolveAggregate({ aggregationId: "aggregate-0001", metric: "conversions", value: 12, traceKeys: [a.traceKey] });
    expect(exact).toMatchObject({ resolution: "EXACT", creativeIds: ["creative-alpha"], resolvedTraceCount: 1, unresolvedTraceCount: 0 });
    const ambiguous = registry.resolveAggregate({ aggregationId: "aggregate-0002", metric: "conversions", value: 30, traceKeys: [a.traceKey, b.traceKey] });
    expect(ambiguous).toMatchObject({ resolution: "AMBIGUOUS_SET", creativeIds: ["creative-alpha", "creative-beta"], resolvedTraceCount: 2, unresolvedTraceCount: 0 });
    const incomplete = registry.resolveAggregate({ aggregationId: "aggregate-0003", metric: "conversions", value: 19, traceKeys: [a.traceKey, "unknown-trace-0001"] });
    expect(incomplete).toMatchObject({ resolution: "INCOMPLETE_SET", creativeIds: ["creative-alpha"], resolvedTraceCount: 1, unresolvedTraceCount: 1 });
    const unresolved = registry.resolveAggregate({ aggregationId: "aggregate-0004", metric: "conversions", value: 7, traceKeys: ["unknown-trace-0001"] });
    expect(unresolved).toMatchObject({ resolution: "UNRESOLVED", creativeIds: [], resolvedTraceCount: 0, unresolvedTraceCount: 1 });
    registry.close();
  });

  it("signs trace identifiers and detects signature or record-identity tampering", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    const record = registry.register(creativeA);
    const secret = "s".repeat(32);
    const signed = signCreativeTrace(record, secret);
    expect(verifyCreativeTrace(signed, secret)).toEqual({ traceKey: record.traceKey, manifestDigest: record.manifestDigest });
    expect(() => verifyCreativeTrace({ ...signed, manifestDigest: `sha256:${"f".repeat(64)}` }, secret)).toThrowError(Cortex16Error);
    expect(() => signCreativeTrace({ ...record, traceKey: "nxc16-tampered-trace-key" }, secret)).toThrowError(/trace identity/u);
    registry.close();
  });

  it("detects tampering of persisted manifest digests and trace keys", () => {
    const dbPath = path();
    const registry = new SqliteCreativeTraceRegistry(dbPath);
    const record = registry.register(creativeA);
    registry.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE cortex16_creatives SET trace_key=? WHERE creative_id=? AND version=?").run("nxc16-tampered-trace-key", creativeA.creativeId, creativeA.version);
    db.close();
    const reopened = new SqliteCreativeTraceRegistry(dbPath);
    expect(() => reopened.getByTraceKey("nxc16-tampered-trace-key")).toThrowError(/trace key mismatch/u);
    reopened.close();
    expect(record.traceKey).toMatch(/^nxc16-/u);
  });

  it("rolls back registration when the final control guard fails", () => {
    const registry = new SqliteCreativeTraceRegistry(path());
    expect(() => registry.register(creativeA, () => { throw new Error("killed"); })).toThrowError(/killed/u);
    const record = registry.register(creativeA);
    expect(record.creativeId).toBe(creativeA.creativeId);
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
