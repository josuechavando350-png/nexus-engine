export type DynamicRagPlatform = "CLOUDFLARE" | "VERCEL";

export type DynamicRagGroundingStatus =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "CONFLICTED"
  | "UNSUPPORTED";

export interface DynamicRagSource {
  readonly id: string;
  readonly text: string;
  readonly confidence: number;
}

export interface DynamicRagGrounding {
  readonly status: DynamicRagGroundingStatus;
  readonly digest: string;
  readonly facts: readonly DynamicRagSource[];
  readonly instructions: readonly string[];
}

export interface DynamicRagGroundingPort {
  ground(input: Readonly<{
    userMessage: string;
    maxFacts: number;
    signal: AbortSignal;
  }>): Promise<DynamicRagGrounding>;
}

export interface EdgeInferencePort {
  readonly provider: "CLOUDFLARE_WORKERS_AI" | "OPENAI_COMPATIBLE_HTTP";
  infer(
    input: Readonly<{
      system: string;
      user: string;
      maxTokens: number;
      temperature: number;
    }>,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface DynamicRagPolicyInput {
  readonly operatorWebsiteOrigin: string;
  readonly platform: DynamicRagPlatform;
  readonly maxQueryBytes?: number;
  readonly maxContextBytes?: number;
  readonly maxFacts?: number;
  readonly maxAnswerBytes?: number;
  readonly maxTokens?: number;
}

export interface DynamicRagPolicy {
  readonly operatorWebsiteOrigin: string;
  readonly platform: DynamicRagPlatform;
  readonly maxQueryBytes: number;
  readonly maxContextBytes: number;
  readonly maxFacts: number;
  readonly maxAnswerBytes: number;
  readonly maxTokens: number;
  readonly version: "seo12-dynamic-rag-v1";
}

export interface DynamicRagResult {
  readonly status: "ANSWERED" | "UNSUPPORTED" | "CONFLICTED";
  readonly answer: string;
  readonly sourceIds: readonly string[];
  readonly groundingDigest: string;
  readonly inferenceProvider: EdgeInferencePort["provider"] | null;
}

export class DynamicRagError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "IDENTITY_MISMATCH"
      | "GROUNDING_FAILURE"
      | "INFERENCE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "DynamicRagError";
  }
}

const enc = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/u;

function bytes(value: string): number {
  return enc.encode(value).byteLength;
}

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DynamicRagError("INVALID_CONFIG", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function bareHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DynamicRagError("INVALID_CONFIG", "operatorWebsiteOrigin must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new DynamicRagError("INVALID_CONFIG", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

export function createDynamicRagPolicy(input: DynamicRagPolicyInput): DynamicRagPolicy {
  if (!input || typeof input !== "object") throw new DynamicRagError("INVALID_CONFIG", "RAG policy is required");
  if (input.platform !== "CLOUDFLARE" && input.platform !== "VERCEL") {
    throw new DynamicRagError("INVALID_CONFIG", "platform must be CLOUDFLARE or VERCEL");
  }
  return Object.freeze({
    operatorWebsiteOrigin: bareHttpsOrigin(input.operatorWebsiteOrigin),
    platform: input.platform,
    maxQueryBytes: integer(input.maxQueryBytes ?? 4_096, "maxQueryBytes", 64, 16_384),
    maxContextBytes: integer(input.maxContextBytes ?? 32_768, "maxContextBytes", 1_024, 131_072),
    maxFacts: integer(input.maxFacts ?? 24, "maxFacts", 1, 100),
    maxAnswerBytes: integer(input.maxAnswerBytes ?? 8_192, "maxAnswerBytes", 128, 32_768),
    maxTokens: integer(input.maxTokens ?? 768, "maxTokens", 64, 4_096),
    version: "seo12-dynamic-rag-v1" as const,
  });
}

function parseModelJson(raw: string, allowedSourceIds: ReadonlySet<string>, policy: DynamicRagPolicy): Readonly<{ answer: string; sourceIds: readonly string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DynamicRagError("INFERENCE_FAILURE", "inference output must be strict JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DynamicRagError("INFERENCE_FAILURE", "inference output must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.answer !== "string" || !record.answer.trim() || bytes(record.answer) > policy.maxAnswerBytes) {
    throw new DynamicRagError("INFERENCE_FAILURE", "inference answer is empty or exceeds the configured limit");
  }
  if (!Array.isArray(record.sourceIds) || !record.sourceIds.every((value) => typeof value === "string" && ID.test(value))) {
    throw new DynamicRagError("INFERENCE_FAILURE", "inference sourceIds are malformed");
  }
  const sourceIds = [...new Set(record.sourceIds as string[])];
  if (!sourceIds.length || sourceIds.some((id) => !allowedSourceIds.has(id))) {
    throw new DynamicRagError("INFERENCE_FAILURE", "inference cited a source that is not present in the grounding context");
  }
  return Object.freeze({ answer: record.answer.trim(), sourceIds: Object.freeze(sourceIds) });
}

function contextText(grounding: DynamicRagGrounding, policy: DynamicRagPolicy): string {
  const lines: string[] = [];
  let consumed = 0;
  for (const fact of grounding.facts) {
    if (!ID.test(fact.id) || typeof fact.text !== "string" || !Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) {
      throw new DynamicRagError("GROUNDING_FAILURE", "grounding returned a malformed fact");
    }
    const line = `[${fact.id}] confidence=${fact.confidence.toFixed(3)} ${fact.text.replace(/\s+/gu, " ").trim()}`;
    const lineBytes = bytes(line) + 1;
    if (consumed + lineBytes > policy.maxContextBytes) break;
    lines.push(line);
    consumed += lineBytes;
  }
  return lines.join("\n");
}

export class DynamicHeadlessEdgeRagEngine {
  readonly policy: DynamicRagPolicy;
  private readonly grounding: DynamicRagGroundingPort;
  private readonly inference: EdgeInferencePort;

  constructor(
    input: Readonly<{
      policy: DynamicRagPolicyInput;
      grounding: DynamicRagGroundingPort;
      inference: EdgeInferencePort;
    }>,
  ) {
    if (!input?.grounding || typeof input.grounding.ground !== "function" || !input.inference || typeof input.inference.infer !== "function") {
      throw new DynamicRagError("INVALID_CONFIG", "RAG grounding and inference ports are required");
    }
    this.policy = createDynamicRagPolicy(input.policy);
    this.grounding = input.grounding;
    this.inference = input.inference;
  }

  identity() {
    return Object.freeze({
      strategy: 12 as const,
      provider: "DYNAMIC_HEADLESS_EDGE_RAG" as const,
      platform: this.policy.platform,
      inferenceProvider: this.inference.provider,
      operatorWebsiteOrigin: this.policy.operatorWebsiteOrigin,
    });
  }

  async answer(userMessageInput: string, signal: AbortSignal = new AbortController().signal): Promise<DynamicRagResult> {
    const userMessage = userMessageInput.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!userMessage || bytes(userMessage) > this.policy.maxQueryBytes) {
      throw new DynamicRagError("INVALID_INPUT", "RAG query is empty or exceeds the configured limit");
    }
    const grounding = await this.grounding.ground({ userMessage, maxFacts: this.policy.maxFacts, signal });
    if (!grounding || typeof grounding.digest !== "string" || !grounding.digest.trim()) {
      throw new DynamicRagError("GROUNDING_FAILURE", "grounding did not return a verifiable digest");
    }
    if (grounding.status === "CONFLICTED") {
      return Object.freeze({
        status: "CONFLICTED" as const,
        answer: "The verified knowledge sources conflict, so this request requires operator review.",
        sourceIds: Object.freeze([]),
        groundingDigest: grounding.digest,
        inferenceProvider: null,
      });
    }
    if (grounding.status === "UNSUPPORTED" || grounding.facts.length === 0) {
      return Object.freeze({
        status: "UNSUPPORTED" as const,
        answer: "No verified source currently supports this answer.",
        sourceIds: Object.freeze([]),
        groundingDigest: grounding.digest,
        inferenceProvider: null,
      });
    }

    const context = contextText(grounding, this.policy);
    if (!context) throw new DynamicRagError("GROUNDING_FAILURE", "grounding produced no usable bounded context");
    const allowed = new Set(grounding.facts.map((fact) => fact.id));
    const system = [
      "You are a grounded first-party assistant.",
      "Use only the supplied verified facts.",
      "Never invent prices, availability, guarantees, credentials, policies, deadlines or outcomes.",
      "Return strict JSON only: {\"answer\":\"...\",\"sourceIds\":[\"fact-id\"]}.",
      "Every factual answer must cite at least one supplied fact id.",
      ...grounding.instructions,
    ].join("\n");

    let raw: string;
    try {
      raw = await this.inference.infer(
        { system, user: `QUESTION:\n${userMessage}\n\nVERIFIED FACTS:\n${context}`, maxTokens: this.policy.maxTokens, temperature: 0 },
        signal,
      );
    } catch (error) {
      if (error instanceof DynamicRagError) throw error;
      throw new DynamicRagError("INFERENCE_FAILURE", `inference failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const parsed = parseModelJson(raw, allowed, this.policy);
    return Object.freeze({
      status: "ANSWERED" as const,
      answer: parsed.answer,
      sourceIds: parsed.sourceIds,
      groundingDigest: grounding.digest,
      inferenceProvider: this.inference.provider,
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.policy.operatorWebsiteOrigin) {
      throw new DynamicRagError("IDENTITY_MISMATCH", "RAG request origin does not match the operator origin");
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400, headers: { "cache-control": "private, no-store" } });
    }
    const query = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).query : null;
    if (typeof query !== "string") {
      return Response.json({ error: "INVALID_QUERY" }, { status: 400, headers: { "cache-control": "private, no-store" } });
    }
    try {
      const result = await this.answer(query, request.signal);
      return Response.json(result, { status: 200, headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      if (error instanceof DynamicRagError && error.code === "INVALID_INPUT") {
        return Response.json({ error: error.code }, { status: 400, headers: { "cache-control": "private, no-store" } });
      }
      throw error;
    }
  }
}

export interface CloudflareWorkersAiBinding {
  run(model: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class CloudflareWorkersAiInference implements EdgeInferencePort {
  readonly provider = "CLOUDFLARE_WORKERS_AI" as const;

  constructor(
    private readonly ai: CloudflareWorkersAiBinding,
    private readonly model: string,
  ) {
    if (!ai || typeof ai.run !== "function" || !model.trim()) {
      throw new DynamicRagError("INVALID_CONFIG", "Workers AI binding and model are required");
    }
  }

  async infer(input: Parameters<EdgeInferencePort["infer"]>[0], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const response = await this.ai.run(this.model, {
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      max_tokens: input.maxTokens,
      temperature: input.temperature,
    });
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (typeof response === "string") return response;
    if (response && typeof response === "object") {
      const record = response as Record<string, unknown>;
      if (typeof record.response === "string") return record.response;
      if (typeof record.result === "string") return record.result;
    }
    throw new DynamicRagError("INFERENCE_FAILURE", "Workers AI returned an unsupported response shape");
  }
}

export class OpenAiCompatibleEdgeInference implements EdgeInferencePort {
  readonly provider = "OPENAI_COMPATIBLE_HTTP" as const;
  private readonly endpoint: URL;
  private readonly model: string;
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    input: Readonly<{
      endpoint: string;
      model: string;
      tokenProvider: () => Promise<string>;
      fetchImpl?: typeof fetch;
    }>,
  ) {
    this.endpoint = new URL(input.endpoint);
    if (this.endpoint.protocol !== "https:" || this.endpoint.username || this.endpoint.password || !input.model.trim() || typeof input.tokenProvider !== "function") {
      throw new DynamicRagError("INVALID_CONFIG", "inference endpoint/model/tokenProvider are invalid");
    }
    this.model = input.model;
    this.tokenProvider = input.tokenProvider;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async infer(input: Parameters<EdgeInferencePort["infer"]>[0], signal: AbortSignal): Promise<string> {
    const token = (await this.tokenProvider()).trim();
    if (!token) throw new DynamicRagError("INVALID_CONFIG", "inference bearer token is empty");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!response.ok) throw new DynamicRagError("INFERENCE_FAILURE", `inference endpoint returned HTTP ${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new DynamicRagError("INFERENCE_FAILURE", "inference endpoint returned no message content");
    return content;
  }
}
