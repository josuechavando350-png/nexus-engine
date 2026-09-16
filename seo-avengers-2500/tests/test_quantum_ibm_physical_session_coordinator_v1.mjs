import assert from "node:assert/strict";
import test from "node:test";

import { canonicalQuantumSha256 } from "../quantum-runtime/common.mjs";
import { buildPhysicalQpuFirstRunPlan } from "../quantum-runtime/physical-first-run-plan.mjs";
import {
  IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID,
} from "../quantum-runtime/providers/ibm/ibm-physical-smoke-gate.mjs";
import {
  IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID,
} from "../quantum-runtime/providers/ibm/ibm-repeated-series-gate.mjs";
import {
  createIbmPhysicalSessionCoordinatorForContractTest,
  IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
  IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
  IBM_PHYSICAL_SESSION_PREPARE_ONLY,
} from "../quantum-runtime/providers/ibm/ibm-physical-session-coordinator.mjs";

function planFor({ backendName = "ibm_contract_qpu" } = {}) {
  return buildPhysicalQpuFirstRunPlan({
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    backendName,
    transpilerSeed: 1337,
    evidenceRoot: "/tmp/nexus-quantum-one-session-contract",
    smokeShots: 64,
    repeatedShots: 128,
    repeatedRunCount: 5,
    bridgeTimeoutMillis: 5_000,
  });
}

function report(unsigned) {
  return Object.freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
}

function verifiedSmokeResult(plan) {
  const smokeExecution = Object.freeze({
    schemaVersion: 1,
    verdict: "PASS",
    reasonCodes: Object.freeze(["PHYSICAL_QPU_EXECUTION_RECEIPT_VERIFIED"]),
    executionReceipt: Object.freeze({ jobId: "contract-smoke-job-1" }),
  });
  const gateReport = report({
    schemaVersion: 1,
    engineId: IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    planSha256: plan.planSha256,
    provider: plan.provider,
    backendName: plan.backendName,
    verdict: "PASS",
    status: "SINGLE_PHYSICAL_SMOKE_VERIFIED_REPEATED_SERIES_AUTHORIZED",
    reasons: [],
    smokeExecutionSha256: canonicalQuantumSha256(smokeExecution),
    smokeProviderJobId: "contract-smoke-job-1",
    confirmedPhysicalJobCount: 1,
    repeatedSeriesExecutionCount: 0,
    repeatedSeriesAuthorized: true,
    providerReconciliationRequired: false,
    quantumAdvantageClaimAllowed: false,
  });
  return Object.freeze({ preparationRecord: null, preflight: Object.freeze({}), smokeExecution, gateReport });
}

function prepareSmokeResult(plan) {
  return Object.freeze({
    preparationRecord: Object.freeze({ hardwareInvocationCount: 0 }),
    preflight: null,
    smokeExecution: null,
    gateReport: report({
      schemaVersion: 1,
      engineId: IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID,
      sourceRevision: plan.sourceRevision,
      sourceTree: plan.sourceTree,
      planSha256: plan.planSha256,
      provider: plan.provider,
      backendName: plan.backendName,
      verdict: "NOT_TESTED",
      status: "PREPARED_PHYSICAL_QPU_RUN_NOT_AUTHORIZED_FOR_EXECUTION",
      reasons: ["PHYSICAL_QPU_EXECUTION_NOT_PERFORMED"],
      confirmedPhysicalJobCount: 0,
      repeatedSeriesAuthorized: false,
      providerReconciliationRequired: false,
      quantumAdvantageClaimAllowed: false,
    }),
  });
}

function repeatedPassResult(plan) {
  return Object.freeze({
    executions: Object.freeze([]),
    preflightReports: Object.freeze([]),
    physicalExperimentReport: Object.freeze({ verdict: "PASS" }),
    gateReport: report({
      schemaVersion: 1,
      engineId: IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID,
      sourceRevision: plan.sourceRevision,
      sourceTree: plan.sourceTree,
      planSha256: plan.planSha256,
      provider: plan.provider,
      backendName: plan.backendName,
      verdict: "PASS",
      status: "REPEATED_PHYSICAL_SERIES_VERIFIED_AND_CLASSICALLY_COMPARABLE",
      reasons: [],
      totalConfirmedPhysicalJobCountIncludingSmoke: 6,
      repeatedSeriesComplete: true,
      providerReconciliationRequired: false,
      quantumAdvantageClaimAllowed: false,
    }),
  });
}

function coordinator(plan, { smokeResult = verifiedSmokeResult(plan), repeatedResult = repeatedPassResult(plan) } = {}) {
  const calls = { smoke: [], repeated: [] };
  const smokeGate = Object.freeze({
    engineId: IBM_PHYSICAL_QPU_SMOKE_GATE_ENGINE_ID,
    async run(args) {
      calls.smoke.push(args);
      return args.executionAuthorization === "PREPARE_ONLY" ? prepareSmokeResult(plan) : smokeResult;
    },
  });
  const repeatedSeriesGate = Object.freeze({
    engineId: IBM_REPEATED_PHYSICAL_SERIES_GATE_ENGINE_ID,
    async run(args) {
      calls.repeated.push(args);
      return repeatedResult;
    },
  });
  return {
    calls,
    value: createIbmPhysicalSessionCoordinatorForContractTest({ plan, smokeGate, repeatedSeriesGate }),
  };
}

test("contract coordinator is restricted to explicit contract backend names", () => {
  const plan = planFor({ backendName: "ibm_real_backend_name" });
  assert.throws(
    () => createIbmPhysicalSessionCoordinatorForContractTest({ plan, smokeGate: {}, repeatedSeriesGate: {} }),
    /backendName containing 'contract'/,
  );
});

test("prepare-only session calls only the smoke prepare path and remains blocked", async () => {
  const plan = planFor();
  const { value, calls } = coordinator(plan);
  const result = await value.run({ sessionPhase: IBM_PHYSICAL_SESSION_PREPARE_ONLY });
  assert.equal(calls.smoke.length, 1);
  assert.equal(calls.smoke[0].executionAuthorization, "PREPARE_ONLY");
  assert.equal(calls.repeated.length, 0);
  assert.equal(result.sessionReport.verdict, "NOT_TESTED");
  assert.equal(result.sessionReport.confirmedPhysicalJobCount, 0);
  assert.equal(result.sessionReport.automaticPhaseChainingAllowed, false);
  assert.equal(result.sessionReport.quantumAdvantageClaimAllowed, false);
});

test("smoke phase rejects any attempt to pre-authorize the repeated series before the smoke", async () => {
  const plan = planFor();
  const { value, calls } = coordinator(plan);
  await assert.rejects(
    value.run({
      sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
      physicalRequest: Object.freeze({}),
      smokeAuthorizationRecord: Object.freeze({ authorizationSha256: "smoke-auth" }),
      repeatedSeriesAuthorizationRecord: Object.freeze({ authorizationSha256: "series-auth-too-early" }),
    }),
    /cannot pre-authorize or chain the repeated series/,
  );
  assert.equal(calls.smoke.length, 0);
  assert.equal(calls.repeated.length, 0);
});

test("verified smoke ends the call without automatically chaining repeated physical jobs", async () => {
  const plan = planFor();
  const { value, calls } = coordinator(plan);
  const result = await value.run({
    sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
    physicalRequest: Object.freeze({ requestId: "contract-request" }),
    smokeAuthorizationRecord: Object.freeze({ authorizationSha256: "contract-smoke-auth" }),
  });
  assert.equal(calls.smoke.length, 1);
  assert.equal(calls.smoke[0].executionAuthorization, "EXECUTE_PHYSICAL_QPU");
  assert.equal(calls.repeated.length, 0);
  assert.equal(result.sessionReport.verdict, "INCONCLUSIVE");
  assert.equal(result.sessionReport.smokeVerified, true);
  assert.equal(result.sessionReport.repeatedSeriesComplete, false);
  assert.equal(result.sessionReport.confirmedPhysicalJobCount, 1);
  assert.equal(result.sessionReport.automaticPhaseChainingAllowed, false);
  assert.ok(result.sessionReport.reasons.includes("REPEATED_PHYSICAL_SERIES_NOT_YET_SEPARATELY_AUTHORIZED"));
});

test("tampered prior smoke evidence is rejected before the repeated-series gate is called", async () => {
  const plan = planFor();
  const smoke = verifiedSmokeResult(plan);
  const tampered = Object.freeze({
    ...smoke,
    gateReport: Object.freeze({ ...smoke.gateReport, status: "TAMPERED_STATUS" }),
  });
  const { value, calls } = coordinator(plan);
  await assert.rejects(
    value.run({
      sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
      physicalRequest: Object.freeze({ requestId: "contract-request" }),
      baselineProfile: Object.freeze({ profileId: "contract-baseline" }),
      priorSmokeGateResult: tampered,
      repeatedSeriesAuthorizationRecord: Object.freeze({ authorizationSha256: "contract-series-auth" }),
    }),
    /smoke gate report digest mismatch/,
  );
  assert.equal(calls.smoke.length, 0);
  assert.equal(calls.repeated.length, 0);
});

test("repeated series requires a separate post-smoke authorization and can complete the planned session", async () => {
  const plan = planFor();
  const smoke = verifiedSmokeResult(plan);
  const { value, calls } = coordinator(plan);
  await assert.rejects(
    value.run({
      sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
      physicalRequest: Object.freeze({ requestId: "contract-request" }),
      baselineProfile: Object.freeze({ profileId: "contract-baseline" }),
      priorSmokeGateResult: smoke,
    }),
    /requires separate authorization record/,
  );
  assert.equal(calls.repeated.length, 0);

  const result = await value.run({
    sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
    physicalRequest: Object.freeze({ requestId: "contract-request" }),
    baselineProfile: Object.freeze({ profileId: "contract-baseline" }),
    priorSmokeGateResult: smoke,
    repeatedSeriesAuthorizationRecord: Object.freeze({ authorizationSha256: "contract-series-auth" }),
  });
  assert.equal(calls.smoke.length, 0);
  assert.equal(calls.repeated.length, 1);
  assert.equal(calls.repeated[0].executionAuthorization, "EXECUTE_PHYSICAL_QPU");
  assert.equal(result.sessionReport.verdict, "PASS");
  assert.equal(result.sessionReport.confirmedPhysicalJobCount, 6);
  assert.equal(result.sessionReport.smokeVerified, true);
  assert.equal(result.sessionReport.repeatedSeriesComplete, true);
  assert.equal(result.sessionReport.automaticPhaseChainingAllowed, false);
  assert.equal(result.sessionReport.quantumAdvantageClaimAllowed, false);
});
