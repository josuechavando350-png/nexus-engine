import { deepFreeze, sha256Canonical } from "./common.mjs";
import { executeGaussIsingQaoaSimulation } from "../../seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs";

const ISING_LAYER = "GAUSS.PHYSICS.ISING_EXACT_GROUND.003";
const PARAMETER_SETS = Object.freeze([
  { parameterSetId: "grid-01", gammaMicroradians: [250_000], betaMicroradians: [125_000] },
  { parameterSetId: "grid-02", gammaMicroradians: [500_000], betaMicroradians: [250_000] },
  { parameterSetId: "grid-03", gammaMicroradians: [785_398], betaMicroradians: [392_699] },
  { parameterSetId: "grid-04", gammaMicroradians: [1_000_000], betaMicroradians: [500_000] },
  { parameterSetId: "grid-05", gammaMicroradians: [1_250_000], betaMicroradians: [625_000] },
  { parameterSetId: "grid-06", gammaMicroradians: [1_570_796], betaMicroradians: [785_398] },
  { parameterSetId: "grid-07", gammaMicroradians: [500_000, 1_000_000], betaMicroradians: [250_000, 500_000] },
  { parameterSetId: "grid-08", gammaMicroradians: [785_398, 1_570_796], betaMicroradians: [392_699, 785_398] },
]);

export async function contributeNexusQuantum({ problem, taskResults, problemSha256 }) {
  const task = problem.tasks.find((row) => row.layerId === ISING_LAYER);
  if (!task) {
    const unsigned = {
      schemaVersion: 1,
      engineId: "NEXUS_QUANTUM",
      status: "NOT_APPLICABLE",
      problemSha256,
      reasonCodes: ["NO_ISING_SUBPROBLEM"],
      hardwareExecution: false,
      quantumAdvantageClaimAllowed: false,
    };
    return deepFreeze({ ...unsigned, receiptSha256: sha256Canonical(unsigned) });
  }
  const result = taskResults.find((row) => row.taskId === task.taskId);
  if (!result || result.status !== "EXECUTED") throw new Error("Ising task must execute before Quantum contribution");
  const simulation = executeGaussIsingQaoaSimulation({
    problem: {
      problemId: `${problem.problemId}:ising`,
      fields: task.input.fields,
      couplings: task.input.couplings ?? [],
      offset: task.input.offset ?? 0,
    },
    parameterSets: PARAMETER_SETS,
  });
  return deepFreeze({
    schemaVersion: 1,
    engineId: "NEXUS_QUANTUM",
    status: "EXECUTED",
    problemSha256,
    sourceTaskId: task.taskId,
    sourceTaskOutputSha256: result.outputSha256,
    simulation,
  });
}
