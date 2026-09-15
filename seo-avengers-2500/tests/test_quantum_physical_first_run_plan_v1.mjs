import assert from "node:assert/strict";
import test from "node:test";

import { canonicalQuantumSha256 } from "../quantum-runtime/common.mjs";
import {
  buildPhysicalQpuFirstRunPlan,
  buildPhysicalQpuPreparationRecord,
  PHYSICAL_QPU_FIRST_RUN_MIN_REPEATED_RUNS,
  validatePhysicalQpuFirstRunPlan,
} from "../quantum-runtime/physical-first-run-plan.mjs";
import {
  createIbmQuantumComputeBackend,
  IBM_QUANTUM_COMPUTE_ADAPTER_ID,
} from "../quantum-runtime/providers/ibm/ibm-qpu-adapter.mjs";

const SOURCE_REVISION = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);

function validInput(overrides = {}) {
  return {
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    backendName: "ibm_candidate_qpu",
    transpilerSeed: 1337,
    evidenceRoot: "/var/lib/nexus/quantum-evidence/first-physical-run",
    smokeShots: 128,
    repeatedShots: 256,
    repeatedRunCount: PHYSICAL_QPU_FIRST_RUN_MIN_REPEATED_RUNS,
    perJobTimeoutMillis: 900_000,
    ...overrides,
  };
}

test("first physical QPU plan is deterministic, hash-bound, and bounded before live execution", () => {
  const first = buildPhysicalQpuFirstRunPlan(validInput());
  const second = buildPhysicalQpuFirstRunPlan(validInput());

  assert.deepEqual(first, second);
  assert.equal(first.provider, "IBM_QUANTUM_COMPUTE");
  assert.equal(first.executionInterlock.prepareOnlyAuthorization, "PREPARE_ONLY");
  assert.equal(first.executionInterlock.liveExecutionAuthorization, "EXECUTE_PHYSICAL_QPU");
  assert.equal(first.smokeJob.runCount, 1);
  assert.equal(first.repeatedSeries.runCount, 5);
  assert.equal(first.repeatedSeries.minimumCompletedRuns, 5);
  assert.equal(first.limits.maximumProviderJobs, 6);
  assert.equal(first.limits.maximumTotalShots, 1_408);
  assert.equal(first.limits.maximumSequentialWallTimeMillis, 5_400_000);
  assert.equal(first.providerCostControl.billingApiIntegrated, false);
  assert.equal(first.providerCostControl.liveExecutionRequiresExternalConfirmation, true);
  assert.equal(first.quantumAdvantageClaimAllowed, false);

  const { planSha256, ...unsigned } = first;
  assert.equal(planSha256, canonicalQuantumSha256(unsigned));
  assert.strictEqual(validatePhysicalQpuFirstRunPlan(first), first);
});

test("first physical QPU plan rejects simulators, weak repetition, invalid seeds, and hidden input fields", () => {
  assert.throws(
    () => buildPhysicalQpuFirstRunPlan(validInput({ backendName: "ibm_statevector_simulator" })),
    /simulator\/fake\/test backend/,
  );
  assert.throws(
    () => buildPhysicalQpuFirstRunPlan(validInput({ repeatedRunCount: 4 })),
    /physical repeated runCount must be integer in range/,
  );
  assert.throws(
    () => buildPhysicalQpuFirstRunPlan(validInput({ transpilerSeed: -1 })),
    /physical plan transpilerSeed must be integer in range/,
  );
  assert.throws(
    () => buildPhysicalQpuFirstRunPlan({ ...validInput(), apiKey: "must-never-be-a-plan-field" }),
    /unexpected physical QPU first-run plan input keys/,
  );
});

test("tampering any hash-bound first-run plan field fails validation", () => {
  const plan = buildPhysicalQpuFirstRunPlan(validInput());
  const tampered = structuredClone(plan);
  tampered.repeatedSeries.shots += 1;
  assert.throws(() => validatePhysicalQpuFirstRunPlan(tampered), /derived execution limits mismatch|digest mismatch/);
});

test("IBM preparation record is explicitly NOT_TESTED and cannot masquerade as hardware evidence", () => {
  const plan = buildPhysicalQpuFirstRunPlan(validInput());
  const backend = createIbmQuantumComputeBackend();
  assert.equal(backend.descriptor.adapterId, IBM_QUANTUM_COMPUTE_ADAPTER_ID);

  const record = buildPhysicalQpuPreparationRecord({ plan, backendDescriptor: backend.descriptor });
  assert.equal(record.executionAuthorization, "PREPARE_ONLY");
  assert.equal(record.hardwareInvocationCount, 0);
  assert.equal(record.verdict, "NOT_TESTED");
  assert.equal(record.status, "PREPARED_PHYSICAL_QPU_RUN_NOT_AUTHORIZED_FOR_EXECUTION");
  assert.equal(record.providerCostOrEntitlementConfirmed, false);
  assert.equal(record.quantumAdvantageClaimAllowed, false);
  assert.equal(record.planSha256, plan.planSha256);
  assert.ok(!Object.hasOwn(record, "apiKey"));
  assert.ok(!Object.hasOwn(record, "instanceCrn"));
});

test("preparation record refuses non-IBM or non-physical adapter descriptors", () => {
  const plan = buildPhysicalQpuFirstRunPlan(validInput());
  const invalidDescriptor = {
    schemaVersion: 1,
    adapterId: "NEXUS_SIMULATOR_ADAPTER_V1",
    adapterVersion: "1.0.0",
    backendFamily: "SIMULATOR",
    hardwareExecution: false,
  };
  assert.throws(
    () => buildPhysicalQpuPreparationRecord({ plan, backendDescriptor: invalidDescriptor }),
    /requires the IBM physical QPU adapter descriptor/,
  );
});
