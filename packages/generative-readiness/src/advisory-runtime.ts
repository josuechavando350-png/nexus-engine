import {
  GovernedAdvisoryRuntime,
  type AdvisoryApproval,
  type AdvisoryExecutionInput,
  type AdvisoryExecutionOutcome,
  type AdvisoryProposalSource,
  type AdvisoryRuntimePolicy,
  type NexusAdvisoryExecutor,
  type NexusAdvisoryGovernancePort,
} from "./provider-boundary.js";

export interface AdvisoryRuntimeDependencies {
  readonly policy: AdvisoryRuntimePolicy;
  readonly governance: NexusAdvisoryGovernancePort;
  readonly executor: NexusAdvisoryExecutor;
}

/**
 * Create one long-lived, server-side runtime for a governed advisory scope.
 * Reusing the same instance is required so idempotency bindings, in-flight
 * coalescing, terminal uncertainty and the audit chain survive across calls.
 * Provider transports only supply proposal data; they never receive this runtime.
 */
export function createGovernedAdvisoryRuntime(
  dependencies: AdvisoryRuntimeDependencies,
): GovernedAdvisoryRuntime {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("advisory runtime dependencies must be an object");
  }
  const keys = Object.keys(dependencies);
  if (keys.length !== 3 || !keys.includes("policy") || !keys.includes("governance") || !keys.includes("executor")) {
    throw new Error("advisory runtime dependencies contain unknown or missing fields");
  }
  return new GovernedAdvisoryRuntime(dependencies.policy, dependencies.governance, dependencies.executor);
}

/**
 * Production execution entry point. The caller owns a long-lived runtime created
 * once at service startup; this function never creates a fresh security state.
 */
export async function executeGovernedAdvisory(
  runtime: GovernedAdvisoryRuntime,
  input: AdvisoryExecutionInput,
): Promise<AdvisoryExecutionOutcome> {
  if (!(runtime instanceof GovernedAdvisoryRuntime)) throw new Error("governed advisory runtime is required");
  return await runtime.execute(input);
}

export async function ingestGovernedAdvisory(
  runtime: GovernedAdvisoryRuntime,
  source: AdvisoryProposalSource,
  approval: AdvisoryApproval,
  idempotencyKey: string,
  now: string,
  signal?: AbortSignal,
): Promise<AdvisoryExecutionOutcome> {
  if (!(runtime instanceof GovernedAdvisoryRuntime)) throw new Error("governed advisory runtime is required");
  return await runtime.ingest(source, approval, idempotencyKey, now, signal);
}
