import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type TransportHintAs = "style" | "script" | "font" | "image" | "fetch";

export interface TransportEarlyHint {
  href: string;
  rel: "preload" | "preconnect";
  as?: TransportHintAs;
  type?: string;
  crossorigin?: "anonymous";
}

export interface TransportHttp3Policy {
  authority: "NEXUS_TRANSPORT_HTTP3_POLICY_V1";
  host: string;
  hints: readonly TransportEarlyHint[];
  enableZeroRtt: boolean;
  requireHttp3: true;
  requireEarlyHints103: true;
  policyDigest: string;
}

export interface TransportProbeObservation {
  url: string;
  httpVersion: string | null;
  interimStatuses: readonly number[];
  earlyHintLinks: readonly string[];
  finalStatus: number | null;
  curlExitCode: number;
  stderr: string;
}

export type TransportProbeVerdict = "PASS" | "FAIL" | "UNAVAILABLE";

export interface TransportProbeEvidence {
  authority: "NEXUS_TRANSPORT_HTTP3_EVIDENCE_V1";
  verdict: TransportProbeVerdict;
  reasons: readonly string[];
  policyDigest: string;
  observation: TransportProbeObservation;
  evidenceDigest: string;
}

const MAX_HINTS = 8;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_PROBE_BYTES = 256 * 1024;
const MAX_PROBE_MS = 30_000;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonical");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("only plain objects are canonicalizable");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`undefined is not canonical at ${key}`);
      output[key] = canonicalize(item);
    }
    return output;
  }
  throw new Error(`unsupported canonical value: ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requireSafeHeaderFragment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  if (normalized.length > MAX_HEADER_VALUE_LENGTH) throw new Error(`${label} exceeds maximum length`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters`);
  return normalized;
}

function normalizeHref(href: string, rel: TransportEarlyHint["rel"]): string {
  const normalized = requireSafeHeaderFragment(href, "hint href");
  if (rel === "preconnect") {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("preconnect must be a clean https origin URL");
    if (url.pathname !== "/" || url.search) throw new Error("preconnect must target an origin, not a path/query");
    return url.origin;
  }
  if (normalized.startsWith("/")) {
    if (normalized.startsWith("//")) throw new Error("protocol-relative preload URLs are forbidden");
    return normalized;
  }
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("absolute preload URLs must use clean https URLs");
  return url.toString();
}

function normalizeHint(input: TransportEarlyHint): TransportEarlyHint {
  if (input.rel !== "preload" && input.rel !== "preconnect") throw new Error("unsupported hint relation");
  const href = normalizeHref(input.href, input.rel);
  if (input.as !== undefined && !["style", "script", "font", "image", "fetch"].includes(input.as)) throw new Error("unsupported hint as value");
  if (input.type !== undefined && !TOKEN.test(input.type.replace("/", ""))) throw new Error("invalid hint type");
  if (input.crossorigin !== undefined && input.crossorigin !== "anonymous") throw new Error("unsupported crossorigin value");
  if (input.rel === "preconnect" && (input.as !== undefined || input.type !== undefined)) throw new Error("preconnect cannot declare as/type");
  if (input.rel === "preload" && input.as === undefined) throw new Error("preload requires an as value");
  const crossorigin = input.as === "font" ? "anonymous" : input.crossorigin;
  return Object.freeze({ href, rel: input.rel, ...(input.as ? { as: input.as } : {}), ...(input.type ? { type: input.type } : {}), ...(crossorigin ? { crossorigin } : {}) });
}

function policyCore(policy: Omit<TransportHttp3Policy, "policyDigest">): Omit<TransportHttp3Policy, "policyDigest"> {
  return {
    authority: "NEXUS_TRANSPORT_HTTP3_POLICY_V1",
    host: policy.host,
    hints: policy.hints,
    enableZeroRtt: policy.enableZeroRtt,
    requireHttp3: true,
    requireEarlyHints103: true,
  };
}

export function createTransportHttp3Policy(input: { host: string; hints?: readonly TransportEarlyHint[]; enableZeroRtt?: boolean }): TransportHttp3Policy {
  const host = input.host.trim().toLowerCase();
  if (!HOST.test(host)) throw new Error("invalid transport host");
  const hints = (input.hints ?? []).map(normalizeHint).sort((a, b) => `${a.rel}:${a.href}:${a.as ?? ""}`.localeCompare(`${b.rel}:${b.href}:${b.as ?? ""}`));
  if (hints.length > MAX_HINTS) throw new Error(`at most ${MAX_HINTS} Early Hints are allowed`);
  const identities = new Set<string>();
  for (const hint of hints) {
    const identity = canonicalJson(hint);
    if (identities.has(identity)) throw new Error("duplicate Early Hint");
    identities.add(identity);
  }
  const core = policyCore({
    authority: "NEXUS_TRANSPORT_HTTP3_POLICY_V1",
    host,
    hints: Object.freeze(hints),
    enableZeroRtt: input.enableZeroRtt ?? false,
    requireHttp3: true,
    requireEarlyHints103: true,
  });
  return Object.freeze({ ...core, policyDigest: digest(core) });
}

export function validateTransportHttp3Policy(policy: TransportHttp3Policy): boolean {
  try {
    const rebuilt = createTransportHttp3Policy({ host: policy.host, hints: policy.hints, enableZeroRtt: policy.enableZeroRtt });
    return canonicalJson(rebuilt) === canonicalJson(policy);
  } catch {
    return false;
  }
}

function quoteHeaderParameter(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function transportEarlyHintsLinkHeader(policy: TransportHttp3Policy): string {
  if (!validateTransportHttp3Policy(policy)) throw new Error("invalid transport policy");
  return policy.hints.map((hint) => {
    const parts = [`<${hint.href}>`, `rel=${hint.rel}`];
    if (hint.as) parts.push(`as=${hint.as}`);
    if (hint.type) parts.push(`type=${quoteHeaderParameter(hint.type)}`);
    if (hint.crossorigin) parts.push(`crossorigin=${hint.crossorigin}`);
    return parts.join("; ");
  }).join(", ");
}

export function writeNodeEarlyHints(response: { writeEarlyHints?: (hints: Record<string, string | readonly string[]>) => void }, policy: TransportHttp3Policy): void {
  if (!validateTransportHttp3Policy(policy)) throw new Error("invalid transport policy");
  if (typeof response.writeEarlyHints !== "function") throw new Error("writeEarlyHints is unavailable in this runtime");
  const link = transportEarlyHintsLinkHeader(policy);
  if (link) response.writeEarlyHints({ link });
}

function parseStatus(line: string): { version: string; status: number } | null {
  const match = line.match(/^HTTP\/(\S+)\s+(\d{3})(?:\s|$)/i);
  if (!match) return null;
  return { version: match[1] ?? "", status: Number(match[2]) };
}

export function parseCurlHeaderTranscript(url: string, transcript: string, curlExitCode = 0, stderr = ""): TransportProbeObservation {
  if (Buffer.byteLength(transcript, "utf8") > MAX_PROBE_BYTES) throw new Error("probe transcript exceeds maximum size");
  const blocks = transcript.replaceAll("\r\n", "\n").split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
  const responses: Array<{ version: string; status: number; links: string[] }> = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const status = parseStatus(lines[0] ?? "");
    if (!status) continue;
    const links: string[] = [];
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (name === "link") links.push(value);
    }
    responses.push({ ...status, links });
  }
  const early = responses.filter((response) => response.status === 103);
  const final = [...responses].reverse().find((response) => response.status >= 200) ?? null;
  return Object.freeze({
    url,
    httpVersion: final?.version ?? null,
    interimStatuses: Object.freeze(responses.filter((response) => response.status < 200).map((response) => response.status)),
    earlyHintLinks: Object.freeze(early.flatMap((response) => response.links)),
    finalStatus: final?.status ?? null,
    curlExitCode,
    stderr: stderr.slice(0, 8192),
  });
}

function linkEvidenceContainsHref(linkValues: readonly string[], href: string): boolean {
  return linkValues.some((value) => value.split(",").some((part) => part.trim().startsWith(`<${href}>`)));
}

export function verifyTransportHttp3Observation(policy: TransportHttp3Policy, observation: TransportProbeObservation): TransportProbeEvidence {
  if (!validateTransportHttp3Policy(policy)) throw new Error("invalid transport policy");
  const reasons: string[] = [];
  if (observation.curlExitCode === 127) reasons.push("curl with HTTP/3 support is unavailable");
  else if (observation.curlExitCode !== 0) reasons.push(`curl probe failed with exit code ${observation.curlExitCode}`);
  if (observation.httpVersion === null || !/^3(?:\.|$)/.test(observation.httpVersion)) reasons.push("final response was not observed over HTTP/3");
  if (!observation.interimStatuses.includes(103)) reasons.push("103 Early Hints was not observed");
  if (observation.finalStatus === null || observation.finalStatus < 200 || observation.finalStatus >= 400) reasons.push("successful final HTTP response was not observed");
  for (const hint of policy.hints) {
    if (!linkEvidenceContainsHref(observation.earlyHintLinks, hint.href)) reasons.push(`expected Early Hint was not observed: ${hint.href}`);
  }
  const verdict: TransportProbeVerdict = observation.curlExitCode === 127 ? "UNAVAILABLE" : reasons.length === 0 ? "PASS" : "FAIL";
  const core = {
    authority: "NEXUS_TRANSPORT_HTTP3_EVIDENCE_V1" as const,
    verdict,
    reasons: Object.freeze(reasons),
    policyDigest: policy.policyDigest,
    observation,
  };
  return Object.freeze({ ...core, evidenceDigest: digest(core) });
}

export async function probeTransportHttp3(policy: TransportHttp3Policy, url = `https://${policy.host}/`, options: { curlBinary?: string; timeoutMs?: number } = {}): Promise<TransportProbeEvidence> {
  if (!validateTransportHttp3Policy(policy)) throw new Error("invalid transport policy");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname.toLowerCase() !== policy.host) throw new Error("probe URL must be https and match policy host");
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? MAX_PROBE_MS, MAX_PROBE_MS));
  const curlBinary = options.curlBinary ?? "curl";
  const args = ["--http3-only", "--silent", "--show-error", "--dump-header", "-", "--output", "/dev/null", "--max-time", String(Math.ceil(timeoutMs / 1000)), parsedUrl.toString()];
  const observation = await new Promise<TransportProbeObservation>((resolve, reject) => {
    const child = spawn(curlBinary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve(parseCurlHeaderTranscript(parsedUrl.toString(), "", 127, "curl unavailable"));
      else reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return resolve(parseCurlHeaderTranscript(parsedUrl.toString(), "", 1, "probe output exceeded maximum size"));
      if (signal === "SIGKILL") return resolve(parseCurlHeaderTranscript(parsedUrl.toString(), stdout, 28, "probe timed out"));
      resolve(parseCurlHeaderTranscript(parsedUrl.toString(), stdout, code ?? 1, stderr));
    });
  });
  return verifyTransportHttp3Observation(policy, observation);
}
