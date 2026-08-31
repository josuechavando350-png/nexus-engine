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
 * Production orchestration entry point. Provider transports only supply proposal data;
 * NEXUS governance and the NEXUS-owned executor remain injected server-side.
 */
export async function executeGovernedAdvisory(
  input: AdvisoryExecutionInput,
  dependencies: AdvisoryRuntimeDependencies,
): Promise<AdvisoryExecutionOutcome> {
  const runtime = new GovernedAdvisoryRuntime(dependencies.policy, dependencies.governance, dependencies.executor);
  return await runtime.execute(input);
}

export async function ingestGovernedAdvisory(
  source: AdvisoryProposalSource,
  approval: AdvisoryApproval,
  idempotencyKey: string,
  now: string,
  dependencies: AdvisoryRuntimeDependencies,
  signal?: AbortSignal,
): Promise<AdvisoryExecutionOutcome> {
  const runtime = new GovernedAdvisoryRuntime(dependencies.policy, dependencies.governance, dependencies.executor);
  return await runtime.ingest(source, approval, idempotencyKey, now, signal);
}
