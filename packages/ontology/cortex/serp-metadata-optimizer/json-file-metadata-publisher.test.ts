import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetadataPublisherError, createPublishedMetadataSnapshot, type MetadataPublishAction } from "./index";
import { JsonFileMetadataPublisher } from "./json-file-metadata-publisher";

const SITE = "https://example.com/";
const PAGE = "https://example.com/legal";

function upsert(expected: ReturnType<typeof createPublishedMetadataSnapshot> | null = null): MetadataPublishAction {
  return Object.freeze({
    kind: "UPSERT_METADATA_OVERRIDE" as const,
    siteUrl: SITE,
    pageId: "legal-federal",
    pageUrl: PAGE,
    expected,
    desired: Object.freeze({ title: "Federal Criminal Defense | Nexus Legal", metaDescription: "Federal criminal defense for complex matters." }),
  });
}

function withPublisher(run: (publisher: JsonFileMetadataPublisher, path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "nexus-serp-publisher-"));
  const path = join(directory, "metadata.json");
  const publisher = new JsonFileMetadataPublisher({ manifestPath: path });
  return run(publisher, path).finally(() => rmSync(directory, { recursive: true, force: true }));
}

describe("JsonFileMetadataPublisher", () => {
  it("persists a canonical override that survives a fresh publisher instance", async () => {
    await withPublisher(async (publisher, path) => {
      const receipt = await publisher.apply(upsert());
      expect(receipt.snapshot?.revision).toBe(1);
      expect(receipt.recoveredAlreadyApplied).toBe(false);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body.endsWith("\n")).toBe(true);
      expect(body).toContain("nexus-serp-metadata-manifest-v1");

      const reopened = new JsonFileMetadataPublisher({ manifestPath: path });
      const snapshot = await reopened.read(SITE, "legal-federal", PAGE);
      expect(snapshot?.digest).toBe(receipt.snapshot?.digest);
      expect(snapshot?.metadata.title).toBe("Federal Criminal Defense | Nexus Legal");
    });
  });

  it("recovers an already-applied upsert without creating another revision", async () => {
    await withPublisher(async (publisher) => {
      const first = await publisher.apply(upsert());
      const recovered = await publisher.apply(upsert(null));
      expect(recovered.recoveredAlreadyApplied).toBe(true);
      expect(recovered.snapshot?.revision).toBe(1);
      expect(recovered.snapshot?.digest).toBe(first.snapshot?.digest);
    });
  });

  it("enforces compare-and-swap and refuses third-party drift", async () => {
    await withPublisher(async (publisher) => {
      const first = await publisher.apply(upsert());
      if (!first.snapshot) throw new Error("missing snapshot");
      const stale = createPublishedMetadataSnapshot({
        pageId: first.snapshot.pageId,
        pageUrl: first.snapshot.pageUrl,
        metadata: { title: "Stale title", metaDescription: "Stale description" },
        revision: first.snapshot.revision,
      });
      const action = Object.freeze({ ...upsert(stale), desired: { title: "Another title", metaDescription: "Another description" } });
      await expect(publisher.apply(action)).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" });
      expect((await publisher.read(SITE, "legal-federal", PAGE))?.digest).toBe(first.snapshot.digest);
    });
  });

  it("removes the exact override and treats a repeated removal as recovered", async () => {
    await withPublisher(async (publisher) => {
      const first = await publisher.apply(upsert());
      if (!first.snapshot) throw new Error("missing snapshot");
      const remove: MetadataPublishAction = Object.freeze({
        kind: "REMOVE_METADATA_OVERRIDE", siteUrl: SITE, pageId: "legal-federal", pageUrl: PAGE, expected: first.snapshot,
      });
      const removed = await publisher.apply(remove);
      expect(removed.snapshot).toBeNull();
      expect(removed.recoveredAlreadyApplied).toBe(false);
      const recovered = await publisher.apply(remove);
      expect(recovered.snapshot).toBeNull();
      expect(recovered.recoveredAlreadyApplied).toBe(true);
    });
  });

  it("never deletes another writer's lock when lock acquisition fails", async () => {
    await withPublisher(async (publisher, path) => {
      const lockPath = `${path}.lock`;
      writeFileSync(lockPath, "foreign-writer", { encoding: "utf8", mode: 0o600 });
      await expect(publisher.apply(upsert())).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" });
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe("foreign-writer");
    });
  });

  it("fails closed on corrupt or cross-site manifests", async () => {
    await withPublisher(async (publisher, path) => {
      writeFileSync(path, "not-json\n", "utf8");
      await expect(publisher.read(SITE, "legal-federal", PAGE)).rejects.toBeInstanceOf(MetadataPublisherError);

      writeFileSync(path, JSON.stringify({ formatVersion: "nexus-serp-metadata-manifest-v1", siteUrl: "https://other.example/", pages: {} }), "utf8");
      await expect(publisher.read(SITE, "legal-federal", PAGE)).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" });
    });
  });

  it("binds a pageId to one URL and refuses identity reuse", async () => {
    await withPublisher(async (publisher) => {
      await publisher.apply(upsert());
      await expect(publisher.read(SITE, "legal-federal", "https://example.com/other")).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" });
    });
  });
});
