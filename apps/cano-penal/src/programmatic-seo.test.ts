import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CANO_PROGRAMMATIC_BASE_URL,
  approvedCanoProgrammaticPages,
} from "./approved-programmatic-seo";
import { readCanoProgrammaticSeoPage } from "./programmatic-seo";

const TOKEN = "bundle-token-00000000000000000000000000000";
const DIGEST = `sha256:${"0".repeat(64)}`;
const TARGET = "delitos-fiscales-y-financieros";

function envelope(mutator?: (pages: Array<Record<string, unknown>>) => void): Record<string, unknown> {
  const pages = approvedCanoProgrammaticPages().map((page) => {
    const path = page.routeSegments.length === 0 ? "/" : `/${page.routeSegments.join("/")}/`;
    const url = new URL(path.slice(1), CANO_PROGRAMMATIC_BASE_URL).toString();
    return {
      pageId: page.pageId,
      routeSegments: [...page.routeSegments],
      title: page.title,
      description: page.description,
      heading: page.heading,
      bodyText: page.bodyText,
      distinctiveStatements: [...page.distinctiveStatements],
      path,
      url,
      canonicalUrl: url,
      indexable: page.indexable,
      updatedAt: page.updatedAt,
      contentDigest: DIGEST,
    } as Record<string, unknown>;
  });
  mutator?.(pages);
  return {
    siteId: "cano-penal",
    published: { revision: 1 },
    bundle: {
      schemaVersion: "cortex-programmatic-seo-bundle-v1",
      siteId: "cano-penal",
      baseUrl: CANO_PROGRAMMATIC_BASE_URL,
      digest: DIGEST,
      pages,
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CANO programmatic SEO bundle consumer", () => {
  it("fails closed before network I/O for absent, unsafe, or unapproved inputs", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_ENDPOINT", "http://control.example.test/v1/programmatic-seo/bundle");
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN", TOKEN);
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();
    expect(await readCanoProgrammaticSeoPage(["areas", "not-approved"])).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts an exact approved bundle and keeps the credential server-side", async () => {
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_ENDPOINT", "https://control.example.test/v1/programmatic-seo/bundle");
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN", TOKEN);
    const calls: Array<Parameters<typeof fetch>> = [];
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => { calls.push(args); return json(envelope()); }));
    const page = await readCanoProgrammaticSeoPage(["areas", TARGET]);
    expect(page).toMatchObject({ pageId: TARGET, path: `/areas/${TARGET}/`, indexable: true });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.protocol).toBe("https:");
    expect(parsed.searchParams.get("siteId")).toBe("cano-penal");
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
  });

  it("rejects the entire bundle when approved content, route inventory, or identity is altered", async () => {
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_ENDPOINT", "https://control.example.test/v1/programmatic-seo/bundle");
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN", TOKEN);

    vi.stubGlobal("fetch", vi.fn(async () => json(envelope((pages) => { pages.find((page) => page.pageId === TARGET)!.title = "Injected title"; }))));
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => json(envelope((pages) => { pages.pop(); }))));
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => json(envelope((pages) => {
      const page = pages.find((item) => item.pageId === TARGET)!;
      page.pageId = "manufactured-landing";
      page.routeSegments = ["areas", "manufactured-landing"];
      page.path = "/areas/manufactured-landing/";
      page.url = "https://canopenal.com/areas/manufactured-landing/";
      page.canonicalUrl = page.url;
    }))));
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();
  });

  it("rejects oversized chunked responses without trusting Content-Length", async () => {
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_ENDPOINT", "https://control.example.test/v1/programmatic-seo/bundle");
    vi.stubEnv("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN", TOKEN);
    const chunk = new Uint8Array(5 * 1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } })));
    expect(await readCanoProgrammaticSeoPage(["areas", TARGET])).toBeNull();
  });
});
