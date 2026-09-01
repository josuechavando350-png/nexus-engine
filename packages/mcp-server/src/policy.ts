export const TOOL_NAMES = ["nexus_status", "nexus_projects", "nexus_gates", "nexus_passport", "nexus_capture", "nexus_build", "nexus_comparator", "nexus_project_new", "nexus_operator"] as const;
export type NexusToolName = typeof TOOL_NAMES[number];

export const REMOTE_READINESS_DEFAULT_TOOLS = Object.freeze(["nexus_status", "nexus_projects"] as const);
export const DEFAULT_MAX_CONCURRENCY = 2;
export const MIN_MAX_CONCURRENCY = 1;
export const MAX_MAX_CONCURRENCY = 16;
export const MIN_EXECUTION_TIMEOUT_MS = 1_000;
export const MAX_EXECUTION_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MIN_MAX_ARTIFACT_BYTES = 1_024;
export const MAX_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MIN_MAX_PROCESS_OUTPUT_BYTES = 1_024;
export const MAX_MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

const DISCONNECTED_TOOLS = new Set<NexusToolName>(["nexus_comparator"]);

export interface RuntimeLimits {
  maxConcurrency: number;
  executionTimeoutMs: number | undefined;
  maxArtifactBytes: number;
  maxProcessOutputBytes: number;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  return parsed;
}

export function runtimeLimitsFromEnv(environment: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return Object.freeze({
    maxConcurrency: boundedInteger(environment.NEXUS_MCP_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, MIN_MAX_CONCURRENCY, MAX_MAX_CONCURRENCY, "NEXUS_MCP_MAX_CONCURRENCY"),
    executionTimeoutMs: environment.NEXUS_MCP_EXECUTION_TIMEOUT_MS === undefined
      ? undefined
      : boundedInteger(environment.NEXUS_MCP_EXECUTION_TIMEOUT_MS, MIN_EXECUTION_TIMEOUT_MS, MIN_EXECUTION_TIMEOUT_MS, MAX_EXECUTION_TIMEOUT_MS, "NEXUS_MCP_EXECUTION_TIMEOUT_MS"),
    maxArtifactBytes: boundedInteger(environment.NEXUS_MCP_MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_BYTES, MIN_MAX_ARTIFACT_BYTES, MAX_MAX_ARTIFACT_BYTES, "NEXUS_MCP_MAX_ARTIFACT_BYTES"),
    maxProcessOutputBytes: boundedInteger(environment.NEXUS_MCP_MAX_PROCESS_OUTPUT_BYTES, DEFAULT_MAX_PROCESS_OUTPUT_BYTES, MIN_MAX_PROCESS_OUTPUT_BYTES, MAX_MAX_PROCESS_OUTPUT_BYTES, "NEXUS_MCP_MAX_PROCESS_OUTPUT_BYTES"),
  });
}

export function enabledToolsFromEnv(value = process.env.NEXUS_MCP_ENABLED_TOOLS): ReadonlySet<NexusToolName> {
  const requested = value === undefined ? [...REMOTE_READINESS_DEFAULT_TOOLS] : value.split(",").map((item) => item.trim()).filter(Boolean);
  const known = new Set<string>(TOOL_NAMES);
  for (const name of requested) {
    if (!known.has(name)) throw new Error(`unknown NEXUS MCP tool in NEXUS_MCP_ENABLED_TOOLS: ${name}`);
    if (DISCONNECTED_TOOLS.has(name as NexusToolName)) throw new Error(`NEXUS MCP tool is not remotely enableable until its real runtime is connected: ${name}`);
  }
  return new Set(requested as NexusToolName[]);
}
