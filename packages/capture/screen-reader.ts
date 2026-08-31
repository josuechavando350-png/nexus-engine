import { createHash, randomBytes } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { MeasurementScope } from "../measurement/index.js";

export type ScreenReaderKind = "NVDA" | "JAWS" | "VOICEOVER";
export type ScreenReaderEvidenceStatus = "OBSERVED" | "UNAVAILABLE" | "NOT_VERIFIED" | "SYNTHETIC";
export type ScreenReaderEventKind = "SPEECH" | "FOCUS" | "BRAILLE" | "NAVIGATION";

export interface ScreenReaderEvent {
  readonly kind: ScreenReaderEventKind;
  readonly at: string;
  readonly text: string;
  readonly role?: string;
}

export interface ScreenReaderObservationRequest {
  readonly scope: MeasurementScope;
  readonly targetUrl: string;
  readonly signal?: AbortSignal;
}

export interface ScreenReaderEvidence {
  readonly authority: "NEXUS_SCREEN_READER_EVIDENCE_V1";
  readonly scope: MeasurementScope;
  readonly targetUrl: string;
  readonly reader: ScreenReaderKind;
  readonly status: ScreenReaderEvidenceStatus;
  readonly observedAt: string;
  readonly platform: string;
  readonly readerVersion: string | null;
  readonly harness: Readonly<{
    protocolVersion: "1";
    executableDigest: string;
  }> | null;
  readonly session: Readonly<{
    nativeSession: boolean;
    synthetic: boolean;
  }>;
  readonly events: readonly ScreenReaderEvent[];
  readonly reason?: string;
  readonly evidenceDigest: string;
}

interface HarnessRequestEnvelope {
  readonly protocolVersion: "1";
  readonly reader: ScreenReaderKind;
  readonly challenge: string;
  readonly scope: MeasurementScope;
  readonly targetUrl: string;
}

interface HarnessResponseEnvelope {
  readonly protocolVersion: "1";
  readonly reader: ScreenReaderKind;
  readonly challenge: string;
  readonly scope: MeasurementScope;
  readonly targetUrl: string;
  readonly status: ScreenReaderEvidenceStatus;
  readonly observedAt: string;
  readonly platform: string;
  readonly readerVersion: string | null;
  readonly nativeSession: boolean;
  readonly synthetic: boolean;
  readonly events: readonly ScreenReaderEvent[];
  readonly reason?: string;
}

export interface ScreenReaderHarnessOptions {
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ScreenReaderAdapterOptions extends ScreenReaderHarnessOptions {
  readonly challengeFactory?: () => string;
}

const MAX_EVENTS = 1_000;
const MAX_TEXT = 2_048;
const MAX_ROLE = 128;
const MAX_REASON = 1_024;
const MAX_ARG_COUNT = 64;
const MAX_ARG_LENGTH = 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CHALLENGE = /^[a-f0-9]{32,128}$/u;

function safeText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${field} contains control characters`);
  }
  return trimmed;
}

function safeScope(scope: MeasurementScope): MeasurementScope {
  return Object.freeze({
    tenantId: safeText(scope.tenantId, "scope.tenantId", 128),
    brandId: safeText(scope.brandId, "scope.brandId", 128),
  });
}

function canonicalUrl(value: string): string {
  const parsed = new URL(safeText(value, "targetUrl", 2_048));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("targetUrl must use http or https");
  if (parsed.username || parsed.password) throw new Error("targetUrl cannot contain credentials");
  parsed.hash = "";
  return parsed.toString();
}

function canonicalTimestamp(value: string, field = "observedAt"): string {
  const text = safeText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) throw new Error(`${field} must be canonical ISO-8601 UTC`);
  return text;
}

function boundedInteger(value: number | undefined, fallback: number, field: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return resolved;
}

function canonicalize(value: unknown, seen = new WeakSet<object>(), depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 64) throw new Error("screen reader canonical JSON exceeds depth budget");
  budget.nodes += 1;
  if (budget.nodes > 20_000) throw new Error("screen reader canonical JSON exceeds node budget");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("screen reader canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("screen reader canonical JSON rejects cyclic values");
    seen.add(value);
    const output = value.map((item) => canonicalize(item, seen, depth + 1, budget));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("screen reader canonical JSON rejects cyclic values");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("screen reader canonical JSON requires plain objects");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`unsafe screen reader object key ${key}`);
      const item = object[key];
      if (item === undefined) throw new Error(`screen reader canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen, depth + 1, budget);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`screen reader canonical JSON rejects ${typeof value}`);
}

export function screenReaderCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function screenReaderDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(screenReaderCanonicalJson(value)).digest("hex")}`;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function evidenceCore(input: Omit<ScreenReaderEvidence, "evidenceDigest">): ScreenReaderEvidence {
  const frozen = Object.freeze({ ...input });
  return Object.freeze({ ...frozen, evidenceDigest: screenReaderDigest(frozen) });
}

function unavailableEvidence(reader: ScreenReaderKind, scope: MeasurementScope, targetUrl: string, reason: string): ScreenReaderEvidence {
  return evidenceCore({
    authority: "NEXUS_SCREEN_READER_EVIDENCE_V1",
    scope,
    targetUrl,
    reader,
    status: "UNAVAILABLE",
    observedAt: new Date().toISOString(),
    platform: process.platform,
    readerVersion: null,
    harness: null,
    session: Object.freeze({ nativeSession: false, synthetic: false }),
    events: Object.freeze([]),
    reason: safeText(reason, "reason", MAX_REASON),
  });
}

function normalizeEvents(value: unknown): readonly ScreenReaderEvent[] {
  if (!Array.isArray(value)) throw new Error("events must be an array");
  if (value.length > MAX_EVENTS) throw new Error(`events exceeds ${MAX_EVENTS}`);
  return Object.freeze(value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`events[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const kind = safeText(item.kind, `events[${index}].kind`, 32) as ScreenReaderEventKind;
    if (!["SPEECH", "FOCUS", "BRAILLE", "NAVIGATION"].includes(kind)) throw new Error(`events[${index}].kind is unsupported`);
    const role = item.role === undefined ? undefined : safeText(item.role, `events[${index}].role`, MAX_ROLE);
    return Object.freeze({
      kind,
      at: canonicalTimestamp(safeText(item.at, `events[${index}].at`, 64), `events[${index}].at`),
      text: safeText(item.text, `events[${index}].text`, MAX_TEXT),
      ...(role === undefined ? {} : { role }),
    });
  }));
}

function parseHarnessResponse(raw: string): HarnessResponseEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("screen reader harness returned invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("screen reader harness response must be an object");
  const object = parsed as Record<string, unknown>;
  const reader = safeText(object.reader, "response.reader", 32) as ScreenReaderKind;
  if (!["NVDA", "JAWS", "VOICEOVER"].includes(reader)) throw new Error("response.reader is unsupported");
  const status = safeText(object.status, "response.status", 32) as ScreenReaderEvidenceStatus;
  if (!["OBSERVED", "UNAVAILABLE", "NOT_VERIFIED", "SYNTHETIC"].includes(status)) throw new Error("response.status is unsupported");
  if (object.scope === null || typeof object.scope !== "object" || Array.isArray(object.scope)) throw new Error("response.scope must be an object");
  return Object.freeze({
    protocolVersion: safeText(object.protocolVersion, "response.protocolVersion", 8) as "1",
    reader,
    challenge: safeText(object.challenge, "response.challenge", 128),
    scope: safeScope(object.scope as MeasurementScope),
    targetUrl: canonicalUrl(safeText(object.targetUrl, "response.targetUrl", 2_048)),
    status,
    observedAt: canonicalTimestamp(safeText(object.observedAt, "response.observedAt", 64)),
    platform: safeText(object.platform, "response.platform", 64),
    readerVersion: object.readerVersion === undefined || object.readerVersion === null ? null : safeText(object.readerVersion, "response.readerVersion", 128),
    nativeSession: object.nativeSession === true,
    synthetic: object.synthetic === true,
    events: normalizeEvents(object.events ?? []),
    reason: object.reason === undefined ? undefined : safeText(object.reason, "response.reason", MAX_REASON),
  });
}

async function executableDigest(executable: string): Promise<string> {
  const bytes = await readFile(executable);
  return digestBytes(bytes);
}

async function validateExecutable(executable: string): Promise<string> {
  const path = resolve(safeText(executable, "harness executable", 4_096));
  if (!isAbsolute(path)) throw new Error("screen reader harness executable must resolve to an absolute path");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("screen reader harness executable must be a regular file");
  if (process.platform !== "win32") await access(path, fsConstants.X_OK);
  return path;
}

function safeArgs(args: readonly string[] | undefined): readonly string[] {
  const values = args ?? [];
  if (values.length > MAX_ARG_COUNT) throw new Error(`screen reader harness args exceeds ${MAX_ARG_COUNT}`);
  return Object.freeze(values.map((arg, index) => safeText(arg, `harness args[${index}]`, MAX_ARG_LENGTH)));
}

function safeEnv(env: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = Object.create(null);
  for (const [key, value] of Object.entries(env ?? {})) {
    const safeKey = safeText(key, "harness env key", 128);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(safeKey)) throw new Error(`unsafe harness environment key ${safeKey}`);
    output[safeKey] = safeText(value, `harness env ${safeKey}`, 4_096);
  }
  return output;
}

async function runHarnessProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  request: HarnessRequestEnvelope,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  if (signal?.aborted) throw new Error("screen reader observation cancelled");
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value ?? "");
    };
    const kill = (): void => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      kill();
      finish(new Error("screen reader observation cancelled"));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`screen reader harness timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        kill();
        finish(new Error(`screen reader harness stdout exceeds ${maxOutputBytes} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("close", (code, closeSignal) => {
      if (settled) return;
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1_024);
        finish(new Error(`screen reader harness exited ${String(code)}${closeSignal ? ` (${closeSignal})` : ""}${diagnostic ? `: ${diagnostic}` : ""}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

function platformFor(reader: ScreenReaderKind): NodeJS.Platform {
  return reader === "VOICEOVER" ? "darwin" : "win32";
}

export class ScreenReaderProcessAdapter {
  readonly reader: ScreenReaderKind;
  readonly requiredPlatform: NodeJS.Platform;
  private readonly options: ScreenReaderAdapterOptions;

  constructor(reader: ScreenReaderKind, options: ScreenReaderAdapterOptions = {}) {
    this.reader = reader;
    this.requiredPlatform = platformFor(reader);
    this.options = options;
  }

  async observe(request: ScreenReaderObservationRequest): Promise<ScreenReaderEvidence> {
    const scope = safeScope(request.scope);
    const targetUrl = canonicalUrl(request.targetUrl);
    if (process.platform !== this.requiredPlatform) {
      return unavailableEvidence(this.reader, scope, targetUrl, `${this.reader} requires ${this.requiredPlatform}; current platform is ${process.platform}`);
    }
    if (!this.options.executable) return unavailableEvidence(this.reader, scope, targetUrl, `${this.reader} harness executable is not configured`);

    const timeoutMs = boundedInteger(this.options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 100, MAX_TIMEOUT_MS);
    const maxOutputBytes = boundedInteger(this.options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, "maxOutputBytes", 1_024, MAX_OUTPUT_BYTES);
    const challenge = this.options.challengeFactory?.() ?? randomBytes(24).toString("hex");
    if (!CHALLENGE.test(challenge)) throw new Error("challengeFactory must return 32-128 lowercase hex characters");

    let executable: string;
    try {
      executable = await validateExecutable(this.options.executable);
    } catch (error) {
      return unavailableEvidence(this.reader, scope, targetUrl, error instanceof Error ? error.message : "screen reader harness is unavailable");
    }

    const harnessDigest = await executableDigest(executable);
    const envelope: HarnessRequestEnvelope = Object.freeze({
      protocolVersion: "1",
      reader: this.reader,
      challenge,
      scope,
      targetUrl,
    });

    try {
      const output = await runHarnessProcess(executable, safeArgs(this.options.args), safeEnv(this.options.env), envelope, request.signal, timeoutMs, maxOutputBytes);
      const response = parseHarnessResponse(output);
      if (response.protocolVersion !== "1") throw new Error("screen reader harness protocol version mismatch");
      if (response.reader !== this.reader) throw new Error("screen reader harness reader identity mismatch");
      if (response.challenge !== challenge) throw new Error("screen reader harness challenge mismatch");
      if (response.scope.tenantId !== scope.tenantId || response.scope.brandId !== scope.brandId) throw new Error("screen reader harness scope mismatch");
      if (response.targetUrl !== targetUrl) throw new Error("screen reader harness target mismatch");

      let status = response.status;
      let reason = response.reason;
      if (status === "OBSERVED" && (!response.nativeSession || response.synthetic || response.events.length === 0 || response.readerVersion === null)) {
        status = "NOT_VERIFIED";
        reason = "harness OBSERVED claim lacks native session, reader version, non-synthetic provenance, or transcript events";
      }
      if (status === "SYNTHETIC" && !response.synthetic) {
        status = "NOT_VERIFIED";
        reason = "SYNTHETIC harness status requires synthetic=true";
      }
      if ((status === "UNAVAILABLE" || status === "NOT_VERIFIED") && !reason) reason = `${this.reader} harness did not provide verified observation evidence`;

      return evidenceCore({
        authority: "NEXUS_SCREEN_READER_EVIDENCE_V1",
        scope,
        targetUrl,
        reader: this.reader,
        status,
        observedAt: response.observedAt,
        platform: response.platform,
        readerVersion: response.readerVersion,
        harness: Object.freeze({ protocolVersion: "1", executableDigest: harnessDigest }),
        session: Object.freeze({ nativeSession: response.nativeSession, synthetic: response.synthetic }),
        events: status === "UNAVAILABLE" ? Object.freeze([]) : response.events,
        ...(reason ? { reason: safeText(reason, "reason", MAX_REASON) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "screen reader harness execution failed";
      const status: ScreenReaderEvidenceStatus = /cancelled|timed out|ENOENT|EACCES|unavailable/iu.test(message) ? "UNAVAILABLE" : "NOT_VERIFIED";
      return evidenceCore({
        authority: "NEXUS_SCREEN_READER_EVIDENCE_V1",
        scope,
        targetUrl,
        reader: this.reader,
        status,
        observedAt: new Date().toISOString(),
        platform: process.platform,
        readerVersion: null,
        harness: Object.freeze({ protocolVersion: "1", executableDigest: harnessDigest }),
        session: Object.freeze({ nativeSession: false, synthetic: false }),
        events: Object.freeze([]),
        reason: safeText(message, "reason", MAX_REASON),
      });
    }
  }
}

export class NvdaScreenReaderAdapter extends ScreenReaderProcessAdapter {
  constructor(options: ScreenReaderAdapterOptions = {}) { super("NVDA", options); }
}

export class JawsScreenReaderAdapter extends ScreenReaderProcessAdapter {
  constructor(options: ScreenReaderAdapterOptions = {}) { super("JAWS", options); }
}

export class VoiceOverScreenReaderAdapter extends ScreenReaderProcessAdapter {
  constructor(options: ScreenReaderAdapterOptions = {}) { super("VOICEOVER", options); }
}

export function createSyntheticScreenReaderEvidence(input: {
  readonly scope: MeasurementScope;
  readonly targetUrl: string;
  readonly reader: ScreenReaderKind;
  readonly observedAt: string;
  readonly readerVersion: string;
  readonly events: readonly ScreenReaderEvent[];
  readonly reason?: string;
}): ScreenReaderEvidence {
  const events = normalizeEvents(input.events);
  return evidenceCore({
    authority: "NEXUS_SCREEN_READER_EVIDENCE_V1",
    scope: safeScope(input.scope),
    targetUrl: canonicalUrl(input.targetUrl),
    reader: input.reader,
    status: "SYNTHETIC",
    observedAt: canonicalTimestamp(input.observedAt),
    platform: "SYNTHETIC_FIXTURE",
    readerVersion: safeText(input.readerVersion, "readerVersion", 128),
    harness: null,
    session: Object.freeze({ nativeSession: false, synthetic: true }),
    events,
    reason: safeText(input.reason ?? "synthetic screen reader fixture; not real assistive-technology evidence", "reason", MAX_REASON),
  });
}

export function validateScreenReaderEvidence(evidence: ScreenReaderEvidence): void {
  if (evidence.authority !== "NEXUS_SCREEN_READER_EVIDENCE_V1") throw new Error("unsupported screen reader evidence authority");
  safeScope(evidence.scope);
  canonicalUrl(evidence.targetUrl);
  canonicalTimestamp(evidence.observedAt);
  if (!["NVDA", "JAWS", "VOICEOVER"].includes(evidence.reader)) throw new Error("unsupported screen reader kind");
  if (!["OBSERVED", "UNAVAILABLE", "NOT_VERIFIED", "SYNTHETIC"].includes(evidence.status)) throw new Error("unsupported screen reader evidence status");
  if (!SHA256.test(evidence.evidenceDigest)) throw new Error("screen reader evidence digest is malformed");
  const { evidenceDigest, ...core } = evidence;
  if (screenReaderDigest(core) !== evidenceDigest) throw new Error("screen reader evidence replay digest mismatch");
  normalizeEvents(evidence.events);

  if (evidence.harness !== null && !SHA256.test(evidence.harness.executableDigest)) throw new Error("screen reader harness executable digest is malformed");
  if (evidence.status === "OBSERVED") {
    if (!evidence.session.nativeSession || evidence.session.synthetic || evidence.readerVersion === null || evidence.harness === null || evidence.events.length === 0) {
      throw new Error("OBSERVED screen reader evidence requires native non-synthetic harness provenance, reader version, and transcript events");
    }
    if (evidence.reason !== undefined) throw new Error("OBSERVED screen reader evidence cannot include a failure reason");
    return;
  }
  if (evidence.status === "SYNTHETIC") {
    if (!evidence.session.synthetic || evidence.session.nativeSession || evidence.harness !== null || evidence.events.length === 0) {
      throw new Error("SYNTHETIC screen reader evidence must remain fixture-only and cannot claim native harness provenance");
    }
    if (!evidence.reason?.trim()) throw new Error("SYNTHETIC screen reader evidence requires an explicit reason");
    return;
  }
  if (!evidence.reason?.trim()) throw new Error(`${evidence.status} screen reader evidence requires a reason`);
  if (evidence.status === "UNAVAILABLE" && evidence.events.length !== 0) throw new Error("UNAVAILABLE screen reader evidence cannot contain transcript events");
}
