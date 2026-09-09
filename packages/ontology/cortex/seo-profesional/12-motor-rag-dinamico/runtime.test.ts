import { describe, expect, it, vi } from "vitest";
import {
  CloudflareWorkersAiInference,
  DynamicHeadlessEdgeRagEngine,
  OpenAiCompatibleEdgeInference,
  type DynamicRagGroundingPort,
  type EdgeInferencePort,
} from "./runtime.js";

const grounding = (status: "SUPPORTED" | "CONFLICTED" | "UNSUPPORTED" = "SUPPORTED"): DynamicRagGroundingPort => ({
  ground: async () => ({
    status,
    digest: "sha256:grounding",
    facts: status === "SUPPORTED" ? [{ id: "fact:hours", text: "The office opens at 09:00.", confidence: 0.99 }] : [],
    instructions: ["Do not guess."],
  }),
});

describe("DynamicHeadlessEdgeRagEngine", () => {
  it("answers only from grounded source ids", async () => {
    const inference: EdgeInferencePort = {
      provider: "OPENAI_COMPATIBLE_HTTP",
      infer: async () => JSON.stringify({ answer: "It opens at 09:00.", sourceIds: ["fact:hours"] }),
    };
    const engine = new DynamicHeadlessEdgeRagEngine({ policy: { operatorWebsiteOrigin: "https://example.test", platform: "VERCEL" }, grounding: grounding(), inference });
    await expect(engine.answer("When do you open?")).resolves.toEqual({
      status: "ANSWERED",
      answer: "It opens at 09:00.",
      sourceIds: ["fact:hours"],
      groundingDigest: "sha256:grounding",
      inferenceProvider: "OPENAI_COMPATIBLE_HTTP",
    });
  });

  it("does not invoke inference for unsupported or conflicted knowledge", async () => {
    const infer = vi.fn(async () => JSON.stringify({ answer: "invented", sourceIds: ["x"] }));
    for (const status of ["UNSUPPORTED", "CONFLICTED"] as const) {
      const engine = new DynamicHeadlessEdgeRagEngine({
        policy: { operatorWebsiteOrigin: "https://example.test", platform: "CLOUDFLARE" },
        grounding: grounding(status),
        inference: { provider: "CLOUDFLARE_WORKERS_AI", infer },
      });
      const result = await engine.answer("Unknown?");
      expect(result.status).toBe(status);
    }
    expect(infer).not.toHaveBeenCalled();
  });

  it("rejects hallucinated citations", async () => {
    const engine = new DynamicHeadlessEdgeRagEngine({
      policy: { operatorWebsiteOrigin: "https://example.test", platform: "VERCEL" },
      grounding: grounding(),
      inference: { provider: "OPENAI_COMPATIBLE_HTTP", infer: async () => JSON.stringify({ answer: "No source.", sourceIds: ["fact:invented"] }) },
    });
    await expect(engine.answer("When?")).rejects.toThrow(/not present in the grounding/u);
  });

  it("uses the Cloudflare Workers AI binding through env.AI.run-compatible semantics", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify({ answer: "Grounded.", sourceIds: ["fact:hours"] }) }));
    const inference = new CloudflareWorkersAiInference({ run }, "@cf/meta/llama-3.1-8b-instruct");
    await expect(inference.infer({ system: "s", user: "u", maxTokens: 64, temperature: 0 }, new AbortController().signal))
      .resolves.toContain("Grounded");
    expect(run).toHaveBeenCalledOnce();
  });

  it("uses an HTTPS OpenAI-compatible inference endpoint without exposing the token in the body", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret", "content-type": "application/json" });
      expect(String(init?.body)).not.toContain("secret");
      return Response.json({ choices: [{ message: { content: "{\"answer\":\"ok\",\"sourceIds\":[\"fact:hours\"]}" } }] });
    });
    const inference = new OpenAiCompatibleEdgeInference({
      endpoint: "https://inference.example/v1/chat/completions",
      model: "local-small",
      tokenProvider: async () => "secret",
      fetchImpl,
    });
    await expect(inference.infer({ system: "s", user: "u", maxTokens: 64, temperature: 0 }, new AbortController().signal))
      .resolves.toContain("\"answer\"");
  });

  it("materializes a framework-neutral POST handler and keeps RAG responses private", async () => {
    const engine = new DynamicHeadlessEdgeRagEngine({
      policy: { operatorWebsiteOrigin: "https://example.test", platform: "VERCEL" },
      grounding: grounding(),
      inference: { provider: "OPENAI_COMPATIBLE_HTTP", infer: async () => JSON.stringify({ answer: "09:00", sourceIds: ["fact:hours"] }) },
    });
    const response = await engine.handle(new Request("https://example.test/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Hours?" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
