import assert from "node:assert/strict";
import test from "node:test";

import { buildPhysicalQpuFirstRunPlan } from "../quantum-runtime/physical-first-run-plan.mjs";
import {
  IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
  IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
  IBM_PHYSICAL_SESSION_PREPARE_ONLY,
} from "../quantum-runtime/providers/ibm/ibm-physical-session-coordinator.mjs";
import {
  parseIbmPhysicalSessionCliArgs,
  runIbmPhysicalSessionCli,
} from "../scripts/ibm-physical-session-cli.mjs";

const REV = "a".repeat(40);
const TREE = "b".repeat(40);
const ARTIFACT_SHA = `sha256:${"c".repeat(64)}`;
const PROOF_SHA = `sha256:${"d".repeat(64)}`;

function planFor({ backendName = "ibm_contract_qpu_cli" } = {}) {
  return buildPhysicalQpuFirstRunPlan({
    sourceRevision: REV,
    sourceTree: TREE,
    backendName,
    transpilerSeed: 1337,
    evidenceRoot: "/tmp/nexus-quantum-one-cli-contract",
    smokeShots: 64,
    repeatedShots: 128,
    repeatedRunCount: 5,
    bridgeTimeoutMillis: 5_000,
  });
}

function walleSummary(plan, counts = { EXECUTED: 2500, FAILED: 0, BLOCKED: 0, NOT_TESTED: 0 }) {
  return Object.freeze({
    schema_version: 1,
    workload: "seo-avengers-2500",
    environment: "CONTROLLED_TEST_FIXTURES",
    source_revision: plan.sourceRevision,
    source_tree: plan.sourceTree,
    counts: Object.freeze(counts),
    finding_counts: Object.freeze({ FINDING: 1, NO_FINDING: 2299, UNREPORTED: 200 }),
    full_execution_claim: true,
    proof_sha256: PROOF_SHA,
    validation_errors: Object.freeze([]),
  });
}

function memoryIo(files = {}) {
  const map = new Map(Object.entries(files));
  const writes = [];
  return {
    writes,
    async readJson(path) {
      if (!map.has(path)) throw new Error(`missing fixture ${path}`);
      return structuredClone(map.get(path));
    },
    async writeJson(path, value, credentials) {
      writes.push({ path, value, credentials: [...credentials] });
      return path;
    },
  };
}

test("parser rejects credential-bearing command-line options and ambiguous duplicates", () => {
  assert.throws(
    () => parseIbmPhysicalSessionCliArgs(["smoke", "--api-key", "secret", "--out", "x.json"]),
    /SECRET_OPTION_FORBIDDEN:--api-key/,
  );
  assert.throws(
    () => parseIbmPhysicalSessionCliArgs(["prepare", "--plan", "a.json", "--plan", "b.json", "--out", "x.json"]),
    /DUPLICATE_OPTION:--plan/,
  );
});

test("plan command binds the current Git revision and derives the physical execution budget", async () => {
  const io = memoryIo();
  const result = await runIbmPhysicalSessionCli({
    argv: [
      "plan",
      "--backend", "ibm_real_backend_candidate",
      "--evidence-root", "/tmp/nexus-qpu-evidence",
      "--transpiler-seed", "1337",
      "--smoke-shots", "64",
      "--repeated-shots", "128",
      "--repeated-runs", "5",
      "--bridge-timeout-ms", "5000",
      "--out", "plan.json",
    ],
    readJson: io.readJson,
    writeJson: io.writeJson,
    resolveGitIdentity: async () => ({ sourceRevision: REV, sourceTree: TREE }),
  });
  assert.equal(result.value.sourceRevision, REV);
  assert.equal(result.value.sourceTree, TREE);
  assert.equal(result.value.limits.maximumProviderJobs, 6);
  assert.equal(result.value.limits.maximumTotalShots, 704);
  assert.equal(result.value.quantumAdvantageClaimAllowed, false);
  assert.equal(io.writes.length, 1);
  assert.equal(io.writes[0].path, "plan.json");
});

test("prepare command injects no provider credentials and invokes only prepare phase", async () => {
  const plan = planFor();
  const io = memoryIo({ "plan.json": plan });
  const factories = [];
  const calls = [];
  const result = await runIbmPhysicalSessionCli({
    argv: ["prepare", "--plan", "plan.json", "--out", "prepare.json"],
    readJson: io.readJson,
    writeJson: io.writeJson,
    coordinatorFactory(args) {
      factories.push(args);
      return Object.freeze({
        async run(runArgs) {
          calls.push(runArgs);
          return Object.freeze({ sessionReport: Object.freeze({ verdict: "BLOCKED", confirmedPhysicalJobCount: 0 }) });
        },
      });
    },
  });
  assert.equal(factories.length, 1);
  assert.equal(factories[0].apiKey, null);
  assert.equal(factories[0].instanceCrn, null);
  assert.deepEqual(calls, [{ sessionPhase: IBM_PHYSICAL_SESSION_PREPARE_ONLY }]);
  assert.equal(result.value.sessionReport.confirmedPhysicalJobCount, 0);
  assert.deepEqual(io.writes[0].credentials, []);
});

test("smoke authorization binds exact WALLE evidence and explicit provider entitlement confirmation", async () => {
  const plan = planFor();
  const request = Object.freeze({ schemaVersion: 1, workloadId: "contract-workload" });
  const io = memoryIo({
    "plan.json": plan,
    "request.json": request,
    "walle.json": walleSummary(plan),
  });
  const result = await runIbmPhysicalSessionCli({
    argv: [
      "authorize-smoke",
      "--plan", "plan.json",
      "--request", "request.json",
      "--walle-summary", "walle.json",
      "--walle-artifact-sha256", ARTIFACT_SHA,
      "--ci-status", "SUCCESS",
      "--provider-cost-reference", "IBM_ENTITLEMENT_CONTRACT_REFERENCE",
      "--confirm-provider-cost-or-entitlement",
      "--out", "smoke-auth.json",
    ],
    readJson: io.readJson,
    writeJson: io.writeJson,
  });
  assert.equal(result.value.sourceRevision, plan.sourceRevision);
  assert.equal(result.value.sourceTree, plan.sourceTree);
  assert.equal(result.value.planSha256, plan.planSha256);
  assert.equal(result.value.exactHeadCiStatus, "SUCCESS");
  assert.equal(result.value.walleArtifactSha256, ARTIFACT_SHA);
  assert.equal(result.value.walleProofSha256, PROOF_SHA);
  assert.equal(result.value.walleExecutedModuleCount, 2500);
  assert.equal(result.value.providerCostOrEntitlementConfirmed, true);
  assert.equal(result.value.quantumAdvantageClaimAllowed, false);
});

test("authorization fails closed when WALLE evidence is incomplete", async () => {
  const plan = planFor();
  const io = memoryIo({
    "plan.json": plan,
    "request.json": Object.freeze({ schemaVersion: 1 }),
    "walle.json": walleSummary(plan, { EXECUTED: 2499, FAILED: 1, BLOCKED: 0, NOT_TESTED: 0 }),
  });
  await assert.rejects(
    runIbmPhysicalSessionCli({
      argv: [
        "authorize-smoke",
        "--plan", "plan.json",
        "--request", "request.json",
        "--walle-summary", "walle.json",
        "--walle-artifact-sha256", ARTIFACT_SHA,
        "--ci-status", "SUCCESS",
        "--provider-cost-reference", "IBM_ENTITLEMENT_CONTRACT_REFERENCE",
        "--confirm-provider-cost-or-entitlement",
        "--out", "smoke-auth.json",
      ],
      readJson: io.readJson,
      writeJson: io.writeJson,
    }),
    /WALLE_SUMMARY_EXECUTION_COUNTS_INCOMPLETE/,
  );
  assert.equal(io.writes.length, 0);
});

test("live smoke requires runtime-only IBM environment credentials before coordinator construction", async () => {
  const plan = planFor();
  const io = memoryIo({
    "plan.json": plan,
    "request.json": Object.freeze({ requestId: "contract-request" }),
    "smoke-auth.json": Object.freeze({ authorizationSha256: `sha256:${"e".repeat(64)}` }),
  });
  let factories = 0;
  await assert.rejects(
    runIbmPhysicalSessionCli({
      argv: [
        "smoke",
        "--plan", "plan.json",
        "--request", "request.json",
        "--smoke-authorization", "smoke-auth.json",
        "--out", "smoke-result.json",
      ],
      env: {},
      readJson: io.readJson,
      writeJson: io.writeJson,
      coordinatorFactory() {
        factories += 1;
        throw new Error("must not construct");
      },
    }),
    /LIVE_PHASE_REQUIRES_IBM_QUANTUM_API_KEY_AND_IBM_QUANTUM_INSTANCE_CRN_ENVIRONMENT/,
  );
  assert.equal(factories, 0);
  assert.equal(io.writes.length, 0);
});

test("live smoke passes credentials only to the runtime factory and never as persisted input", async () => {
  const plan = planFor();
  const io = memoryIo({
    "plan.json": plan,
    "request.json": Object.freeze({ requestId: "contract-request" }),
    "smoke-auth.json": Object.freeze({ authorizationSha256: `sha256:${"e".repeat(64)}` }),
  });
  const factoryCalls = [];
  const runCalls = [];
  const env = {
    IBM_QUANTUM_API_KEY: "runtime-only-contract-api-key",
    IBM_QUANTUM_INSTANCE_CRN: "crn:v1:contract-runtime-only",
  };
  const result = await runIbmPhysicalSessionCli({
    argv: [
      "smoke",
      "--plan", "plan.json",
      "--request", "request.json",
      "--smoke-authorization", "smoke-auth.json",
      "--out", "smoke-result.json",
    ],
    env,
    readJson: io.readJson,
    writeJson: io.writeJson,
    coordinatorFactory(args) {
      factoryCalls.push(args);
      return Object.freeze({
        async run(runArgs) {
          runCalls.push(runArgs);
          return Object.freeze({
            sessionReport: Object.freeze({
              phase: IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
              verdict: "INCONCLUSIVE",
              quantumAdvantageClaimAllowed: false,
            }),
          });
        },
      });
    },
  });
  assert.equal(factoryCalls[0].apiKey, env.IBM_QUANTUM_API_KEY);
  assert.equal(factoryCalls[0].instanceCrn, env.IBM_QUANTUM_INSTANCE_CRN);
  assert.equal(runCalls[0].sessionPhase, IBM_PHYSICAL_SESSION_EXECUTE_SMOKE);
  assert.equal(result.value.sessionReport.quantumAdvantageClaimAllowed, false);
  assert.deepEqual(io.writes[0].credentials, [env.IBM_QUANTUM_API_KEY, env.IBM_QUANTUM_INSTANCE_CRN]);
  assert.equal(JSON.stringify(io.writes[0].value).includes(env.IBM_QUANTUM_API_KEY), false);
  assert.equal(JSON.stringify(io.writes[0].value).includes(env.IBM_QUANTUM_INSTANCE_CRN), false);
});

test("series command preserves separate smoke evidence, baseline, authorization and live phase", async () => {
  const plan = planFor();
  const request = Object.freeze({ requestId: "contract-request" });
  const baseline = Object.freeze({ profileId: "contract-baseline" });
  const priorSmoke = Object.freeze({ gateReport: Object.freeze({ reportSha256: `sha256:${"f".repeat(64)}` }) });
  const seriesAuthorization = Object.freeze({ authorizationSha256: `sha256:${"1".repeat(64)}` });
  const io = memoryIo({
    "plan.json": plan,
    "request.json": request,
    "baseline.json": baseline,
    "prior-smoke.json": priorSmoke,
    "series-auth.json": seriesAuthorization,
  });
  const runCalls = [];
  const result = await runIbmPhysicalSessionCli({
    argv: [
      "series",
      "--plan", "plan.json",
      "--request", "request.json",
      "--baseline", "baseline.json",
      "--prior-smoke-result", "prior-smoke.json",
      "--series-authorization", "series-auth.json",
      "--out", "series-result.json",
    ],
    env: {
      IBM_QUANTUM_API_KEY: "runtime-only-series-key",
      IBM_QUANTUM_INSTANCE_CRN: "crn:v1:runtime-only-series",
    },
    readJson: io.readJson,
    writeJson: io.writeJson,
    coordinatorFactory() {
      return Object.freeze({
        async run(args) {
          runCalls.push(args);
          return Object.freeze({
            sessionReport: Object.freeze({
              phase: IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
              verdict: "PASS",
              confirmedPhysicalJobCount: 6,
              quantumAdvantageClaimAllowed: false,
            }),
          });
        },
      });
    },
  });
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionPhase, IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES);
  assert.deepEqual(runCalls[0].physicalRequest, request);
  assert.deepEqual(runCalls[0].baselineProfile, baseline);
  assert.deepEqual(runCalls[0].priorSmokeGateResult, priorSmoke);
  assert.deepEqual(runCalls[0].repeatedSeriesAuthorizationRecord, seriesAuthorization);
  assert.equal(result.value.sessionReport.confirmedPhysicalJobCount, 6);
  assert.equal(result.value.sessionReport.quantumAdvantageClaimAllowed, false);
});
