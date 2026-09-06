import { afterEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";
import { mergeSerpMetadata, readSerpMetadataOverride } from "./serp-metadata-control";

const TOKEN = "metadata-token-000000000000000000000000";
const PAGE_ID = "delitos-fiscales-y-financieros";
const PAGE_URL = "https://canopenal.com/areas/delitos-fiscales-y-financieros";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function validBody() {
  return {
    siteUrl: "https://canopenal.com/",
    pageId: PAGE_ID,
    pageUrl: PAGE_URL,
    metadata: { title: "Defensa penal fiscal", metaDescription: "Descripción publicada y gobernada." },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CANO SERP metadata consumer", () => {
  it("fails closed when production endpoint configuration is absent or unsafe", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    expect(await readSerpMetadataOverride(PAGE_ID, PAGE_URL)).toBeNull();
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_ENDPOINT", "http://control.example.test/v1/serp/metadata");
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_TOKEN", TOKEN);
    expect(await readSerpMetadataOverride(PAGE_ID, PAGE_URL)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts only an exact identity-bound override and keeps the token server-side", async () => {
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_ENDPOINT", "https://control.example.test/v1/serp/metadata");
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_TOKEN", TOKEN);
    const calls: Array<Parameters<typeof fetch>> = [];
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => { calls.push(args); return json(validBody()); }));

    await expect(readSerpMetadataOverride(PAGE_ID, PAGE_URL)).resolves.toEqual({ title: "Defensa penal fiscal", description: "Descripción publicada y gobernada." });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.protocol).toBe("https:");
    expect(parsed.searchParams.get("siteUrl")).toBe("https://canopenal.com/");
    expect(parsed.searchParams.get("pageId")).toBe(PAGE_ID);
    expect(parsed.searchParams.get("pageUrl")).toBe(PAGE_URL);
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("rejects cross-page responses and malformed metadata", async () => {
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_ENDPOINT", "https://control.example.test/v1/serp/metadata");
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_TOKEN", TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...validBody(), pageUrl: "https://canopenal.com/areas/other" })));
    expect(await readSerpMetadataOverride(PAGE_ID, PAGE_URL)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...validBody(), metadata: { title: "", metaDescription: 42 } })));
    expect(await readSerpMetadataOverride(PAGE_ID, PAGE_URL)).toBeNull();
  });

  it("enforces the 8 KiB bound while streaming even without Content-Length", async () => {
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_ENDPOINT", "https://control.example.test/v1/serp/metadata");
    vi.stubEnv("NEXUS_CORTEX_SERP_METADATA_TOKEN", TOKEN);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
        controller.enqueue(encoder.encode(`"padding":"${"x".repeat(9 * 1024)}"}`));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } })));
    expect(await readSerpMetadataOverride(PAGE_ID, PAGE_URL)).toBeNull();
  });

  it("preserves the local approved fallback when no governed override exists", () => {
    const fallback: Metadata = { title: "Fallback title", description: "Fallback description", alternates: { canonical: PAGE_URL } };
    expect(mergeSerpMetadata(fallback, null)).toEqual(fallback);
    expect(mergeSerpMetadata(fallback, { title: "Governed title", description: "Governed description" })).toMatchObject({
      title: "Governed title",
      description: "Governed description",
      alternates: { canonical: PAGE_URL },
    });
  });
});
