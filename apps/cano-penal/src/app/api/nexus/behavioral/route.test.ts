import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const previousEndpoint = process.env.NEXUS_CORTEX_BEHAVIORAL_ENDPOINT;
const previousToken = process.env.NEXUS_CORTEX_BEHAVIORAL_INGEST_TOKEN;

function configure(): void {
  process.env.NEXUS_CORTEX_BEHAVIORAL_ENDPOINT = "https://behavioral.example.test/v1/behavioral/ingest";
  process.env.NEXUS_CORTEX_BEHAVIORAL_INGEST_TOKEN = "ingest-token-00000000000000000000000000000001";
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousEndpoint === undefined) delete process.env.NEXUS_CORTEX_BEHAVIORAL_ENDPOINT;
  else process.env.NEXUS_CORTEX_BEHAVIORAL_ENDPOINT = previousEndpoint;
  if (previousToken === undefined) delete process.env.NEXUS_CORTEX_BEHAVIORAL_INGEST_TOKEN;
  else process.env.NEXUS_CORTEX_BEHAVIORAL_INGEST_TOKEN = previousToken;
});

describe("CANO behavioral same-origin proxy", () => {
  it("rejects an oversized streaming body before contacting CORTEX when Content-Length is absent", async () => {
    configure();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const request = new Request("https://cano.test/api/nexus/behavioral", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://cano.test",
      },
      body: "x".repeat(16_385),
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await POST(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "BODY_TOO_LARGE" });
    expect(upstream).not.toHaveBeenCalled();
  });
});
