import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSeoAvengers2500ProjectConfig } from "./seo-avengers-2500-config.mjs";

const AUTHORITY = "NEXUS_SEO_AVENGERS_2500_SIDECAR_V1";
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;
const JSON_KEY_RE = /^[A-Za-z0-9_.:-]+$/;

function assertJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must contain only safe integers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain JSON object`);
    for (const [key, child] of Object.entries(value)) {
      if (!JSON_KEY_RE.test(key)) throw new TypeError(`${path} contains a non-canonical object key`);
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

function canonicalJson(value) {
  assertJsonValue(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function wireBytes(value) {
  if (value === null) return Buffer.from("n;", "ascii");
  if (typeof value === "boolean") return Buffer.from(value ? "b1;" : "b0;", "ascii");
  if (typeof value === "number") return Buffer.from(`i${value};`, "ascii");
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`s${bytes.length}:`, "ascii"), bytes]);
  }
  if (Array.isArray(value)) {
    const parts = [Buffer.from(`a${value.length}[`, "ascii")];
    for (const item of value) parts.push(wireBytes(item));
    parts.push(Buffer.from("]", "ascii"));
    return Buffer.concat(parts);
  }
  const keys = Object.keys(value).sort();
  const parts = [Buffer.from(`o${keys.length}{`, "ascii")];
  for (const key of keys) {
    parts.push(wireBytes(key));
    parts.push(wireBytes(value[key]));
  }
  parts.push(Buffer.from("}", "ascii"));
  return Buffer.concat(parts);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function envelopeHashV1(value) {
  assertJsonValue(value);
  return sha256(wireBytes(value));
}

function assertSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function repositoryRootFromProject(projectDir) {
  const absolute = resolve(projectDir);
  const slash = process.platform === "win32" ? "\\" : "/";
  const marker = `${slash}apps${slash}`;
  const index = absolute.lastIndexOf(marker);
  if (index <= 0) throw new Error("project directory is not under repository apps/");
  return absolute.slice(0, index);
}

function validateObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  assertJsonValue(value, `$${label}`);
  return value;
}

export function buildSeoAvengers2500Envelope(input) {
  const payload = validateObject(input.payload, "payload");
  const runtimeConfig = input.runtimeConfig == null ? {} : validateObject(input.runtimeConfig, "runtimeConfig");
  const core = Object.freeze({
    authority: AUTHORITY,
    schema_version: 1,
    site_id: assertSegment(input.siteId, "siteId"),
    source_revision: assertSegment(input.sourceRevision, "sourceRevision"),
    payload,
    runtime_config: runtimeConfig,
  });
  const canonical = canonicalJson(core);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) throw new Error("SEO Avengers 2500 envelope exceeds size limit");
  const inputHash = envelopeHashV1(core);
  return Object.freeze({ ...core, input_hash: inputHash, idempotency_key: inputHash });
}

export async function enqueueSeoAvengers2500Run(input) {
  try {
    const projectDir = resolve(input.projectDir);
    const config = await readSeoAvengers2500ProjectConfig(projectDir);
    if (!config.enabled || !config.siteId) return Object.freeze({ status: "DISABLED" });
    if (!input.payload) return Object.freeze({ status: "SKIPPED_NO_INPUT" });

    const envelope = buildSeoAvengers2500Envelope({
      siteId: config.siteId,
      sourceRevision: input.sourceRevision,
      payload: input.payload,
      runtimeConfig: input.runtimeConfig,
    });

    const root = repositoryRootFromProject(projectDir);
    const outboxDir = join(root, ".artifacts", "seo-avengers-2500", "outbox");
    await mkdir(outboxDir, { recursive: true });
    const basename = `${envelope.input_hash.slice("sha256:".length)}.json`;
    const destination = join(outboxDir, basename);
    const temporary = join(outboxDir, `.${basename}.${process.pid}.tmp`);
    await writeFile(temporary, `${canonicalJson(envelope)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination).catch(async (error) => {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return;
      throw error;
    });
    return Object.freeze({ status: "QUEUED", inputHash: envelope.input_hash, path: destination });
  } catch (error) {
    return Object.freeze({
      status: "SKIPPED_ERROR",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
