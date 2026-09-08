import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicProcurementIntelligenceEngine } from "./procurement-intelligence.js";
import { PublicProcurementUrlPolicy } from "./public-url-policy.js";
import { SqliteProcurementJobQueue } from "./sqlite-job-queue.js";
import { ProcurementAsyncWorker } from "./worker.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("ProcurementAsyncWorker", () => {
  it("persists the job, scans it, writes the result and acknowledges only after the sink succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-procurement-worker-")); dirs.push(dir);
    const queue = new SqliteProcurementJobQueue(join(dir, "queue.sqlite"));
    const source = { sourceId: "ocds-portal", kind: "OCDS_JSON" as const, url: "https://compras.example/ocds.json" };
    queue.enqueue("tenant-one", source, "scan-20260908", 1_000);
    const urlPolicy = new PublicProcurementUrlPolicy(["https://compras.example"], { resolve: async () => ["8.8.8.8"] });
    const fetchImpl: typeof fetch = vi.fn(async (input) => String(input).endsWith("robots.txt")
      ? new Response("User-agent: *\nAllow: /\n", { status: 200 })
      : new Response(JSON.stringify({ releases: [{ id: "r1", tender: { title: "Seguridad administrada" } }] }), { status: 200 }));
    const engine = new PublicProcurementIntelligenceEngine({
      profile: { tenantId: "tenant-one", canonicalWebsiteOrigin: "https://seller.example", capabilityPhrases: ["seguridad administrada"], minimumMatchScore: 1 },
      urlPolicy,
      browser: { fetchPublicPage: async () => { throw new Error("not used"); } },
      fetchImpl,
      now: () => 2_000,
    });
    const write = vi.fn(async () => undefined);
    const worker = new ProcurementAsyncWorker({ tenantId: "tenant-one", workerId: "worker-one", queue, engine, resultSink: { write }, now: () => 2_000 });
    expect(await worker.runNext()).toMatchObject({ status: "COMPLETED" });
    expect(write).toHaveBeenCalledOnce();
    expect(queue.counts("tenant-one").done).toBe(1);
    queue.close();
  });
});
