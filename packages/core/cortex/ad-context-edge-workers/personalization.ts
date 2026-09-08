import {
  createAdContextPolicy,
  evaluateAdContext,
  type AdContextDecision,
  type AdContextMode,
  type AdContextPolicy,
  type AdContextPolicyInput,
} from "./index";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_TEXT = 480;
const MAX_BODY = 1_200;
const MAX_BLOCKS = 32;
const MAX_BLOCKS_PER_PROFILE = 8;
const MAX_BULLETS = 8;
const MAX_HREF = 256;
const MAX_CONTROL_RESPONSE_BYTES = 4_096;
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 4_096;
const DEFAULT_CONTROL_TIMEOUT_MS = 350;
const DEFAULT_TELEMETRY_TIMEOUT_MS = 1_000;
const MODES = new Set<AdContextMode>(["ACTIVE", "OBSERVE_ONLY", "KILLED"]);

export interface AdPersonalizationBlockInput {
  readonly blockId: string;
  readonly heading: string;
  readonly body: string;
  readonly bullets?: readonly string[];
}

export interface AdPersonalizationBlock {
  readonly blockId: string;
  readonly heading: string;
  readonly body: string;
  readonly bullets: readonly string[];
}

export interface AdPersonalizationProfileInput {
  readonly experienceId: string;
  readonly headline: string;
  readonly subheadline: string;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  readonly blockOrder: readonly string[];
  readonly layoutProfileId: string;
}

export interface AdPersonalizationProfile extends AdPersonalizationProfileInput {
  readonly blockOrder: readonly string[];
}

export interface AdPersonalizationPolicyInput {
  readonly version: 1;
  readonly languageTag: string;
  readonly adContext: AdContextPolicyInput;
  readonly blocks: readonly AdPersonalizationBlockInput[];
  readonly profiles: readonly AdPersonalizationProfileInput[];
}

export interface AdPersonalizationPolicy {
  readonly version: 1;
  readonly languageTag: string;
  readonly adContext: AdContextPolicy;
  readonly blocks: ReadonlyMap<string, AdPersonalizationBlock>;
  readonly profiles: ReadonlyMap<string, AdPersonalizationProfile>;
}

export interface AdPersonalizationDecision {
  readonly languageTag: string;
  readonly context: AdContextDecision;
  readonly profile: AdPersonalizationProfile;
  readonly blocks: readonly AdPersonalizationBlock[];
}

export interface AdPersonalizationControlConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly telemetryTimeoutMs?: number;
}

export interface AdPersonalizationRuntimeControl {
  readonly mode: AdContextMode;
  readonly source: "REMOTE" | "FAIL_CLOSED";
  readonly revision: number | null;
}

export interface ControlledAdPersonalizationDecision {
  readonly decision: AdPersonalizationDecision;
  readonly control: AdPersonalizationRuntimeControl;
}

interface NormalizedControlConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly telemetryTimeoutMs: number;
}

interface RuntimeControlPayload {
  readonly policyId: string;
  readonly mode: AdContextMode;
  readonly revision: number;
  readonly digest: string;
}

function plain(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) if (!allowedSet.has(key)) throw new Error(`unexpected field ${key}`);
  for (const key of required) if (!(key in record)) throw new Error(`required field ${key} is missing`);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value.trim())) throw new Error(`${field} must be a bounded identifier`);
  return value.trim();
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > max) throw new Error(`${field} must contain 1..${max} characters`);
  for (const character of normalized) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) throw new Error(`${field} contains a control character`);
  }
  return normalized;
}

function languageTag(value: unknown): string {
  if (typeof value !== "string") throw new Error("languageTag must be a string");
  const normalized = value.trim();
  if (!LANGUAGE_TAG.test(normalized)) throw new Error("languageTag must be a bounded BCP-47 language tag");
  return normalized;
}

function internalHref(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes("\\") || normalized.length > MAX_HREF) {
    throw new Error(`${field} must be a bounded root-relative URL`);
  }
  for (const character of normalized) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) throw new Error(`${field} contains a control character`);
  }
  const parsed = new URL(normalized, "https://nexus.invalid");
  if (parsed.origin !== "https://nexus.invalid") throw new Error(`${field} must remain same-origin`);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  const resolved = value === undefined ? fallback : value;
  return typeof resolved === "number" && Number.isSafeInteger(resolved) && resolved >= min && resolved <= max ? resolved : null;
}

export function createAdPersonalizationPolicy(input: AdPersonalizationPolicyInput): AdPersonalizationPolicy {
  const root = plain(input as unknown, "ad personalization policy");
  exact(root, ["version", "languageTag", "adContext", "blocks", "profiles"]);
  if (root.version !== 1) throw new Error("ad personalization policy version must be 1");
  const resolvedLanguageTag = languageTag(root.languageTag);
  const adContext = createAdContextPolicy(root.adContext as AdContextPolicyInput);

  if (!Array.isArray(root.blocks) || root.blocks.length < 1 || root.blocks.length > MAX_BLOCKS) {
    throw new Error(`blocks must contain 1..${MAX_BLOCKS} items`);
  }
  const blocks = new Map<string, AdPersonalizationBlock>();
  for (const [index, value] of root.blocks.entries()) {
    const block = plain(value, `blocks[${index}]`);
    exact(block, ["blockId", "heading", "body", "bullets"], ["blockId", "heading", "body"]);
    const blockId = identifier(block.blockId, `blocks[${index}].blockId`);
    if (blocks.has(blockId)) throw new Error(`duplicate personalization block ${blockId}`);
    const rawBullets = block.bullets ?? [];
    if (!Array.isArray(rawBullets) || rawBullets.length > MAX_BULLETS) throw new Error(`blocks[${index}].bullets must contain 0..${MAX_BULLETS} items`);
    const bullets = rawBullets.map((bullet, bulletIndex) => text(bullet, `blocks[${index}].bullets[${bulletIndex}]`, MAX_TEXT));
    blocks.set(blockId, Object.freeze({
      blockId,
      heading: text(block.heading, `blocks[${index}].heading`),
      body: text(block.body, `blocks[${index}].body`, MAX_BODY),
      bullets: Object.freeze(bullets),
    }));
  }

  if (!Array.isArray(root.profiles) || root.profiles.length < 1 || root.profiles.length > adContext.allowedExperienceIds.length) {
    throw new Error("personalization profiles must contain 1..allowedExperienceIds.length items");
  }
  const profiles = new Map<string, AdPersonalizationProfile>();
  const referencedBlocks = new Set<string>();
  for (const [index, value] of root.profiles.entries()) {
    const profile = plain(value, `profiles[${index}]`);
    exact(profile, ["experienceId", "headline", "subheadline", "ctaLabel", "ctaHref", "blockOrder", "layoutProfileId"]);
    const experienceId = identifier(profile.experienceId, `profiles[${index}].experienceId`);
    if (!adContext.allowedExperienceIds.includes(experienceId)) throw new Error(`profiles[${index}].experienceId must be allowlisted by ad context`);
    if (profiles.has(experienceId)) throw new Error(`duplicate personalization profile ${experienceId}`);
    if (!Array.isArray(profile.blockOrder) || profile.blockOrder.length < 1 || profile.blockOrder.length > MAX_BLOCKS_PER_PROFILE) {
      throw new Error(`profiles[${index}].blockOrder must contain 1..${MAX_BLOCKS_PER_PROFILE} items`);
    }
    const blockOrder = profile.blockOrder.map((blockId, blockIndex) => identifier(blockId, `profiles[${index}].blockOrder[${blockIndex}]`));
    if (new Set(blockOrder).size !== blockOrder.length) throw new Error(`profiles[${index}].blockOrder must be unique`);
    for (const blockId of blockOrder) {
      if (!blocks.has(blockId)) throw new Error(`profiles[${index}].blockOrder references unknown block ${blockId}`);
      referencedBlocks.add(blockId);
    }
    profiles.set(experienceId, Object.freeze({
      experienceId,
      headline: text(profile.headline, `profiles[${index}].headline`),
      subheadline: text(profile.subheadline, `profiles[${index}].subheadline`, MAX_BODY),
      ctaLabel: text(profile.ctaLabel, `profiles[${index}].ctaLabel`),
      ctaHref: internalHref(profile.ctaHref, `profiles[${index}].ctaHref`),
      blockOrder: Object.freeze(blockOrder),
      layoutProfileId: identifier(profile.layoutProfileId, `profiles[${index}].layoutProfileId`),
    }));
  }
  for (const experienceId of adContext.allowedExperienceIds) if (!profiles.has(experienceId)) throw new Error(`missing personalization profile for ${experienceId}`);
  for (const blockId of blocks.keys()) if (!referencedBlocks.has(blockId)) throw new Error(`personalization block ${blockId} is disconnected from every profile`);

  return Object.freeze({ version: 1, languageTag: resolvedLanguageTag, adContext, blocks, profiles });
}

export function personalizeAdContext(input: URL | string, policy: AdPersonalizationPolicy): AdPersonalizationDecision {
  const context = evaluateAdContext(input, policy.adContext);
  const profile = policy.profiles.get(context.experienceId);
  if (!profile) throw new Error(`personalization profile missing for resolved experience ${context.experienceId}`);
  const blocks = profile.blockOrder.map((blockId) => {
    const block = policy.blocks.get(blockId);
    if (!block) throw new Error(`personalization block missing for resolved block ${blockId}`);
    return block;
  });
  return Object.freeze({ languageTag: policy.languageTag, context, profile, blocks: Object.freeze(blocks) });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderPersonalizedLandingDocument(decision: AdPersonalizationDecision): string {
  const profile = decision.profile;
  const blocks = decision.blocks.map((block) => {
    const bullets = block.bullets.length === 0 ? "" : `<ul>${block.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    return `<section data-block="${escapeHtml(block.blockId)}"><h2>${escapeHtml(block.heading)}</h2><p>${escapeHtml(block.body)}</p>${bullets}</section>`;
  }).join("");
  return `<!doctype html><html lang="${escapeHtml(decision.languageTag)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(profile.headline)}</title></head><body data-experience="${escapeHtml(profile.experienceId)}" data-layout="${escapeHtml(profile.layoutProfileId)}"><main><header><h1>${escapeHtml(profile.headline)}</h1><p>${escapeHtml(profile.subheadline)}</p><a data-role="primary-cta" href="${escapeHtml(profile.ctaHref)}">${escapeHtml(profile.ctaLabel)}</a></header>${blocks}</main></body></html>`;
}

function modeRank(mode: AdContextMode): number {
  return mode === "ACTIVE" ? 0 : mode === "OBSERVE_ONLY" ? 1 : 2;
}

export function mostRestrictiveAdPersonalizationMode(left: AdContextMode, right: AdContextMode): AdContextMode {
  return modeRank(left) >= modeRank(right) ? left : right;
}

function normalizedControlConfig(config: AdPersonalizationControlConfig | null): NormalizedControlConfig | null {
  if (!config || typeof config.endpoint !== "string" || typeof config.token !== "string") return null;
  const token = config.token.trim();
  const tokenBytes = new TextEncoder().encode(token).byteLength;
  if (tokenBytes < MIN_TOKEN_BYTES || tokenBytes > MAX_TOKEN_BYTES) return null;
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint.trim()); }
  catch { return null; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  const timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_CONTROL_TIMEOUT_MS, 50, 2_000);
  const telemetryTimeoutMs = boundedInteger(config.telemetryTimeoutMs, DEFAULT_TELEMETRY_TIMEOUT_MS, 50, 5_000);
  if (timeoutMs === null || telemetryTimeoutMs === null) return null;
  return Object.freeze({ baseUrl: endpoint.toString().replace(/\/$/u, ""), token, timeoutMs, telemetryTimeoutMs });
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES) return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      output += decoder.decode(next.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function runtimeControlPayload(value: unknown): RuntimeControlPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["policyId", "mode", "revision", "digest"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || Object.keys(record).length !== allowed.size) return null;
  if (typeof record.policyId !== "string" || !ID.test(record.policyId)) return null;
  if (typeof record.mode !== "string" || !MODES.has(record.mode as AdContextMode)) return null;
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) return null;
  if (typeof record.digest !== "string" || !DIGEST.test(record.digest)) return null;
  return Object.freeze({ policyId: record.policyId, mode: record.mode as AdContextMode, revision: record.revision, digest: record.digest });
}

export async function resolveAdPersonalizationRuntimeControl(
  policy: AdPersonalizationPolicy,
  config: AdPersonalizationControlConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AdPersonalizationRuntimeControl> {
  const normalized = normalizedControlConfig(config);
  if (!normalized) return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalized.timeoutMs);
  try {
    const response = await fetchImpl(`${normalized.baseUrl}/v1/ad-context/runtime`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { authorization: `Bearer ${normalized.token}`, accept: "application/json" },
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
    }
    const raw = await boundedResponseText(response);
    if (raw === null) return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null }); }
    const payload = runtimeControlPayload(parsed);
    if (!payload || payload.policyId !== policy.adContext.policyId) return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
    return Object.freeze({
      mode: mostRestrictiveAdPersonalizationMode(policy.adContext.mode, payload.mode),
      source: "REMOTE",
      revision: payload.revision,
    });
  } catch {
    return Object.freeze({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
  } finally {
    clearTimeout(timeout);
  }
}

function withRuntimeMode(policy: AdPersonalizationPolicy, mode: AdContextMode): AdPersonalizationPolicy {
  return Object.freeze({ ...policy, adContext: Object.freeze({ ...policy.adContext, mode }) });
}

export async function personalizeAdContextWithControl(
  input: URL | string,
  policy: AdPersonalizationPolicy,
  config: AdPersonalizationControlConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ControlledAdPersonalizationDecision> {
  const control = await resolveAdPersonalizationRuntimeControl(policy, config, fetchImpl);
  const decision = personalizeAdContext(input, withRuntimeMode(policy, control.mode));
  return Object.freeze({ decision, control });
}

export async function recordAdPersonalizationDecision(
  decision: AdPersonalizationDecision,
  config: AdPersonalizationControlConfig | null,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<void> {
  const normalized = normalizedControlConfig(config);
  if (!normalized) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalized.telemetryTimeoutMs);
  try {
    const response = await fetchImpl(`${normalized.baseUrl}/v1/ad-context/observe`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { authorization: `Bearer ${normalized.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        policyId: decision.context.policyId,
        mode: decision.context.mode,
        channel: decision.context.channel,
        reason: decision.context.reason,
        applied: decision.context.applied,
        observedAt: now().toISOString(),
      }),
    });
    if (response.body) {
      try { await response.body.cancel(); } catch { /* telemetry response body is non-authoritative */ }
    }
  } catch {
    // Telemetry is non-authoritative and cannot change the served experience.
  } finally {
    clearTimeout(timeout);
  }
}
