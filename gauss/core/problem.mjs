import {
  GAUSS_ENGINE_ID,
  GAUSS_SCHEMA_VERSION,
  assertArray,
  assertExactKeys,
  assertObject,
  assertToken,
  deepFreeze,
  sha256Canonical,
} from "./common.mjs";
import { gaussRegistrySummary, getGaussLayer } from "./registry.mjs";

const QUANTUM_ISING_LAYER = "GAUSS.PHYSICS.ISING_EXACT_GROUND.003";

export function validateGaussProblem(problem) {
  assertExactKeys(problem, ["objective", "problemId", "schemaVersion", "tasks"], "GAUSS problem");
  if (problem.schemaVersion !== GAUSS_SCHEMA_VERSION) throw new TypeError("unsupported GAUSS problem schemaVersion");
  const problemId = assertToken(problem.problemId, "problemId");
  if (typeof problem.objective !== "string" || problem.objective.trim().length < 1 || problem.objective.length > 16_384) {
    throw new TypeError("objective must be a non-empty bounded string");
  }
  const tasks = assertArray(problem.tasks, "tasks", { min: 1, max: 800 }).map((task, index) => {
    assertExactKeys(task, ["input", "layerId", "taskId"], `tasks[${index}]`);
    const taskId = assertToken(task.taskId, `tasks[${index}].taskId`);
    const layerId = assertToken(task.layerId, `tasks[${index}].layerId`);
    assertObject(task.input, `tasks[${index}].input`);
    if (!getGaussLayer(layerId)) throw new TypeError(`unimplemented GAUSS layer:${layerId}`);
    return deepFreeze({ taskId, layerId, input: structuredClone(task.input) });
  });
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new TypeError("GAUSS taskId values must be unique");
  return deepFreeze({ schemaVersion: GAUSS_SCHEMA_VERSION, problemId, objective: problem.objective.normalize("NFC").trim(), tasks });
}

export async function executeGaussProblem(problem, { quantumContributor } = {}) {
  if (typeof quantumContributor !== "function") {
    throw new TypeError("Nexus Quantum contributor is required; GAUSS cannot bypass Quantum");
  }
  const normalized = validateGaussProblem(problem);
  const problemSha256 = sha256Canonical(normalized);
  const results = [];
  const errors = [];
  for (const task of normalized.tasks) {
    const layer = getGaussLayer(task.layerId);
    const inputSha256 = sha256Canonical(task.input);
    try {
      const output = await layer.execute(task.input);
      const outputSha256 = sha256Canonical(output);
      results.push(deepFreeze({
        taskId: task.taskId,
        layerId: layer.id,
        domain: layer.domain,
        status: "EXECUTED",
        inputSha256,
        output,
        outputSha256,
      }));
    } catch (error) {
      const message = String(error?.message ?? error).replace(/[\r\n]+/gu, " ").slice(0, 2_048);
      results.push(deepFreeze({
        taskId: task.taskId,
        layerId: layer.id,
        domain: layer.domain,
        status: "FAILED",
        inputSha256,
        output: null,
        outputSha256: null,
      }));
      errors.push(`${task.taskId}:${message}`);
    }
  }
  let quantum = null;
  try {
    quantum = await quantumContributor({ problem: normalized, taskResults: deepFreeze([...results]), problemSha256 });
    const requiresIsing = normalized.tasks.some((task) => task.layerId === QUANTUM_ISING_LAYER);
    const requiredStatus = requiresIsing ? "EXECUTED" : "NOT_APPLICABLE";
    if (!quantum || quantum.engineId !== "NEXUS_QUANTUM" || quantum.problemSha256 !== problemSha256 || quantum.status !== requiredStatus) {
      throw new Error(`Nexus Quantum must provide a problem-bound ${requiredStatus} receipt`);
    }
    if (requiresIsing && (quantum.simulation?.verdict !== "PASS" || quantum.simulation?.hardwareExecution !== false
      || quantum.simulation?.quantumAdvantageClaimAllowed !== false)) {
      throw new Error("Nexus Quantum Ising simulation receipt is incomplete or misrepresents hardware");
    }
  } catch (error) {
    errors.push(`QUANTUM:${String(error?.message ?? error).replace(/[\r\n]+/gu, " ").slice(0, 2_048)}`);
  }
  const executedLayerCount = results.filter((row) => row.status === "EXECUTED").length;
  const failedLayerCount = results.length - executedLayerCount;
  const unsigned = {
    schemaVersion: GAUSS_SCHEMA_VERSION,
    engineId: GAUSS_ENGINE_ID,
    status: errors.length === 0 ? "PASS" : "BLOCKED",
    problemId: normalized.problemId,
    objective: normalized.objective,
    problemSha256,
    registry: gaussRegistrySummary(),
    executedLayerCount,
    failedLayerCount,
    taskResults: results,
    quantumContribution: quantum,
    errors,
  };
  return deepFreeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
