import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteProcurementJobQueue } from "./sqlite-job-queue.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function queue() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-procurement-"));
  dirs.push(dir);
  return new SqliteProcurementJobQueue(join(dir, "jobs.sqlite"));
}

describe("SqliteProcurementJobQueue", () => {
  it("deduplicates per tenant and keeps leases tenant-scoped", () => {
    const q = queue();
    const source = { sourceId: "portal-one", kind: "OCDS_JSON" as const, url: "https://compras.example/ocds.json" };
    const first = q.enqueue("tenant-one", source, "scan-20260908", 1_000);
    expect(q.enqueue("tenant-one", source, "scan-20260908", 2_000)).toBe(first);
    expect(q.enqueue("tenant-one", source, "scan-20260909", 2_000)).not.toBe(first);
    q.enqueue("tenant-two", source, "scan-20260908", 2_000);
    expect(q.claim("tenant-two", "worker-two", 3_000)?.tenantId).toBe("tenant-two");
    expect(q.claim("tenant-one", "worker-one", 3_000)?.tenantId).toBe("tenant-one");
    q.close();
  });

  it("requires lease ownership for acknowledgement and retries with bounded backoff", () => {
    const q = queue();
    const jobId = q.enqueue("tenant-one", { sourceId: "portal-one", kind: "PUBLIC_HTML", url: "https://compras.example/rfp" }, "scan-20260908", 1_000);
    expect(q.claim("tenant-one", "worker-one", 1_000)?.jobId).toBe(jobId);
    expect(() => q.complete("tenant-one", jobId, "worker-other", 2_000)).toThrow(/active lease/u);
    q.retry("tenant-one", jobId, "worker-one", "temporary source error", 2_000);
    expect(q.counts("tenant-one").pending).toBe(1);
    expect(q.claim("tenant-one", "worker-one", 2_001)).toBeNull();
    expect(q.claim("tenant-one", "worker-one", 7_000)?.attempt).toBe(1);
    q.close();
  });
});
