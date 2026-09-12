import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const SCHEMA_VERSION = 1;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const GENERATION_FILE_RE = /^(\d{20})\.json$/;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("control-plane numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("control-plane values must be JSON-compatible");
}

function assertSiteId(siteId) {
  if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  return siteId;
}

function controlRootPath(controlRoot) {
  if (typeof controlRoot !== "string" || !controlRoot.trim()) throw new Error("controlRoot is required");
  return resolve(controlRoot);
}

function tenantDirectory(controlRoot, siteId) {
  const root = controlRootPath(controlRoot);
  const tenantRoot = resolve(root, "tenants", assertSiteId(siteId));
  const requiredPrefix = `${resolve(root, "tenants")}${sep}`;
  if (!tenantRoot.startsWith(requiredPrefix)) throw new Error("tenant path escaped control root");
  return tenantRoot;
}

function generationFileName(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new Error("invalid generation");
  }
  return `${String(generation).padStart(20, "0")}.json`;
}

function stateCore({ siteId, generation, enabled, killSwitch, previousHash }) {
  return {
    schema_version: SCHEMA_VERSION,
    site_id: assertSiteId(siteId),
    generation,
    enabled,
    kill_switch: killSwitch,
    previous_hash: previousHash,
  };
}

function buildState(input) {
  if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (typeof input.killSwitch !== "boolean") throw new TypeError("killSwitch must be boolean");
  if (input.previousHash !== null && (typeof input.previousHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.previousHash))) {
    throw new TypeError("previousHash must be null or sha256 hex");
  }
  const core = stateCore(input);
  return Object.freeze({ ...core, state_hash: sha256(canonicalJson(core)) });
}

function offDecision(siteId, reason, generation = 0, integrityOk = false) {
  return Object.freeze({
    siteId,
    generation,
    enabled: false,
    killSwitch: true,
    authorized: false,
    integrityOk,
    stateHash: null,
    reason,
  });
}

function validateStoredState(value, expectedSiteId, expectedGeneration, expectedPreviousHash) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be an object");
  const exactKeys = [
    "enabled",
    "generation",
    "kill_switch",
    "previous_hash",
    "schema_version",
    "site_id",
    "state_hash",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys)) throw new Error("unexpected state keys");
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported schema version");
  if (value.site_id !== expectedSiteId) throw new Error("cross-tenant state rejected");
  if (value.generation !== expectedGeneration) throw new Error("generation mismatch");
  if (typeof value.enabled !== "boolean" || typeof value.kill_switch !== "boolean") throw new Error("boolean state fields required");
  if (value.previous_hash !== expectedPreviousHash) throw new Error("previous hash mismatch");
  if (typeof value.state_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.state_hash)) throw new Error("invalid state hash");
  const core = stateCore({
    siteId: value.site_id,
    generation: value.generation,
    enabled: value.enabled,
    killSwitch: value.kill_switch,
    previousHash: value.previous_hash,
  });
  if (sha256(canonicalJson(core)) !== value.state_hash) throw new Error("state hash mismatch");
  return value;
}

async function generationFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const generations = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = GENERATION_FILE_RE.exec(entry.name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (Number.isSafeInteger(generation) && generation >= 1) generations.push(generation);
  }
  return generations.sort((a, b) => a - b);
}

export async function readTenantControl({ controlRoot, siteId }) {
  try {
    assertSiteId(siteId);
  } catch {
    return offDecision(typeof siteId === "string" ? siteId : "", "INVALID_SITE_ID");
  }

  let directory;
  try {
    directory = tenantDirectory(controlRoot, siteId);
  } catch {
    return offDecision(siteId, "CONTROL_ROOT_INVALID");
  }

  let generations;
  try {
    generations = await generationFiles(directory);
  } catch {
    return offDecision(siteId, "CONTROL_STORE_UNREADABLE");
  }
  if (generations.length === 0) return offDecision(siteId, "TENANT_MISSING", 0, true);

  for (let index = 0; index < generations.length; index += 1) {
    if (generations[index] !== index + 1) {
      return offDecision(siteId, "GENERATION_GAP", generations.at(-1));
    }
  }

  let previousHash = null;
  let latest = null;
  for (const generation of generations) {
    try {
      const path = join(directory, generationFileName(generation));
      const parsed = JSON.parse(await readFile(path, "utf8"));
      latest = validateStoredState(parsed, siteId, generation, previousHash);
      previousHash = latest.state_hash;
    } catch {
      return offDecision(siteId, "STATE_INTEGRITY_FAILURE", generation);
    }
  }

  const authorized = latest.enabled === true && latest.kill_switch === false;
  return Object.freeze({
    siteId,
    generation: latest.generation,
    enabled: latest.enabled,
    killSwitch: latest.kill_switch,
    authorized,
    integrityOk: true,
    stateHash: latest.state_hash,
    reason: latest.kill_switch ? "KILL_SWITCH_ACTIVE" : latest.enabled ? "ENABLED" : "DISABLED",
  });
}

export async function appendTenantControl({
  controlRoot,
  siteId,
  enabled,
  killSwitch,
  expectedGeneration,
}) {
  assertSiteId(siteId);
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (typeof killSwitch !== "boolean") throw new TypeError("killSwitch must be boolean");
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TypeError("expectedGeneration must be a non-negative safe integer");

  const current = await readTenantControl({ controlRoot, siteId });
  const currentIsWritable = current.integrityOk && (current.reason === "TENANT_MISSING" || current.generation > 0);
  if (!currentIsWritable) throw new Error(`control state is fail-closed: ${current.reason}`);
  if (current.generation !== expectedGeneration) throw new Error("generation conflict");
  if (current.generation >= MAX_GENERATION) throw new Error("generation exhausted");

  const generation = current.generation + 1;
  const state = buildState({
    siteId,
    generation,
    enabled,
    killSwitch,
    previousHash: current.stateHash,
  });
  const directory = tenantDirectory(controlRoot, siteId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, generationFileName(generation));
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return readTenantControl({ controlRoot, siteId });
}

export async function setTenantEnabled({ controlRoot, siteId, enabled, expectedGeneration }) {
  const current = await readTenantControl({ controlRoot, siteId });
  if (!current.integrityOk) throw new Error(`control state is fail-closed: ${current.reason}`);
  const killSwitch = current.reason === "TENANT_MISSING" ? false : current.killSwitch;
  return appendTenantControl({ controlRoot, siteId, enabled, killSwitch, expectedGeneration });
}

export async function setTenantKillSwitch({ controlRoot, siteId, active, expectedGeneration }) {
  if (typeof active !== "boolean") throw new TypeError("active must be boolean");
  const current = await readTenantControl({ controlRoot, siteId });
  if (!current.integrityOk) throw new Error(`control state is fail-closed: ${current.reason}`);
  const enabled = current.reason === "TENANT_MISSING" ? false : current.enabled;
  return appendTenantControl({ controlRoot, siteId, enabled, killSwitch: active, expectedGeneration });
}

export async function authorizeTenantJob({ controlRoot, siteId, jobGeneration }) {
  if (!Number.isSafeInteger(jobGeneration) || jobGeneration < 1) {
    return Object.freeze({ authorized: false, reason: "INVALID_JOB_GENERATION", generation: 0 });
  }
  const current = await readTenantControl({ controlRoot, siteId });
  if (!current.authorized) {
    return Object.freeze({ authorized: false, reason: current.reason, generation: current.generation });
  }
  if (current.generation !== jobGeneration) {
    return Object.freeze({ authorized: false, reason: "STALE_GENERATION", generation: current.generation });
  }
  return Object.freeze({ authorized: true, reason: "AUTHORIZED", generation: current.generation });
}
