import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgrammaticSeoBundle, createProgrammaticSeoCatalogSnapshot, createProgrammaticSeoPolicy } from "./index";
import { JsonFileProgrammaticSeoPublisher } from "./json-file-page-bundle-publisher";

const NOW = "2026-09-05T07:30:00.000Z";
function bundle() {
  const policy = createProgrammaticSeoPolicy({ policyId: "p", version: "v1", maxCatalogAgeMs: 300_000, maxPages: 10, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.85, maxRouteDepth: 4 });
  const catalog = createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: NOW, pages: [
    { pageId: "home", routeSegments: [], parentPageId: null, locale: "en-US", title: "Home", description: "Home description", heading: "Home heading", bodyText: "Home heading. This page connects verified services. Home-only verified navigation statement.", distinctiveStatements: ["Home-only verified navigation statement."], evidenceRefs: ["cms:home:v1"], updatedAt: NOW, indexable: true },
    { pageId: "service", routeSegments: ["services", "federal"], parentPageId: "home", locale: "en-US", title: "Federal", description: "Federal description", heading: "Federal heading", bodyText: "Federal heading. Federal court workflow and intake details. Federal-only verified service statement.", distinctiveStatements: ["Federal-only verified service statement."], evidenceRefs: ["cms:federal:v1"], updatedAt: NOW, indexable: true },
  ] });
  return compileProgrammaticSeoBundle(catalog, policy);
}

describe("JsonFileProgrammaticSeoPublisher", () => {
  it("stages immutable content, persists only a pointer, reopens, and recovers idempotently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-pseo-")); const path = join(directory, "bundle.json");
    try {
      const publisher = new JsonFileProgrammaticSeoPublisher({ manifestPath: path }); const desired = bundle(); const ref = await publisher.stage(desired); expect((await publisher.load(ref)).digest).toBe(desired.digest);
      const first = await publisher.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: null, desired: ref }); expect(first.snapshot?.revision).toBe(1); expect(first.recoveredAlreadyApplied).toBe(false); expect(first.snapshot?.bundleRef.digest).toBe(ref.digest); expect(readFileSync(path, "utf8")).not.toContain("Federal court workflow and intake details");
      const reopened = new JsonFileProgrammaticSeoPublisher({ manifestPath: path }); const current = await reopened.read("site-a"); expect(current?.bundleRef.bundleDigest).toBe(desired.digest); expect((await reopened.load(current!.bundleRef)).digest).toBe(desired.digest);
      const recovered = await reopened.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: null, desired: ref }); expect(recovered.recoveredAlreadyApplied).toBe(true); expect(recovered.snapshot?.revision).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("enforces CAS and foreign locks, restores exact pointers, and detects artifact corruption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-pseo-")); const path = join(directory, "bundle.json");
    try {
      const publisher = new JsonFileProgrammaticSeoPublisher({ manifestPath: path }); const desired = bundle(); const ref = await publisher.stage(desired); const first = await publisher.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: null, desired: ref });
      writeFileSync(`${path}.lock`, "foreign", "utf8"); await expect(publisher.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: first.snapshot, desired: ref })).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" }); rmSync(`${path}.lock`, { force: true });
      const removed = await publisher.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: first.snapshot, desired: null }); expect(removed.snapshot).toBeNull(); expect(await publisher.read("site-a")).toBeNull();
      const restored = await publisher.apply({ kind: "REPLACE_BUNDLE", siteId: "site-a", expected: null, desired: ref }); expect(restored.snapshot?.bundleRef.digest).toBe(ref.digest);
      const artifactPath = join(publisher.artifactsDirectory, `${ref.artifactId}.json`); const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as { digest: string }; raw.digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; writeFileSync(artifactPath, JSON.stringify(raw), "utf8");
      await expect(publisher.load(ref)).rejects.toMatchObject({ code: "PUBLISH_FAILURE" }); await expect(publisher.read("site-a")).rejects.toMatchObject({ code: "PUBLISH_FAILURE" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed on invalid configuration", () => { expect(() => new JsonFileProgrammaticSeoPublisher({ manifestPath: "" })).toThrow(/manifestPath/); });
});
