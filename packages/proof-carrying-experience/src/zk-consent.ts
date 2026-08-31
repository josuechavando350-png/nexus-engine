import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type ZkConsentStatus =
  | "VERIFIED"
  | "NOT_VERIFIED"
  | "UNAVAILABLE"
  | "INVALID_BINDING"
  | "REPLAYED"
  | "TIMEOUT"
  | "CANCELLED";

export interface ZkConsentRequest {
  tenantId: string;
  scope: string;
  action: string;
  nonce: string;
  payloadDigest: string;
  proofJson: string;
  publicSignalsJson: string;
  verificationKeyJson: string;
}

export interface ZkConsentEvidence {
  status: ZkConsentStatus;
  toolchain: "snarkjs-groth16";
  toolchainVersion: string | null;
  tenantId: string;
  scope: string;
  action: string;
  nonceDigest: string;
  payloadDigest: string;
  verificationKeyDigest: string;
  proofDigest: string;
  publicSignalsDigest: string;
  bindingSignal: string;
  reason: string;
}

export interface ReplayGuard {
  consume(input: { tenantId: string; scope: string; nonceDigest: string }): Promise<boolean>;
}

export interface ZkConsentVerifierOptions {
  executable?: string;
  timeoutMs?: number;
  replayGuard: ReplayGuard;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertIdentifier(label: string, value: string, max = 256): void {
  if (value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertDigest(label: string, value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase sha256 hex digest`);
}

function assertBoundedJson(label: string, value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) throw new Error(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return parsed;
}

function canonicalBinding(request: Pick<ZkConsentRequest, "tenantId" | "scope" | "action" | "nonce" | "payloadDigest">): string {
  return JSON.stringify({
    action: request.action,
    nonce: request.nonce,
    payloadDigest: request.payloadDigest,
    scope: request.scope,
    tenantId: request.tenantId,
  });
}

export function zkConsentBindingSignal(
  request: Pick<ZkConsentRequest, "tenantId" | "scope" | "action" | "nonce" | "payloadDigest">,
): string {
  const digest = sha256(canonicalBinding(request));
  return (BigInt(`0x${digest}`) % BN254_SCALAR_FIELD).toString(10);
}

function parsePublicSignals(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error("publicSignalsJson must be a non-empty array with at most 256 signals");
  }
  return value.map((signal) => {
    if (typeof signal !== "string" || !/^[0-9]{1,80}$/u.test(signal)) throw new Error("public signal must be a decimal string");
    return signal;
  });
}

async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const kill = (): void => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const onData = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) {
        kill();
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => onData("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => onData("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, cancelled }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SnarkjsGroth16ConsentVerifier {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly replayGuard: ReplayGuard;

  constructor(options: ZkConsentVerifierOptions) {
    this.executable = options.executable ?? "snarkjs";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.replayGuard = options.replayGuard;
    if (this.timeoutMs < 100 || this.timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeoutMs is outside the permitted range");
    if (!/^[A-Za-z0-9._/\\:-]{1,512}$/u.test(this.executable)) throw new Error("executable is invalid");
  }

  async verify(request: ZkConsentRequest, signal?: AbortSignal): Promise<ZkConsentEvidence> {
    assertIdentifier("tenantId", request.tenantId);
    assertIdentifier("scope", request.scope);
    assertIdentifier("action", request.action);
    assertIdentifier("nonce", request.nonce, 512);
    assertDigest("payloadDigest", request.payloadDigest);
    const proof = assertBoundedJson("proofJson", request.proofJson);
    const publicSignals = parsePublicSignals(assertBoundedJson("publicSignalsJson", request.publicSignalsJson));
    assertBoundedJson("verificationKeyJson", request.verificationKeyJson);
    if (typeof proof !== "object" || proof === null || Array.isArray(proof)) throw new Error("proofJson must be an object");

    const bindingSignal = zkConsentBindingSignal(request);
    const base = {
      toolchain: "snarkjs-groth16" as const,
      tenantId: request.tenantId,
      scope: request.scope,
      action: request.action,
      nonceDigest: sha256(request.nonce),
      payloadDigest: request.payloadDigest,
      verificationKeyDigest: sha256(request.verificationKeyJson),
      proofDigest: sha256(request.proofJson),
      publicSignalsDigest: sha256(request.publicSignalsJson),
      bindingSignal,
    };

    if (publicSignals[0] !== bindingSignal) {
      return { ...base, status: "INVALID_BINDING", toolchainVersion: null, reason: "first public signal does not bind tenant/scope/action/nonce/payload" };
    }
    if (signal?.aborted) return { ...base, status: "CANCELLED", toolchainVersion: null, reason: "verification cancelled before execution" };

    let version: ProcessResult;
    try {
      version = await runBoundedProcess(this.executable, ["--version"], this.timeoutMs, signal);
    } catch (error) {
      return { ...base, status: "UNAVAILABLE", toolchainVersion: null, reason: `snarkjs unavailable: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    if (version.cancelled) return { ...base, status: "CANCELLED", toolchainVersion: null, reason: "toolchain version check cancelled" };
    if (version.timedOut) return { ...base, status: "TIMEOUT", toolchainVersion: null, reason: "toolchain version check timed out" };
    if (version.code !== 0) return { ...base, status: "UNAVAILABLE", toolchainVersion: null, reason: "snarkjs version check failed" };
    const toolchainVersion = version.stdout.trim().slice(0, 128) || version.stderr.trim().slice(0, 128) || "unknown";

    const replayAccepted = await this.replayGuard.consume({ tenantId: request.tenantId, scope: request.scope, nonceDigest: base.nonceDigest });
    if (!replayAccepted) return { ...base, status: "REPLAYED", toolchainVersion, reason: "nonce was already consumed for tenant/scope" };

    const dir = await mkdtemp(join(tmpdir(), "nexus-zk-consent-"));
    try {
      const vkPath = join(dir, "verification_key.json");
      const signalsPath = join(dir, "public.json");
      const proofPath = join(dir, "proof.json");
      await Promise.all([
        writeFile(vkPath, request.verificationKeyJson, { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(signalsPath, request.publicSignalsJson, { encoding: "utf8", flag: "wx", mode: 0o600 }),
        writeFile(proofPath, request.proofJson, { encoding: "utf8", flag: "wx", mode: 0o600 }),
      ]);
      const result = await runBoundedProcess(this.executable, ["groth16", "verify", vkPath, signalsPath, proofPath], this.timeoutMs, signal);
      if (result.cancelled) return { ...base, status: "CANCELLED", toolchainVersion, reason: "verification cancelled" };
      if (result.timedOut) return { ...base, status: "TIMEOUT", toolchainVersion, reason: "verification timed out" };
      if (result.code !== 0) return { ...base, status: "NOT_VERIFIED", toolchainVersion, reason: "snarkjs rejected proof or verifier execution failed" };
      const normalized = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (!normalized.includes("ok")) return { ...base, status: "NOT_VERIFIED", toolchainVersion, reason: "snarkjs did not emit an affirmative verification result" };
      return { ...base, status: "VERIFIED", toolchainVersion, reason: "real snarkjs Groth16 verifier accepted the bound proof" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function requireVerifiedZkConsent<T>(
  verifier: SnarkjsGroth16ConsentVerifier,
  request: ZkConsentRequest,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ evidence: ZkConsentEvidence; value?: T }> {
  const evidence = await verifier.verify(request, signal);
  if (evidence.status !== "VERIFIED") return { evidence };
  if (signal?.aborted) return { evidence: { ...evidence, status: "CANCELLED", reason: "operation cancelled after verification" } };
  const value = await operation();
  return { evidence, value };
}
