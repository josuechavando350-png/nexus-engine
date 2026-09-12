import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function repositoryRootFromProject(projectDir) {
  const absolute = resolve(projectDir);
  const slash = process.platform === "win32" ? "\\" : "/";
  const marker = `${slash}apps${slash}`;
  const index = absolute.lastIndexOf(marker);
  if (index <= 0) throw new Error("project directory is not under repository apps/");
  return absolute.slice(0, index);
}

export function activationFileForProject(projectDir, explicitPath = null) {
  if (typeof explicitPath === "string" && explicitPath.trim()) return resolve(explicitPath);
  if (typeof process.env.NEXUS_AVENGERS_2500_CONTROL_FILE === "string" && process.env.NEXUS_AVENGERS_2500_CONTROL_FILE.trim()) {
    return resolve(process.env.NEXUS_AVENGERS_2500_CONTROL_FILE.trim());
  }
  return join(repositoryRootFromProject(projectDir), ".artifacts", "seo-avengers-2500", "control", "clients.json");
}

function emptyStore() {
  return { schema_version: 1, clients: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyStore();
  if (value.schema_version !== 1 || !value.clients || typeof value.clients !== "object" || Array.isArray(value.clients)) {
    return emptyStore();
  }
  const clients = {};
  for (const [siteId, enabled] of Object.entries(value.clients)) {
    if (SITE_ID_RE.test(siteId) && typeof enabled === "boolean") clients[siteId] = enabled;
  }
  return { schema_version: 1, clients };
}

export async function readActivationStore(filePath) {
  try {
    return normalizeStore(JSON.parse(await readFile(resolve(filePath), "utf8")));
  } catch {
    return emptyStore();
  }
}

export async function readClientActivation({ projectDir, siteId, activationFile = null }) {
  if (!SITE_ID_RE.test(siteId)) return false;
  const filePath = activationFileForProject(projectDir, activationFile);
  const store = await readActivationStore(filePath);
  return store.clients[siteId] === true;
}

export async function setClientActivation({ projectDir, siteId, enabled, activationFile = null }) {
  if (!SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const filePath = activationFileForProject(projectDir, activationFile);
  const store = await readActivationStore(filePath);
  const next = {
    schema_version: 1,
    clients: { ...store.clients, [siteId]: enabled },
  };
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
  return Object.freeze({ siteId, enabled, filePath });
}
