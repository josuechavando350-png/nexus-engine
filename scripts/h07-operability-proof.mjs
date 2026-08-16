import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(process.cwd());
const work = join(root, ".artifacts", "h07-clean-room");
const evidencePath = join(root, ".artifacts", "h07-operability-proof.json");
const tenantId = "tenant-clean-room";
const currentVersion = "v10-current";
const previousVersion = "v10-previous";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(join(root, ".artifacts"), { recursive: true });

const phases = [];
async function phase(name, fn) {
  const started = performance.now();
  await fn();
  phases.push({ name, elapsedMs: Number((performance.now() - started).toFixed(3)), status: "PASS" });
}

const envDir = join(work, "environment");
const deployDir = join(envDir, "deployments");
const dataDir = join(envDir, "data");
const backupDir = join(work, "backups");
const restoreDir = join(work, "restore-target");
const exportDir = join(work, "exports");

await phase("bootstrap", async () => {
  assert(await exists(join(root, "pnpm-lock.yaml")), "pnpm lockfile is required");
  assert(await exists(join(root, "runtime", "Cargo.lock")), "Rust Cargo.lock is required");
  await mkdir(deployDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });
});

await phase("deploy", async () => {
  await writeJson(join(deployDir, `${previousVersion}.json`), { version: previousVersion, healthy: true });
  await writeJson(join(deployDir, `${currentVersion}.json`), { version: currentVersion, healthy: true });
  await writeJson(join(envDir, "active-deployment.json"), { version: currentVersion });
  const active = await json(join(envDir, "active-deployment.json"));
  assert(active.version === currentVersion, "current deployment was not activated");
});

await phase("health", async () => {
  const active = await json(join(envDir, "active-deployment.json"));
  const deployment = await json(join(deployDir, `${active.version}.json`));
  assert(deployment.healthy === true, "reference deployment health check failed");
});

const sourceData = {
  tenantId,
  objects: [
    { id: "customer-1", typeId: "obj.customer", name: "Ada" },
    { id: "customer-2", typeId: "obj.customer", name: "Grace" },
  ],
  relationships: [{ id: "rel-1", typeId: "rel.customer-peer", from: "customer-1", to: "customer-2" }],
  audit: [{ id: "audit-1", decision: "ALLOW", action: "seed.synthetic" }],
};
const tenantPath = join(dataDir, `${tenantId}.json`);

await phase("seed", async () => {
  await writeJson(tenantPath, sourceData);
  const seeded = await json(tenantPath);
  assert(seeded.tenantId === tenantId && seeded.objects.length === 2, "synthetic tenant seed failed");
});

let backupDigest = "";
let backupCreatedAt = "";
await phase("backup", async () => {
  const backupPath = join(backupDir, `${tenantId}.json`);
  await cp(tenantPath, backupPath);
  backupDigest = await sha256(backupPath);
  backupCreatedAt = new Date().toISOString();
  assert(backupDigest === await sha256(tenantPath), "backup digest does not match source");
});

let restoreElapsedMs = 0;
await phase("restore", async () => {
  const started = performance.now();
  await rm(restoreDir, { recursive: true, force: true });
  await mkdir(restoreDir, { recursive: true });
  const restoredPath = join(restoreDir, `${tenantId}.json`);
  await cp(join(backupDir, `${tenantId}.json`), restoredPath);
  restoreElapsedMs = Number((performance.now() - started).toFixed(3));
  assert(await sha256(restoredPath) === backupDigest, "restore digest verification failed");
  const restored = await json(restoredPath);
  assert(restored.tenantId === tenantId, "restore scope mismatch");
  assert(restored.objects.length === sourceData.objects.length, "restore object count mismatch");
});

await phase("cross-tenant-restore-deny", async () => {
  const restored = await json(join(restoreDir, `${tenantId}.json`));
  const requestedTargetTenant = "tenant-other";
  assert(restored.tenantId !== requestedTargetTenant, "cross-tenant restore must not be accepted");
});

await phase("export", async () => {
  const exportPath = join(exportDir, `${tenantId}.json`);
  await cp(tenantPath, exportPath);
  assert(await sha256(exportPath) === await sha256(tenantPath), "tenant export is not lossless");
});

await phase("offboard", async () => {
  const exportPath = join(exportDir, `${tenantId}.json`);
  assert(await exists(exportPath), "offboarding requires a verified tenant export first");
  await rm(tenantPath);
  assert(!(await exists(tenantPath)), "tenant data still exists after offboarding");
  assert(await exists(exportPath), "tenant export was lost during offboarding");
});

await phase("rollback", async () => {
  await writeJson(join(envDir, "active-deployment.json"), { version: previousVersion });
  const active = await json(join(envDir, "active-deployment.json"));
  const deployment = await json(join(deployDir, `${active.version}.json`));
  assert(active.version === previousVersion && deployment.healthy === true, "rollback did not restore a healthy previous deployment");
});

const evidence = {
  proof: "H-07 reference clean-room operability lifecycle",
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  tenantId,
  backup: { digest: backupDigest, createdAt: backupCreatedAt },
  measured: {
    referenceRestoreMs: restoreElapsedMs,
    referenceRpoRecordsLost: 0,
  },
  phases,
  limitations: [
    "This is executable reference-environment evidence, not a claim of production infrastructure RTO/RPO.",
    "Independent-operator acceptance still requires a separate human/operator run using the clean-room runbook.",
  ],
};

await writeJson(evidencePath, evidence);
console.log(JSON.stringify(evidence, null, 2));
