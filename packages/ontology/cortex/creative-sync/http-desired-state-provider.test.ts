import { describe, expect, it, vi } from "vitest";
import {
  CreativeDesiredStateTransportError,
  HttpCreativeDesiredStateProvider,
} from "./http-desired-state-provider";

const TOKEN = "t".repeat(40);
const CUSTOMER = "1234567890";
const desired = {
  sourceId: "catalog",
  sourceVersion: "v1",
  observedAt: "2026-09-05T00:00:00.000Z",
  customizerAttributes: [],
  customizerValues: [],
  responsiveSearchAds: [],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("HttpCreativeDesiredStateProvider", () => {
  it("posts only customer identity to a credential-free HTTPS endpoint with bearer auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(desired));
    const provider = new HttpCreativeDesiredStateProvider({
      endpoint: "https://inventory.example.test/cortex/creative-state",
      bearerToken: TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(provider.getDesiredState(CUSTOMER)).resolves.toEqual(desired);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://inventory.example.test/cortex/creative-state");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ customerId: CUSTOMER }));
  });

  it.each([
    "http://inventory.example.test/state",
    "https://user:pass@inventory.example.test/state",
    "https://inventory.example.test/state#fragment",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => new HttpCreativeDesiredStateProvider({ endpoint, bearerToken: TOKEN })).toThrow(CreativeDesiredStateTransportError);
  });

  it("rejects malformed customer IDs before transport", async () => {
    const fetchImpl = vi.fn();
    const provider = new HttpCreativeDesiredStateProvider({
      endpoint: "https://inventory.example.test/state",
      bearerToken: TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(provider.getDesiredState("123-abc")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on non-2xx, non-JSON, malformed JSON and oversized bodies", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: "no" }, { status: 503 }),
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      async () => new Response(`"${"x".repeat(256 * 1024)}"`, { status: 200, headers: { "content-type": "application/json" } }),
    ];

    for (const makeResponse of cases) {
      const provider = new HttpCreativeDesiredStateProvider({
        endpoint: "https://inventory.example.test/state",
        bearerToken: TOKEN,
        fetchImpl: (async () => makeResponse()) as typeof fetch,
      });
      await expect(provider.getDesiredState(CUSTOMER)).rejects.toBeInstanceOf(CreativeDesiredStateTransportError);
    }
  });

  it("maps aborted transport to TIMEOUT without leaking the underlying error", async () => {
    const provider = new HttpCreativeDesiredStateProvider({
      endpoint: "https://inventory.example.test/state",
      bearerToken: TOKEN,
      timeoutMs: 1_000,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        const init = args[1];
        await new Promise<void>((resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          void resolve;
        });
        throw new Error("unreachable");
      }) as typeof fetch,
    });

    vi.useFakeTimers();
    try {
      const pending = provider.getDesiredState(CUSTOMER);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", message: "desired-state endpoint timed out" });
    } finally {
      vi.useRealTimers();
    }
  });
});
