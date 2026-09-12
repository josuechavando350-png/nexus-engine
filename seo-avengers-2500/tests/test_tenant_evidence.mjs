import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { setTenantEnabled, setTenantKillSwitch } from "../control-plane/tenant-control.mjs";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function setup(t, siteId = "alpha") {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "avengers-evidence-"));
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  t.after(async () => {
    await rm(controlRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });
  const control = await setTenantEnabled({ controlRoot, siteId, enabled: true, expectedGeneration: 0 });
  return { controlRoot, evidenceRoot, siteId, generation: control.generation };
}

async function writeSnapshot({ evidenceRoot, siteId, generation, datasets = {} }) {
  const directory = join(evidenceRoot, "tenants", siteId);
  await mkdir(directory, { mode: 0o700 });
  const descriptors = [];
  for (const key of Object.keys(datasets).sort()) {
    const bytes = Buffer.from(`${JSON.stringify(datasets[key])}\n`, "utf8");
    const file = `${key}.json`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    descriptors.push({ key, file, sha256: sha256(bytes) });
  }
  const manifest = {
    schema_version: 1,
    site_id: siteId,
    control_generation: generation,
    datasets: descriptors,
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { directory, manifest };
}

test("valid authorized tenant evidence is accepted read-only", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot({
    ...ctx,
    datasets: { search_performance_records: [{ query: "abogado penalista" }] },
  });
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "READY");
  assert.equal(result.integrityOk, true);
  assert.equal(result.controlGeneration, 1);
  assert.match(result.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.datasets.search_performance_records, [{ query: "abogado penalista" }]);
});

test("missing tenant evidence is explicit INSUFFICIENT_DATA", async (t) => {
  const ctx = await setup(t);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "EVIDENCE_MISSING");
  assert.equal(result.integrityOk, true);
});

test("disabled tenant is OFF before evidence is read", async (t) => {
  const ctx = await setup(t);
  await setTenantEnabled({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, enabled: false, expectedGeneration: 1 });
  const result = await readTenantEvidenceSnapshot({ ...ctx, evidenceRoot: join(ctx.evidenceRoot, "does-not-exist") });
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "DISABLED");
});

test("kill switch blocks evidence ingestion", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot({ ...ctx, datasets: { content_documents: [{ url: "/" }] } });
  await setTenantKillSwitch({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, active: true, expectedGeneration: 1 });
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "KILL_SWITCH_ACTIVE");
});

test("stale control generation is blocked", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot({ ...ctx, datasets: { content_documents: [{ url: "/" }] } });
  await setTenantEnabled({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, enabled: true, expectedGeneration: 1 });
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("tampered dataset bytes are blocked", async (t) => {
  const ctx = await setup(t);
  const { directory } = await writeSnapshot({ ...ctx, datasets: { traffic_window_records: [{ visits: 10 }] } });
  await writeFile(join(directory, "traffic_window_records.json"), `${JSON.stringify([{ visits: 999 }])}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_DATASET_INVALID");
});

test("cross-tenant manifest is blocked", async (t) => {
  const ctx = await setup(t);
  const { directory, manifest } = await writeSnapshot({ ...ctx, datasets: {} });
  manifest.site_id = "other";
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("unknown dataset key is blocked", async (t) => {
  const ctx = await setup(t);
  const directory = join(ctx.evidenceRoot, "tenants", ctx.siteId);
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from("[]\n", "utf8");
  await writeFile(join(directory, "invented_records.json"), bytes);
  const manifest = {
    schema_version: 1,
    site_id: ctx.siteId,
    control_generation: ctx.generation,
    datasets: [{ key: "invented_records", file: "invented_records.json", sha256: sha256(bytes) }],
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("duplicate dataset descriptors are blocked", async (t) => {
  const ctx = await setup(t);
  const { directory, manifest } = await writeSnapshot({ ...ctx, datasets: { content_documents: [] } });
  manifest.datasets.push({ ...manifest.datasets[0] });
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("unexpected evidence files are blocked", async (t) => {
  const ctx = await setup(t);
  const { directory } = await writeSnapshot({ ...ctx, datasets: {} });
  await writeFile(join(directory, "extra.json"), "{}\n");
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("malformed dataset JSON is blocked even when digest matches", async (t) => {
  const ctx = await setup(t);
  const directory = join(ctx.evidenceRoot, "tenants", ctx.siteId);
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from("{not-json}\n", "utf8");
  await writeFile(join(directory, "content_documents.json"), bytes);
  const manifest = {
    schema_version: 1,
    site_id: ctx.siteId,
    control_generation: ctx.generation,
    datasets: [{ key: "content_documents", file: "content_documents.json", sha256: sha256(bytes) }],
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_DATASET_INVALID");
});

test("non-array dataset payload is blocked", async (t) => {
  const ctx = await setup(t);
  const directory = join(ctx.evidenceRoot, "tenants", ctx.siteId);
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from("{}\n", "utf8");
  await writeFile(join(directory, "content_documents.json"), bytes);
  const manifest = {
    schema_version: 1,
    site_id: ctx.siteId,
    control_generation: ctx.generation,
    datasets: [{ key: "content_documents", file: "content_documents.json", sha256: sha256(bytes) }],
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_DATASET_INVALID");
});

test("empty but valid dataset remains READY for downstream INSUFFICIENT_DATA semantics", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot({ ...ctx, datasets: { search_performance_records: [] } });
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "READY");
  assert.deepEqual(result.datasets.search_performance_records, []);
});

test("symlinked tenant evidence directory is rejected", async (t) => {
  const ctx = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "avengers-evidence-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(ctx.evidenceRoot, "tenants", ctx.siteId), "dir");
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_ROOT_UNSAFE_OR_UNREADABLE");
});

test("symlinked dataset file is rejected", async (t) => {
  const ctx = await setup(t);
  const directory = join(ctx.evidenceRoot, "tenants", ctx.siteId);
  await mkdir(directory, { mode: 0o700 });
  const outside = join(ctx.evidenceRoot, "outside.json");
  const bytes = Buffer.from("[]\n", "utf8");
  await writeFile(outside, bytes);
  await symlink(outside, join(directory, "content_documents.json"));
  const manifest = {
    schema_version: 1,
    site_id: ctx.siteId,
    control_generation: ctx.generation,
    datasets: [{ key: "content_documents", file: "content_documents.json", sha256: sha256(bytes) }],
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_MANIFEST_INVALID");
});

test("reader does not modify evidence files", async (t) => {
  const ctx = await setup(t);
  const { directory } = await writeSnapshot({ ...ctx, datasets: { content_documents: [{ url: "/" }] } });
  const beforeManifest = await readFile(join(directory, "manifest.json"));
  const beforeDataset = await readFile(join(directory, "content_documents.json"));
  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "READY");
  assert.deepEqual(await readFile(join(directory, "manifest.json")), beforeManifest);
  assert.deepEqual(await readFile(join(directory, "content_documents.json")), beforeDataset);
});
