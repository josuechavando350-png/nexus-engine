export const TOOL_NAMES = ["nexus_status", "nexus_projects", "nexus_gates", "nexus_passport", "nexus_capture", "nexus_build", "nexus_comparator", "nexus_project_new"] as const;
export type NexusToolName = typeof TOOL_NAMES[number];

export const REMOTE_READINESS_DEFAULT_TOOLS = Object.freeze(["nexus_status", "nexus_projects"] as const);
export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RuntimeLimits {
  maxConcurrency: number;
  executionTimeoutMs: number | undefined;
  maxArtifactBytes: number;
  maxProcessOutputBytes: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function runtimeLimitsFromEnv(environment: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return Object.freeze({
    maxConcurrency: positiveInteger(environment.NEXUS_MCP_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, "NEXUS_MCP_MAX_CONCURRENCY"),
    executionTimeoutMs: environment.NEXUS_MCP_EXECUTION_TIMEOUT_MS === undefined ? undefined : positiveInteger(environment.NEXUS_MCP_EXECUTION_TIMEOUT_MS, 1, "NEXUS_MCP_EXECUTION_TIMEOUT_MS"),
    maxArtifactBytes: positiveInteger(environment.NEXUS_MCP_MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_BYTES, "NEXUS_MCP_MAX_ARTIFACT_BYTES"),
    maxProcessOutputBytes: positiveInteger(environment.NEXUS_MCP_MAX_PROCESS_OUTPUT_BYTES, DEFAULT_MAX_PROCESS_OUTPUT_BYTES, "NEXUS_MCP_MAX_PROCESS_OUTPUT_BYTES"),
  });
}

export function enabledToolsFromEnv(value = process.env.NEXUS_MCP_ENABLED_TOOLS): ReadonlySet<NexusToolName> {
  const requested = value === undefined ? [...REMOTE_READINESS_DEFAULT_TOOLS] : value.split(",").map((item) => item.trim()).filter(Boolean);
  const known = new Set<string>(TOOL_NAMES);
  for (const name of requested) if (!known.has(name)) throw new Error(`unknown NEXUS MCP tool in NEXUS_MCP_ENABLED_TOOLS: ${name}`);
  return new Set(requested as NexusToolName[]);
}
