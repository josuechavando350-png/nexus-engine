import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildCanoTournamentZero } from "./tournament-zero.mjs";
import { buildGaussRound0Problem, buildStrategyField, structuralShortlist } from "./strategy-field.mjs";

const identity = JSON.parse(await readFile(new URL("./identity.json", import.meta.url), "utf8"));
const auditBytes = await readFile(new URL("./audit-evidence.json", import.meta.url));
const audit = JSON.parse(auditBytes.toString("utf8"));
const manifest = JSON.parse(await readFile(new URL("./audit-manifest.json", import.meta.url), "utf8"));
const auditSha256 = `sha256:${createHash("sha256").update(auditBytes).digest("hex")}`;

test("committed combined audit is exactly byte-bound to CANO Tournament Zero", () => {
  assert.equal(manifest.evidenceSha256, auditSha256);
  const state = buildCanoTournamentZero(identity, { auditManifest: manifest, auditBytes });
  assert.equal(state.status, "AUDIT_BOUND_STRATEGY_GENERATION_PENDING");
  assert.equal(state.strategyCount, 0);
  assert.equal(state.selectedStrategyId, null);
});

test("audit-derived field contains exactly 24 unique strategies in six four-strategy families", () => {
  const field = buildStrategyField(audit);
  assert.equal(field.length, 24);
  assert.equal(new Set(field.map((row) => row.id)).size, 24);
  const families = new Map();
  for (const strategy of field) families.set(strategy.familyId, (families.get(strategy.familyId) ?? 0) + 1);
  assert.equal(families.size, 6);
  assert.deepStrictEqual([...families.values()].sort(), [4, 4, 4, 4, 4, 4]);
});

test("structural cut preserves two candidates per family and does not claim a commercial winner", () => {
  const field = buildStrategyField(audit);
  const shortlist = structuralShortlist([...field]);
  assert.equal(shortlist.length, 12);
  const families = new Map();
  for (const strategy of shortlist) families.set(strategy.familyId, (families.get(strategy.familyId) ?? 0) + 1);
  assert.deepStrictEqual([...families.values()].sort(), [2, 2, 2, 2, 2, 2]);
  assert.equal(field.some((row) => Object.hasOwn(row, "selectedStrategyId")), false);
  assert.equal(shortlist.some((row) => Object.hasOwn(row, "commercialWinner")), false);
});

test("live auction, local-office facts and first-party outcomes remain explicit dependencies rather than invented evidence", () => {
  const field = buildStrategyField(audit);
  const paidFiscal = field.find((row) => row.id === "S03");
  const localProfile = field.find((row) => row.id === "S21");
  const diagnostic = field.find((row) => row.id === "S22");
  assert(paidFiscal.dependencies.includes("E13"));
  assert(paidFiscal.dependencies.includes("E14"));
  assert(localProfile.dependencies.includes("E12"));
  assert(localProfile.dependencies.includes("E14"));
  assert(diagnostic.dependencies.includes("E14"));
  assert(paidFiscal.uncertainEvidenceIds.includes("E13"));
  assert(localProfile.uncertainEvidenceIds.includes("E12"));
});

test("GAUSS Round 0 problem covers all 24 with Pareto and exactly 12 with bounded Ising", () => {
  const field = buildStrategyField(audit);
  const shortlist = structuralShortlist([...field]);
  const problem = buildGaussRound0Problem(field, shortlist);
  assert.equal(problem.schemaVersion, 1);
  assert.equal(problem.tasks.length, 2);
  const pareto = problem.tasks.find((row) => row.layerId === "GAUSS.MATH.PARETO.002");
  const ising = problem.tasks.find((row) => row.layerId === "GAUSS.PHYSICS.ISING_EXACT_GROUND.003");
  assert.equal(pareto.input.points.length, 24);
  assert.deepStrictEqual(pareto.input.objectives, ["MAX", "MIN", "MIN", "MIN"]);
  assert.equal(ising.input.fields.length, 12);
  assert(ising.input.couplings.every((edge) => edge.i < edge.j), true);
});

test("a changed audit byte cannot retain the committed manifest binding", () => {
  const changed = Buffer.concat([auditBytes, Buffer.from("\n")]);
  const changedSha = `sha256:${createHash("sha256").update(changed).digest("hex")}`;
  assert.notEqual(changedSha, manifest.evidenceSha256);
  assert.throws(
    () => buildCanoTournamentZero(identity, { auditManifest: manifest, auditBytes: changed }),
    /AUDIT_SHA256_MISMATCH/,
  );
});
