const FORBIDDEN_CHILD_ENV_NAME = /(TOKEN|SECRET|KEY|PASSWORD)/i;

/** Environment variables that MCP child processes may inherit from the server. */
export const NEXUS_MCP_CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NODE_ENV",
  "SOURCE_DATE_EPOCH",
  "NEXUS_DETERMINISTIC_BUILD",
  "NEXUS_ENFORCE_NETWORK_ISOLATION",
] as const);

/** Build a fresh, auditable environment rather than copying process.env. */
export function childProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configured = (environment.NEXUS_MCP_CHILD_ENV_ALLOW ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const names = new Set<string>([...NEXUS_MCP_CHILD_ENV_ALLOWLIST, ...configured]);
  const child: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (FORBIDDEN_CHILD_ENV_NAME.test(name)) continue;
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  return child;
}
