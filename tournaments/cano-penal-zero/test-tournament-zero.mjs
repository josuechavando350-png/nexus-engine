import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildCanoTournamentZero,
  validateCanoAuditManifest,
  validateCanoTournamentIdentity,
} from "./tournament-zero.mjs";

const identity = JSON.parse(await readFile(
  fileURLToPath(new URL("./identity.json", import.meta.url)),
  "utf8",
));

const clone = (value) => structuredClone(value);
const auditBytes = Buffer.from("auditoria penal CDMX: evidencia pendiente de normalizacion\n", "utf8");
const auditSha256 = `sha256:${createHash("sha256").update(auditBytes).digest("hex")}`;
const manifest = {
  schemaVersion: 1,
  tournamentId: "CANO_PENAL_CDMX_ZERO",
  siteId: "cano-penal",
  siteHostname: "canopenal.com",
  evidenceClass: "USER_SUPPLIED_MARKET_AUDIT",
  evidenceLabel: "auditoria-nicho-penal-cdmx",
  evidenceSha256: auditSha256,
};

test("zero state starts with no inherited strategies, winner, claims or evidence", () => {
  const state = buildCanoTournamentZero(identity);
  assert.equal(state.status, "READY_FOR_AUDIT");
  assert.equal(state.strategyCount, 0);
  assert.deepEqual(state.strategies, []);
  assert.deepEqual(state.priorTournamentInputs, []);
  assert.deepEqual(state.evidence, []);
  assert.equal(state.selectedStrategyId, null);
  assert.equal(state.commercialOutcomeClaim, "NOT_EVALUATED");
  assert.equal(state.productionMutation, "FORBIDDEN");
  assert.match(state.stateSha256, /^sha256:[a-f0-9]{64}$/);
});

test("identity is fixed to CANO and cannot be relabeled from another tenant", () => {
  const swapped = clone(identity);
  swapped.siteId = "nexus-bot-studio";
  assert.throws(() => validateCanoTournamentIdentity(swapped), /CANO_TOURNAMENT_IDENTITY_MISMATCH/);

  const domain = clone(identity);
  domain.siteHostname = "nexusbotstudio.com";
  assert.throws(() => validateCanoTournamentIdentity(domain), /CANO_TOURNAMENT_IDENTITY_MISMATCH/);
});

test("old tournament reuse and production mutation cannot be enabled", () => {
  const inherited = clone(identity);
  inherited.priorTournamentReuse = "ALLOWED";
  assert.throws(() => validateCanoTournamentIdentity(inherited), /CANO_TOURNAMENT_IDENTITY_MISMATCH/);

  const mutation = clone(identity);
  mutation.productionMutation = "ALLOWED";
  assert.throws(() => validateCanoTournamentIdentity(mutation), /CANO_TOURNAMENT_IDENTITY_MISMATCH/);
});

test("bound user audit advances only to strategy-generation pending and still has zero strategies", () => {
  const state = buildCanoTournamentZero(identity, { auditManifest: manifest, auditBytes });
  assert.equal(state.status, "AUDIT_BOUND_STRATEGY_GENERATION_PENDING");
  assert.equal(state.strategyCount, 0);
  assert.deepEqual(state.strategies, []);
  assert.equal(state.selectedStrategyId, null);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].evidenceSha256, auditSha256);
  assert.equal(state.commercialOutcomeClaim, "NOT_EVALUATED");
});

test("audit must be byte-bound and belong to CANO", () => {
  const forgedHash = { ...manifest, evidenceSha256: "sha256:" + "0".repeat(64) };
  assert.throws(
    () => validateCanoAuditManifest(forgedHash, validateCanoTournamentIdentity(identity), auditBytes),
    /AUDIT_SHA256_MISMATCH/,
  );

  const foreign = { ...manifest, siteHostname: "nexusbotstudio.com" };
  assert.throws(
    () => validateCanoAuditManifest(foreign, validateCanoTournamentIdentity(identity), auditBytes),
    /CROSS_TENANT_SITE_HOSTNAME_MISMATCH/,
  );
});

test("audit manifest cannot smuggle strategy selection or unsupported evidence classes", () => {
  const extra = { ...manifest, selectedStrategyId: "PRESELECTED_WINNER" };
  assert.throws(
    () => validateCanoAuditManifest(extra, validateCanoTournamentIdentity(identity), auditBytes),
    /missing or unexpected fields/,
  );

  const promoted = { ...manifest, evidenceClass: "CERTIFIED_MARKET_TRUTH" };
  assert.throws(
    () => validateCanoAuditManifest(promoted, validateCanoTournamentIdentity(identity), auditBytes),
    /AUDIT_EVIDENCE_CLASS_NOT_ALLOWED/,
  );
});

test("audit bytes and manifest are inseparable", () => {
  assert.throws(
    () => buildCanoTournamentZero(identity, { auditManifest: manifest }),
    /AUDIT_AND_MANIFEST_MUST_BE_SUPPLIED_TOGETHER/,
  );
  assert.throws(
    () => buildCanoTournamentZero(identity, { auditBytes }),
    /AUDIT_AND_MANIFEST_MUST_BE_SUPPLIED_TOGETHER/,
  );
});
