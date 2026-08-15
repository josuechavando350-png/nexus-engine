import { describe, expect, it } from "vitest";
import { AppendOnlyCreativeGallery, DeterministicGallerySearch, GalleryError, type GalleryEntry } from "../gallery";
import { InMemoryGalleryStore } from "../testing";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });

function entry(id: string, overrides: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    schemaVersion: 1,
    entryId: id,
    scope,
    kind: "IMAGE",
    title: `Reference ${id}`,
    description: "Premium editorial brutalist reference",
    source: {
      sourceId: `source-${id}`,
      sourceType: "REFERENCE",
      sourceUri: `https://example.com/${id}`,
      capturedAt: "2026-08-15T00:00:00Z",
      licenseIds: []
    },
    tags: ["premium", "editorial"],
    intents: ["landing", "brand"],
    techniques: ["asymmetry", "grid"],
    relatedEntryIds: [],
    createdAt: "2026-08-15T00:00:00Z",
    ...overrides
  };
}

describe("Creative Gallery", () => {
  it("appends immutable references and rejects duplicate identity", async () => {
    const store = new InMemoryGalleryStore();
    const gallery = new AppendOnlyCreativeGallery(store);
    await gallery.append(entry("ref-a"));
    await expect(gallery.append(entry("ref-a"))).rejects.toMatchObject({ code: "DUPLICATE_ID" });
    await expect(gallery.append(entry("ref-a", { title: "Different" }))).rejects.toMatchObject({ code: "IDENTITY_COLLISION" });
  });

  it("requires license IDs for licensed sources", async () => {
    const gallery = new AppendOnlyCreativeGallery(new InMemoryGalleryStore());
    await expect(gallery.append(entry("licensed", { source: { ...entry("x").source, sourceId: "source-licensed", sourceType: "LICENSED", licenseIds: [] } }))).rejects.toMatchObject({ code: "INVALID_ENTRY" });
  });

  it("rejects self relations, duplicate normalized tags, and malformed metadata", async () => {
    const gallery = new AppendOnlyCreativeGallery(new InMemoryGalleryStore());
    await expect(gallery.append(entry("self", { relatedEntryIds: ["self"] }))).rejects.toBeInstanceOf(GalleryError);
    await expect(gallery.append(entry("tags", { tags: ["Premium", " premium "] }))).rejects.toMatchObject({ code: "INVALID_ENTRY" });
    await expect(gallery.append(entry("bad-time", { createdAt: "yesterday" }))).rejects.toMatchObject({ code: "INVALID_ENTRY" });
  });

  it("searches deterministically regardless of store insertion order", async () => {
    const firstStore = new InMemoryGalleryStore();
    const secondStore = new InMemoryGalleryStore();
    const items = [
      entry("ref-a", { tags: ["premium", "editorial"], intents: ["landing"], techniques: ["grid"] }),
      entry("ref-b", { tags: ["minimal"], intents: ["landing"], techniques: ["grid"] }),
      entry("ref-c", { kind: "SHADER", tags: ["premium"], intents: ["hero"], techniques: ["glsl"] })
    ];
    const firstGallery = new AppendOnlyCreativeGallery(firstStore);
    const secondGallery = new AppendOnlyCreativeGallery(secondStore);
    for (const item of items) await firstGallery.append(item);
    for (const item of [...items].reverse()) await secondGallery.append(item);
    const query = { scope, text: "premium editorial", tags: ["premium"], intents: ["landing"], limit: 10 } as const;
    const a = await new DeterministicGallerySearch(firstStore).search(query);
    const b = await new DeterministicGallerySearch(secondStore).search(query);
    expect(b).toEqual(a);
    expect(a[0]?.entry.entryId).toBe("ref-a");
  });

  it("uses lexical entry ID as a deterministic tie break", async () => {
    const store = new InMemoryGalleryStore();
    const gallery = new AppendOnlyCreativeGallery(store);
    await gallery.append(entry("ref-b", { title: "Same", description: "Same", tags: ["same"], intents: [], techniques: [] }));
    await gallery.append(entry("ref-a", { title: "Same", description: "Same", tags: ["same"], intents: [], techniques: [] }));
    const result = await new DeterministicGallerySearch(store).search({ scope, tags: ["same"], limit: 10 });
    expect(result.map((item) => item.entry.entryId)).toEqual(["ref-a", "ref-b"]);
  });

  it("isolates tenant and brand scopes even with an unsafe backend", async () => {
    const store = new InMemoryGalleryStore();
    store.unsafeInject(entry("good"));
    store.unsafeInject(entry("other-tenant", { scope: { tenantId: "tenant-b", brandId: "brand-a" } }));
    store.unsafeInject(entry("other-brand", { scope: { tenantId: "tenant-a", brandId: "brand-b" } }));
    const result = await new DeterministicGallerySearch(store).search({ scope, limit: 10 });
    expect(result.map((item) => item.entry.entryId)).toEqual(["good"]);
  });

  it("filters by kind and exposes exact matched dimensions", async () => {
    const store = new InMemoryGalleryStore();
    const gallery = new AppendOnlyCreativeGallery(store);
    await gallery.append(entry("shader", { kind: "SHADER", title: "Liquid shader", tags: ["liquid"], intents: ["hero"], techniques: ["glsl"] }));
    await gallery.append(entry("image", { kind: "IMAGE", title: "Liquid image", tags: ["liquid"], intents: ["hero"], techniques: ["photography"] }));
    const result = await new DeterministicGallerySearch(store).search({ scope, kinds: ["SHADER"], tags: ["liquid"], techniques: ["glsl"], limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]?.entry.entryId).toBe("shader");
    expect(result[0]?.matched.tags).toEqual(["liquid"]);
    expect(result[0]?.matched.techniques).toEqual(["glsl"]);
  });

  it("enforces query bounds and translates backend outages", async () => {
    const store = new InMemoryGalleryStore();
    const search = new DeterministicGallerySearch(store);
    await expect(search.search({ scope, limit: 0 })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    store.failReads = true;
    await expect(search.search({ scope, limit: 10 })).rejects.toMatchObject({ code: "STORE_OUTAGE" });
  });

  it("translates write outages into typed errors", async () => {
    const store = new InMemoryGalleryStore();
    store.failWrites = true;
    await expect(new AppendOnlyCreativeGallery(store).append(entry("write-fail"))).rejects.toMatchObject({ code: "STORE_OUTAGE" });
  });
});
