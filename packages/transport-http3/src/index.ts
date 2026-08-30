import { createHash } from "node:crypto";

export type HintAs = "style" | "script" | "font" | "image" | "fetch";
export type TransportVerificationStatus = "PASS" | "FAIL" | "UNAVAILABLE";

export interface EarlyHint {
  href: string;
  rel: "preload" | "preconnect";
  as?: HintAs;
  type?: string;
  crossorigin?: "anonymous";
}

export interface TransportPolicy {
  host: string;
  hints: readonly EarlyHint[];
  enableZeroRtt: boolean;
  requireHttp3: true;
  requireEarlyHints103: true;
  requireFinalLinkParity: boolean;
  policyDigest: string;
}

export interface TransportObservation {
  targetUrl: string;
  observedProtocol: string | null;
  observedInterimStatuses: readonly number[];
  earlyHintLinks: readonly string[];
  finalStatus: number | null;
  finalLinks: readonly string[];
  probeAvailable: boolean;
  probeAuthority: "LIVE_NETWORK" | "CONTROLLED_TEST";
}

export interface TransportVerification {
  status: TransportVerificationStatus;
  reasons: readonly string[];
  policyDigest: string;
  observation: TransportObservation;
  evidenceDigest: string;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic object");
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonical JSON requires plain object");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertSafeToken(value: string, label: string): string {
  if (hasControlCharacters(value)) throw new Error(`${label} contains control characters`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

function normalizeHint(hint: EarlyHint): EarlyHint {
  const href = assertSafeToken(hint.href, "hint href");
  if (hint.rel === "preconnect" && !/^https:\/\//i.test(href)) throw new Error("preconnect href must be absolute https URL");
  if (hint.rel === "preload" && !(href.startsWith("/") || /^https:\/\//i.test(href))) throw new Error("preload href must be root-relative or absolute https URL");
  if (hint.rel === "preconnect" && hint.as !== undefined) throw new Error("preconnect must not declare as");
  if (hint.rel === "preload" && hint.as === undefined) throw new Error("preload requires as");
  if (hint.crossorigin !== undefined && hint.crossorigin !== "anonymous") throw new Error("unsupported crossorigin mode");
  const type = hint.type === undefined ? undefined : assertSafeToken(hint.type, "hint type");
  const normalized: EarlyHint = {
    href,
    rel: hint.rel,
    ...(hint.as ? { as: hint.as } : {}),
    ...(type ? { type } : {}),
    ...((hint.as === "font" || hint.crossorigin) ? { crossorigin: "anonymous" as const } : {}),
  };
  return Object.freeze(normalized);
}

export function createTransportPolicy(input: {
  host: string;
  hints: readonly EarlyHint[];
  enableZeroRtt?: boolean;
  requireFinalLinkParity?: boolean;
}): TransportPolicy {
  const host = assertSafeToken(input.host.toLowerCase(), "host");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) throw new Error("invalid DNS host");
  if (input.hints.length > 16) throw new Error("too many early hints");
  const hints = [...input.hints].map(normalizeHint).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const deduped = new Set(hints.map(canonicalJson));
  if (deduped.size !== hints.length) throw new Error("duplicate early hint");
  const core = {
    host,
    hints,
    enableZeroRtt: input.enableZeroRtt ?? false,
    requireHttp3: true as const,
    requireEarlyHints103: true as const,
    requireFinalLinkParity: input.requireFinalLinkParity ?? false,
  };
  return Object.freeze({ ...core, hints: Object.freeze(hints), policyDigest: digestValue(core) });
}

export function serializeLinkHeader(policy: TransportPolicy): string {
  return policy.hints.map((hint) => {
    const parts = [`<${hint.href}>`, `rel=${hint.rel}`];
    if (hint.as) parts.push(`as=${hint.as}`);
    if (hint.type) parts.push(`type=${JSON.stringify(hint.type)}`);
    if (hint.crossorigin) parts.push(`crossorigin=${hint.crossorigin}`);
    return parts.join("; ");
  }).join(", ");
}

export function writeNodeEarlyHints(response: { writeEarlyHints?: (hints: Record<string, string | string[]>) => void }, policy: TransportPolicy): void {
  if (typeof response.writeEarlyHints !== "function") throw new Error("response.writeEarlyHints unavailable");
  const links = policy.hints.map((hint) => serializeLinkHeader(createTransportPolicy({ host: policy.host, hints: [hint], enableZeroRtt: policy.enableZeroRtt })));
  if (links.length > 0) response.writeEarlyHints({ link: links });
}

export function curlHttp3OnlyCommand(url: string): readonly string[] {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("transport probe requires https URL");
  return Object.freeze(["curl", "--http3-only", "--silent", "--show-error", "--dump-header", "-", "--output", "/dev/null", parsed.toString()]);
}

function normalizedProtocol(protocol: string | null): string | null {
  if (protocol === null) return null;
  return protocol.trim().toLowerCase().replace(/^http\//, "");
}

function splitLinkValues(links: readonly string[]): readonly string[] {
  return links.flatMap((line) => line.split(",").map((part) => part.trim()).filter(Boolean));
}

function normalizeParameterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function linkValueMatchesHint(value: string, hint: EarlyHint): boolean {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (parts[0] !== `<${hint.href}>`) return false;
  const parameters = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    parameters.set(part.slice(0, separator).trim().toLowerCase(), normalizeParameterValue(part.slice(separator + 1)));
  }
  if (parameters.get("rel")?.toLowerCase() !== hint.rel) return false;
  if (hint.as !== undefined && parameters.get("as")?.toLowerCase() !== hint.as) return false;
  if (hint.type !== undefined && parameters.get("type") !== hint.type) return false;
  if (hint.crossorigin !== undefined && parameters.get("crossorigin")?.toLowerCase() !== hint.crossorigin) return false;
  return true;
}

function linksContainHint(links: readonly string[], hint: EarlyHint): boolean {
  return splitLinkValues(links).some((value) => linkValueMatchesHint(value, hint));
}

function targetMatchesPolicy(targetUrl: string, host: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

export function verifyTransportObservation(policy: TransportPolicy, observation: TransportObservation): TransportVerification {
  const reasons: string[] = [];
  if (!targetMatchesPolicy(observation.targetUrl, policy.host)) reasons.push("probe target does not match policy host");
  if (!observation.probeAvailable) reasons.push("probe unavailable");
  if (observation.probeAvailable && normalizedProtocol(observation.observedProtocol) !== "3") reasons.push("HTTP/3 not observed");
  if (observation.probeAvailable && !observation.observedInterimStatuses.includes(103)) reasons.push("103 Early Hints not observed");
  if (observation.probeAvailable && (observation.finalStatus === null || observation.finalStatus < 200 || observation.finalStatus >= 400)) reasons.push("successful final response not observed");
  if (observation.probeAvailable) {
    for (const hint of policy.hints) {
      if (!linksContainHint(observation.earlyHintLinks, hint)) reasons.push(`early hint missing or mismatched ${hint.href}`);
      if (policy.requireFinalLinkParity && !linksContainHint(observation.finalLinks, hint)) reasons.push(`final response Link missing or mismatched ${hint.href}`);
    }
  }
  const status: TransportVerificationStatus = !observation.probeAvailable && reasons.every((reason) => reason === "probe unavailable") ? "UNAVAILABLE" : reasons.length === 0 ? "PASS" : "FAIL";
  const core = { status, reasons, policyDigest: policy.policyDigest, observation };
  return Object.freeze({ ...core, reasons: Object.freeze(reasons), evidenceDigest: digestValue(core) });
}

export function validateTransportVerification(policy: TransportPolicy, verification: TransportVerification): void {
  if (verification.policyDigest !== policy.policyDigest) throw new Error("transport verification policy mismatch");
  const replay = verifyTransportObservation(policy, verification.observation);
  if (canonicalJson(replay) !== canonicalJson(verification)) throw new Error("transport verification replay mismatch");
}
