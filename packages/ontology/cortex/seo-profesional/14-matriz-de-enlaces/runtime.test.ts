import { describe, expect, it, vi } from "vitest";
import {
  CloudflareKvLinkMatrixStore,
  EdgeCompiledLinkMatrix,
  UpstashRedisRestLinkMatrixStore,
  type LinkMatrixRecord,
  type LinkMatrixStorePort,
} from "./runtime.js";

const record: LinkMatrixRecord = {
  version: 3,
  updatedAt: "2026-09-08T12:00:00.000Z",
  links: [
    { href: "/services", label: "Services" },
    { href: "https://example.test/contact?from=matrix#ignored", label: "Contact & Sales" },
  ],
};

function memoryStore(): LinkMatrixStorePort {
  let value: LinkMatrixRecord | null = record;
  return {
    provider: "UPSTASH_REDIS_REST",
    get: async () => value,
    put: async (_key, next) => { value = next; },
  };
}

describe("EdgeCompiledLinkMatrix", () => {
  it("injects bounded same-origin links before HTML delivery", async () => {
    const matrix = new EdgeCompiledLinkMatrix(memoryStore(), "https://example.test");
    const result = await matrix.inject("page:home", "https://example.test/", "<html><body><!-- NEXUS_LINK_MATRIX --></body></html>");
    expect(result.linkCount).toBe(2);
    expect(result.matrixVersion).toBe(3);
    expect(result.html).toContain('href="/services"');
    expect(result.html).toContain('href="/contact?from=matrix"');
    expect(result.html).toContain("Contact &amp; Sales");
  });

  it("rejects cross-origin link injection", async () => {
    const matrix = new EdgeCompiledLinkMatrix(memoryStore(), "https://example.test");
    await expect(matrix.publish("page:home", {
      ...record,
      links: [{ href: "https://spam.example/doorway", label: "Spam" }],
    })).rejects.toThrow(/same-origin/u);
  });

  it("uses Workers KV binding with the configured read cache TTL", async () => {
    const get = vi.fn(async () => JSON.stringify(record));
    const put = vi.fn(async () => undefined);
    const store = new CloudflareKvLinkMatrixStore({ get, put }, 30);
    await expect(store.get("page:home")).resolves.toMatchObject({ version: 3 });
    expect(get).toHaveBeenCalledWith("page:home", { cacheTtl: 30 });
    await store.put("page:home", record);
    expect(put).toHaveBeenCalledOnce();
  });

  it("executes Upstash Redis REST GET/SET commands over authenticated HTTPS", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as string[];
      expect(init?.headers).toMatchObject({ authorization: "Bearer token", "content-type": "application/json" });
      if (command[0] === "GET") return Response.json({ result: JSON.stringify(record) });
      return Response.json({ result: "OK" });
    });
    const store = new UpstashRedisRestLinkMatrixStore({ endpoint: "https://redis.example", tokenProvider: async () => "token", fetchImpl });
    await expect(store.get("page:home")).resolves.toMatchObject({ version: 3 });
    await expect(store.put("page:home", record)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
