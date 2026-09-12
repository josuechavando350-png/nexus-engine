import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { publishVersionedEvidenceSnapshot } from "../evidence/versioned-evidence-writer.mjs";

async function setup(t) {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-v2-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "avengers-evidence-v2-"));
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  t.after(async () => {
    await rm(controlRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });
  const state = await setTenantEnabled({
    controlRoot,
    siteId: "nexus-bot-studio",
    enabled: true,
    expectedGeneration: 0,
  });
  return { controlRoot, evidenceRoot, siteId: "nexus-bot-studio", generation: state.generation };
}

test("versioned snapshot publishes immutable data and is readable by tenant evidence API", async (t) => {
  const ctx = await setup(t);
  const publication = await publishVersionedEvidenceSnapshot({
    evidenceRoot: ctx.evidenceRoot,
    siteId: ctx.siteId,
    controlGeneration: ctx.generation,
    datasets: {
      content_documents: [{ document_id: "/", text: "Nexus Bot Studio automation" }],
    },
  });
  assert.match(publication.snapshotId, /^[0-9a-f]{64}$/);
  assert.equal(publication.manifestHash, `sha256:${publication.snapshotId}`);

  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "READY");
  assert.equal(result.integrityOk, true);
  assert.equal(result.controlGeneration, 1);
  assert.equal(result.manifestHash, publication.manifestHash);
  assert.deepEqual(result.datasets.content_documents, [
    { document_id: "/", text: "Nexus Bot Studio automation" },
  ]);
});

test("dataset tamper after publication fails closed", async (t) => {
  const ctx = await setup(t);
  const publication = await publishVersionedEvidenceSnapshot({
    evidenceRoot: ctx.evidenceRoot,
    siteId: ctx.siteId,
    controlGeneration: ctx.generation,
    datasets: { content_documents: [{ document_id: "/", text: "before" }] },
  });
  const datasetPath = join(
    ctx.evidenceRoot,
    "tenants",
    ctx.siteId,
    "snapshots",
    publication.snapshotId,
    "content_documents.json",
  );
  await writeFile(datasetPath, '[{"document_id":"/","text":"after"}]\n', "utf8");

  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.integrityOk, false);
  assert.equal(result.reason, "VERSIONED_EVIDENCE_INTEGRITY_FAILURE");
});

test("writer refuses to reuse a tampered immutable snapshot", async (t) => {
  const ctx = await setup(t);
  const args = {
    evidenceRoot: ctx.evidenceRoot,
    siteId: ctx.siteId,
    controlGeneration: ctx.generation,
    datasets: { content_documents: [{ document_id: "/", text: "stable" }] },
  };
  const publication = await publishVersionedEvidenceSnapshot(args);
  await writeFile(
    join(ctx.evidenceRoot, "tenants", ctx.siteId, "snapshots", publication.snapshotId, "content_documents.json"),
    '[{"document_id":"/","text":"tampered"}]\n',
    "utf8",
  );
  await assert.rejects(publishVersionedEvidenceSnapshot(args), /existing snapshot dataset mismatch/);
});

test("pending HEAD marker blocks readers instead of exposing partial publication", async (t) => {
  const ctx = await setup(t);
  await publishVersionedEvidenceSnapshot({
    evidenceRoot: ctx.evidenceRoot,
    siteId: ctx.siteId,
    controlGeneration: ctx.generation,
    datasets: { content_documents: [{ document_id: "/", text: "stable" }] },
  });
  await writeFile(
    join(ctx.evidenceRoot, "tenants", ctx.siteId, ".HEAD.pending.json"),
    "{}\n",
    "utf8",
  );

  const result = await readTenantEvidenceSnapshot(ctx);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EVIDENCE_PUBLICATION_INCOMPLETE");
});

test("re-publishing identical evidence is idempotent", async (t) => {
  const ctx = await setup(t);
  const args = {
    evidenceRoot: ctx.evidenceRoot,
    siteId: ctx.siteId,
    controlGeneration: ctx.generation,
    datasets: { content_documents: [{ document_id: "/", text: "stable" }] },
  };
  const first = await publishVersionedEvidenceSnapshot(args);
  const firstHead = await readFile(join(ctx.evidenceRoot, "tenants", ctx.siteId, "HEAD.json"), "utf8");
  const second = await publishVersionedEvidenceSnapshot(args);
  const secondHead = await readFile(join(ctx.evidenceRoot, "tenants", ctx.siteId, "HEAD.json"), "utf8");
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.manifestHash, first.manifestHash);
  assert.equal(secondHead, firstHead);
});
