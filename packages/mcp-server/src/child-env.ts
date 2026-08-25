import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORBIDDEN_CHILD_ENV_NAME = /(TOKEN|SECRET|KEY|PASSWORD)/i;

/** Environment variables that MCP child processes may inherit directly from the server. */
export const NEXUS_MCP_CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
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

/** Optional variables an administrator may explicitly forward after code review. */
export const NEXUS_MCP_CHILD_ENV_EXTENSION_ALLOWLIST = Object.freeze([
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
] as const);

const EXTENSION_ALLOWLIST = new Set<string>(NEXUS_MCP_CHILD_ENV_EXTENSION_ALLOWLIST);
const CHILD_HOME = mkdtempSync(join(tmpdir(), "nexus-mcp-child-home-"));
const CHILD_XDG_CONFIG_HOME = join(CHILD_HOME, ".config");
const CHILD_XDG_CACHE_HOME = join(CHILD_HOME, ".cache");
const CHILD_NPM_USERCONFIG = join(CHILD_HOME, ".npmrc");
mkdirSync(CHILD_XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
mkdirSync(CHILD_XDG_CACHE_HOME, { recursive: true, mode: 0o700 });

function configuredExtensions(environment: NodeJS.ProcessEnv): readonly string[] {
  const configured = (environment.NEXUS_MCP_CHILD_ENV_ALLOW ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of configured) {
    if (FORBIDDEN_CHILD_ENV_NAME.test(name)) {
      throw new Error(`NEXUS_MCP_CHILD_ENV_ALLOW rejects sensitive variable ${name}`);
    }
    if (!EXTENSION_ALLOWLIST.has(name)) {
      throw new Error(`NEXUS_MCP_CHILD_ENV_ALLOW variable ${name} is not in the reviewed extension allowlist`);
    }
  }
  return configured;
}

/** Build a fresh, auditable environment rather than copying process.env. */
export function childProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    HOME: CHILD_HOME,
    XDG_CONFIG_HOME: CHILD_XDG_CONFIG_HOME,
    XDG_CACHE_HOME: CHILD_XDG_CACHE_HOME,
    NPM_CONFIG_USERCONFIG: CHILD_NPM_USERCONFIG,
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const name of NEXUS_MCP_CHILD_ENV_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  for (const name of configuredExtensions(environment)) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  return child;
}
