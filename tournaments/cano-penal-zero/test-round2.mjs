import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildReadinessProfiles, buildRound2Problem } from "./round2.mjs";

const publicEvidence = JSON.parse(await readFile(new URL("./round2-public-evidence-v1.json", import.meta.url), "utf8"));
const round1Fixture = {
  adsFindings: {
    primaryConversionAction: "WhatsApp - canopenal",
    trackedPrimaryConversions90d: 2,
  },
};

test("Round 2 public evidence contains exactly six role-balanced candidates", () => {
  assert.deepStrictEqual(publicEvidence.sixCandidateSet, ["S01","S05","S10","S15","S18","S23"]);
  assert.deepStrictEqual(publicEvidence.roleGroups, {
    demandCapture: ["S01","S10"],
    demandCreation: ["S05","S18"],
    conversionInfrastructure: ["S15","S23"],
  });
});

test("external professional interest promotes S18 only to test-ready, never to proven CANO demand", () => {
  const row = publicEvidence.candidateEvidence.S18;
  assert.equal(row.status, "SUPPORTED_EXTERNAL_AUDIENCE_TEST");
  assert(row.facts.some((item) => item.kind === "PROFESSIONAL_MARKET"));
  assert.match(row.boundary, /DOES_NOT_PROVE_CANO_SUBSCRIBER_DEMAND/);
});

test("readiness dimensions remain raw and lexicographic rather than a hidden outcome score", () => {
  const profiles = buildReadinessProfiles(round1Fixture, publicEvidence);
  const byId = new Map(profiles.map((row) => [row.candidateId, row]));
  assert.equal(byId.get("S23").firstPartyAdsBinding, 1);
  assert.equal(byId.get("S15").firstPartyAdsBinding, 0);
  assert.equal(byId.get("S01").ownedPublicAssetEvidence, 2);
  assert.equal(byId.get("S10").explicitCompetitorCount, 1);
  assert.equal(byId.get("S05").officialSourceEvidence, 2);
  assert.equal(byId.get("S18").officialSourceEvidence, 1);
  assert(byId.get("S23").lexicographicTestReadiness > byId.get("S15").lexicographicTestReadiness);
  assert(byId.get("S01").lexicographicTestReadiness > byId.get("S10").lexicographicTestReadiness);
  assert(byId.get("S05").lexicographicTestReadiness > byId.get("S18").lexicographicTestReadiness);
});

test("GAUSS Round 2 model uses raw evidence Pareto plus exactly three role-pair Ising constraints", () => {
  const profiles = buildReadinessProfiles(round1Fixture, publicEvidence);
  const problem = buildRound2Problem(profiles, publicEvidence.roleGroups);
  assert.equal(problem.tasks.length, 2);
  const pareto = problem.tasks.find((row) => row.layerId === "GAUSS.MATH.PARETO.002");
  const ising = problem.tasks.find((row) => row.layerId === "GAUSS.PHYSICS.ISING_EXACT_GROUND.003");
  assert.equal(pareto.input.points.length, 6);
  assert.deepStrictEqual(pareto.input.objectives, ["MAX","MAX","MAX","MAX","MIN"]);
  assert.equal(ising.input.fields.length, 6);
  assert.equal(ising.input.couplings.length, 3);
  assert(ising.input.couplings.every((edge) => edge.i < edge.j && edge.value > 0));
});
