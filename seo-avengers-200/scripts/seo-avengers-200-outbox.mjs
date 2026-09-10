import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSeoAvengersProjectConfig } from "./seo-avengers-200-config.mjs";

const AUTHORITY = "NEXUS_SEO_AVENGERS_200_SECTION_V1";
const MAX_TEXT_CHARS = 100_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertRoute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 300 || value.includes("\0")) {
    throw new Error("route is invalid");
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

export function buildSeoAvengersSectionEnvelope(input) {
  const text = String(input.text ?? "").trim();
  if (!text || text.length > MAX_TEXT_CHARS) throw new Error(`text must be 1..${MAX_TEXT_CHARS} characters`);
  const core = Object.freeze({
    authority: AUTHORITY,
    schema_version: 2,
    site_id: assertSegment(input.siteId, "siteId"),
    route: assertRoute(input.route || "/"),
    section_id: assertSegment(input.sectionId, "sectionId"),
    locale: assertSegment(input.locale || "es-MX", "locale"),
    canonical_origin: typeof input.canonicalOrigin === "string" && input.canonicalOrigin.trim()
      ? new URL(input.canonicalOrigin).origin
      : null,
    text,
    keyword: typeof input.keyword === "string" && input.keyword.trim() ? input.keyword.trim() : null,
    source_revision: assertSegment(input.sourceRevision, "sourceRevision"),
  });
  const inputHash = sha256(canonicalJson(core));
  return Object.freeze({ ...core, input_hash: inputHash, idempotency_key: inputHash });
}

export async function enqueueSeoAvengersSection(input) {
  try {
    const projectDir = resolve(input.projectDir);
    const config = await readSeoAvengersProjectConfig(projectDir);
    // Strict lazy bypass: return before repository-root resolution, mkdir, DB or network.
    if (!config.enabled || !config.siteId) return Object.freeze({ status: "DISABLED" });

    const envelope = buildSeoAvengersSectionEnvelope({
      ...input,
      siteId: config.siteId,
      canonicalOrigin: config.canonicalOrigin,
    });
    const root = repositoryRootFromProject(projectDir);
    const outboxDir = join(root, ".artifacts", "seo-avengers-200", "outbox");
    await mkdir(outboxDir, { recursive: true });
    const basename = `${envelope.input_hash.slice("sha256:".length)}.json`;
    const destination = join(outboxDir, basename);
    const temporary = join(outboxDir, `.${basename}.${process.pid}.tmp`);
    const bytes = `${canonicalJson(envelope)}\n`;
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
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

export async function enqueueSeoAvengersGeneratedCopy(input) {
  if (!Array.isArray(input.copy) || input.copy.length === 0) return Object.freeze([]);
  const results = [];
  for (const item of input.copy) {
    results.push(await enqueueSeoAvengersSection({
      projectDir: input.projectDir,
      route: "/",
      sectionId: String(item.role ?? "content"),
      locale: input.locale,
      text: String(item.text ?? ""),
      keyword: null,
      sourceRevision: input.sourceRevision,
    }));
  }
  return Object.freeze(results);
}
