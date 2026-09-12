import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const SCHEMA_VERSION = 1;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const GENERATION_FILE_RE = /^(\d{20})\.json$/;
const HWM_FILENAME = ".hwm.json";
const HWM_TEMP_FILENAME = ".hwm.pending.json";
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

function hwmCore({ siteId, generation, stateHash }) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new TypeError("hwm generation must be a positive safe integer");
  }
  if (typeof stateHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(stateHash)) {
    throw new TypeError("hwm stateHash must be sha256 hex");
  }
  return {
    schema_version: SCHEMA_VERSION,
    site_id: assertSiteId(siteId),
    generation,
    state_hash: stateHash,
  };
}

function buildHighWaterMark(input) {
  const core = hwmCore(input);
  return Object.freeze({ ...core, hwm_hash: sha256(canonicalJson(core)) });
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

function validateHighWaterMark(value, expectedSiteId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hwm must be an object");
  const exactKeys = ["generation", "hwm_hash", "schema_version", "site_id", "state_hash"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys)) throw new Error("unexpected hwm keys");
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported hwm schema version");
  if (value.site_id !== expectedSiteId) throw new Error("cross-tenant hwm rejected");
  const core = hwmCore({ siteId: value.site_id, generation: value.generation, stateHash: value.state_hash });
  if (typeof value.hwm_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.hwm_hash)) throw new Error("invalid hwm hash");
  if (sha256(canonicalJson(core)) !== value.hwm_hash) throw new Error("hwm hash mismatch");
  return value;
}

async function journalEntries(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { generations: [], hasHwm: false };
    throw error;
  }
  const generations = [];
  let hasHwm = false;
  for (const entry of entries) {
    if (entry.name === HWM_FILENAME) {
      if (!entry.isFile()) throw new Error("hwm must be a regular file");
      if (hasHwm) throw new Error("duplicate hwm");
      hasHwm = true;
      continue;
    }
    if (!entry.isFile()) throw new Error("unexpected non-file control entry");
    const match = GENERATION_FILE_RE.exec(entry.name);
    if (!match) throw new Error("unexpected control filename");
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid generation filename");
    generations.push(generation);
  }
  return { generations: generations.sort((a, b) => a - b), hasHwm };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const actual = await realpath(directory);
  if (actual !== resolve(directory)) throw new Error(`${label} must not traverse symlinks`);
}

async function readCanonicalTextFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const actual = await realpath(path);
  if (actual !== resolve(path)) throw new Error(`${label} must not traverse symlinks`);
  return readFile(path, "utf8");
}

async function resolveTenantReadDirectory(controlRoot, siteId) {
  const root = controlRootPath(controlRoot);
  await assertCanonicalDirectory(root, "controlRoot");
  const tenantsRoot = resolve(root, "tenants");
  try {
    await assertCanonicalDirectory(tenantsRoot, "tenants root");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const directory = tenantDirectory(controlRoot, siteId);
  try {
    await assertCanonicalDirectory(directory, "tenant directory");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return directory;
}

async function ensureTenantDirectory(controlRoot, siteId) {
  const root = controlRootPath(controlRoot);
  await assertCanonicalDirectory(root, "controlRoot");

  const tenantsRoot = resolve(root, "tenants");
  let tenantsCreated = false;
  try {
    await mkdir(tenantsRoot, { mode: 0o700 });
    tenantsCreated = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(tenantsRoot, "tenants root");
  if (tenantsCreated) await syncDirectory(root);

  const directory = tenantDirectory(controlRoot, siteId);
  let tenantCreated = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    tenantCreated = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(directory, "tenant directory");
  if (tenantCreated) await syncDirectory(tenantsRoot);
  return directory;
}

async function writeHighWaterMark(directory, state) {
  const hwm = buildHighWaterMark({ siteId: state.site_id, generation: state.generation, stateHash: state.state_hash });
  const temp = join(directory, HWM_TEMP_FILENAME);
  const destination = join(directory, HWM_FILENAME);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(hwm)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, destination);
  await syncDirectory(directory);
}

export async function readTenantControl({ controlRoot, siteId }) {
  try {
    assertSiteId(siteId);
  } catch {
    return offDecision(typeof siteId === "string" ? siteId : "", "INVALID_SITE_ID");
  }

  let directory;
  try {
    directory = await resolveTenantReadDirectory(controlRoot, siteId);
  } catch {
    return offDecision(siteId, "CONTROL_STORE_UNREADABLE");
  }
  if (directory === null) return offDecision(siteId, "TENANT_MISSING", 0, true);

  let entries;
  try {
    entries = await journalEntries(directory);
  } catch {
    return offDecision(siteId, "CONTROL_STORE_UNREADABLE");
  }
  const { generations, hasHwm } = entries;
  if (generations.length === 0) {
    if (hasHwm) return offDecision(siteId, "HWM_WITHOUT_JOURNAL");
    return offDecision(siteId, "TENANT_MISSING", 0, true);
  }
  if (!hasHwm) return offDecision(siteId, "HWM_MISSING", generations.at(-1));

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
      const parsed = JSON.parse(await readCanonicalTextFile(path, `generation ${generation}`));
      latest = validateStoredState(parsed, siteId, generation, previousHash);
      previousHash = latest.state_hash;
    } catch {
      return offDecision(siteId, "STATE_INTEGRITY_FAILURE", generation);
    }
  }

  let hwm;
  try {
    hwm = validateHighWaterMark(JSON.parse(await readCanonicalTextFile(join(directory, HWM_FILENAME), "high-water mark")), siteId);
  } catch {
    return offDecision(siteId, "HWM_INTEGRITY_FAILURE", latest.generation);
  }
  if (hwm.generation !== latest.generation || hwm.state_hash !== latest.state_hash) {
    return offDecision(siteId, "HWM_MISMATCH", latest.generation);
  }

  try {
    await assertCanonicalDirectory(directory, "tenant directory");
  } catch {
    return offDecision(siteId, "CONTROL_STORE_UNREADABLE", latest.generation);
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
  const directory = await ensureTenantDirectory(controlRoot, siteId);
  const destination = join(directory, generationFileName(generation));
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  await writeHighWaterMark(directory, state);
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
