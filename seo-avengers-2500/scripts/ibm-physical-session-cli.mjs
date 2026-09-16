#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { sha, text, TOKEN_RE } from "../quantum-runtime/common.mjs";
import {
  buildPhysicalQpuFirstRunPlan,
  validatePhysicalQpuFirstRunPlan,
} from "../quantum-runtime/physical-first-run-plan.mjs";
import {
  buildPhysicalQpuLiveAuthorizationRecord,
} from "../quantum-runtime/providers/ibm/ibm-physical-smoke-gate.mjs";
import {
  buildRepeatedPhysicalSeriesAuthorizationRecord,
} from "../quantum-runtime/providers/ibm/ibm-repeated-series-gate.mjs";
import {
  createIbmPhysicalSessionCoordinator,
  IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
  IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
  IBM_PHYSICAL_SESSION_PREPARE_ONLY,
} from "../quantum-runtime/providers/ibm/ibm-physical-session-coordinator.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const LIVE_COMMANDS = new Set(["smoke", "series"]);
const AUTH_COMMANDS = new Set(["authorize-smoke", "authorize-series"]);
const COMMANDS = new Set(["plan", "prepare", ...AUTH_COMMANDS, ...LIVE_COMMANDS]);
const FLAG_OPTIONS = new Set(["--confirm-provider-cost-or-entitlement"]);
const VALUE_OPTIONS = new Set([
  "--backend",
  "--baseline",
  "--bridge-timeout-ms",
  "--ci-status",
  "--evidence-root",
  "--out",
  "--plan",
  "--prior-smoke-result",
  "--provider-cost-reference",
  "--python",
  "--repeated-runs",
  "--repeated-shots",
  "--request",
  "--series-authorization",
  "--smoke-authorization",
  "--smoke-shots",
  "--transpiler-seed",
  "--walle-artifact-sha256",
  "--walle-summary",
]);
const FORBIDDEN_SECRET_OPTIONS = new Set([
  "--api-key",
  "--apikey",
  "--ibm-api-key",
  "--ibm-token",
  "--instance-crn",
  "--password",
  "--secret",
  "--token",
]);
const FORBIDDEN_PERSISTED_KEY_FRAGMENTS = Object.freeze([
  "apikey",
  "instancecrn",
  "password",
  "secret",
  "token",
]);

function fail(message) {
  throw new Error(`IBM_PHYSICAL_SESSION_CLI:${message}`);
}

function parseInteger(value, label, min, max) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`${label}_MUST_BE_DECIMAL_INTEGER`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${label}_OUT_OF_RANGE`);
  return parsed;
}

function required(options, key) {
  const value = options.values.get(key);
  if (typeof value !== "string" || value.length === 0) fail(`MISSING_${key.slice(2).replaceAll("-", "_").toUpperCase()}`);
  return value;
}

function rejectUnexpected(options, allowedValues, allowedFlags = new Set()) {
  for (const key of options.values.keys()) {
    if (!allowedValues.has(key)) fail(`OPTION_NOT_ALLOWED_FOR_COMMAND:${key}`);
  }
  for (const key of options.flags) {
    if (!allowedFlags.has(key)) fail(`FLAG_NOT_ALLOWED_FOR_COMMAND:${key}`);
  }
}

export function parseIbmPhysicalSessionCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) fail("COMMAND_REQUIRED");
  const command = String(argv[0]);
  if (!COMMANDS.has(command)) fail(`UNKNOWN_COMMAND:${command}`);
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (FORBIDDEN_SECRET_OPTIONS.has(arg)) fail(`SECRET_OPTION_FORBIDDEN:${arg}`);
    if (FLAG_OPTIONS.has(arg)) {
      if (flags.has(arg)) fail(`DUPLICATE_OPTION:${arg}`);
      flags.add(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) fail(`UNKNOWN_OPTION:${arg}`);
    if (values.has(arg)) fail(`DUPLICATE_OPTION:${arg}`);
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) fail(`MISSING_OPTION_VALUE:${arg}`);
    values.set(arg, String(value));
    index += 1;
  }
  return Object.freeze({ command, values, flags });
}

function normalizedPersistedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function assertNoPersistedCredentialKeys(value, label, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail(`${label}_CYCLIC_OBJECT`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedPersistedKey(key);
    if (FORBIDDEN_PERSISTED_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      fail(`${label}_CREDENTIAL_SHAPED_KEY_FORBIDDEN:${key}`);
    }
    assertNoPersistedCredentialKeys(child, label, seen);
  }
  seen.delete(value);
}

function assertNoCredentialValueLeak(serialized, credentials) {
  for (const value of credentials) {
    if (typeof value === "string" && value.length > 0 && serialized.includes(value)) {
      fail("OUTPUT_CONTAINS_RUNTIME_CREDENTIAL_MATERIAL");
    }
  }
}

async function defaultReadJson(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}_MUST_BE_REGULAR_NON_SYMLINK_FILE`);
  if (stat.size <= 0 || stat.size > MAX_JSON_BYTES) fail(`${label}_FILE_SIZE_INVALID`);
  const bytes = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail(`${label}_INVALID_JSON`);
  }
  assertNoPersistedCredentialKeys(value, label);
  return value;
}

async function defaultWriteJson(path, value, credentials = []) {
  if (typeof path !== "string" || path.trim().length === 0) fail("OUTPUT_PATH_REQUIRED");
  assertNoPersistedCredentialKeys(value, "OUTPUT");
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  assertNoCredentialValueLeak(serialized, credentials);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

async function defaultResolveGitIdentity() {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD", "HEAD^{tree}"],
    { cwd: DEFAULT_REPO_ROOT, encoding: "utf8", maxBuffer: 4_096, windowsHide: true },
  );
  const parts = String(stdout).trim().split(/\s+/u);
  if (parts.length !== 2 || !/^[0-9a-f]{40}$/u.test(parts[0]) || !/^[0-9a-f]{40}$/u.test(parts[1])) {
    fail("GIT_IDENTITY_INVALID");
  }
  return Object.freeze({ sourceRevision: parts[0], sourceTree: parts[1] });
}

function validateWalleSummary(summary, plan, artifactSha256, ciStatus) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) fail("WALLE_SUMMARY_OBJECT_REQUIRED");
  if (summary.source_revision !== plan.sourceRevision || summary.source_tree !== plan.sourceTree) {
    fail("WALLE_SUMMARY_SOURCE_MISMATCH");
  }
  const counts = summary.counts;
  if (!counts || counts.EXECUTED !== 2500 || counts.FAILED !== 0 || counts.BLOCKED !== 0 || counts.NOT_TESTED !== 0) {
    fail("WALLE_SUMMARY_EXECUTION_COUNTS_INCOMPLETE");
  }
  if (summary.full_execution_claim !== true || !Array.isArray(summary.validation_errors) || summary.validation_errors.length !== 0) {
    fail("WALLE_SUMMARY_FULL_EXECUTION_CLAIM_INVALID");
  }
  if (ciStatus !== "SUCCESS") fail("EXACT_HEAD_CI_STATUS_MUST_BE_SUCCESS");
  return Object.freeze({
    exactHeadCiStatus: ciStatus,
    walleArtifactSha256: sha(artifactSha256, "WALLE artifact sha256"),
    walleProofSha256: sha(summary.proof_sha256, "WALLE proof sha256"),
    walleExecutedModuleCount: counts.EXECUTED,
    walleFailedModuleCount: counts.FAILED,
    walleBlockedModuleCount: counts.BLOCKED,
    walleNotTestedModuleCount: counts.NOT_TESTED,
    fullExecutionClaim: summary.full_execution_claim,
  });
}

function providerConfirmation(options) {
  if (!options.flags.has("--confirm-provider-cost-or-entitlement")) {
    fail("PROVIDER_COST_OR_ENTITLEMENT_CONFIRMATION_REQUIRED");
  }
  return Object.freeze({
    providerCostOrEntitlementConfirmed: true,
    providerCostOrEntitlementReference: text(
      required(options, "--provider-cost-reference"),
      "provider cost/entitlement reference",
      { pattern: TOKEN_RE, maxBytes: 256 },
    ),
  });
}

function liveCredentials(env) {
  const apiKey = typeof env.IBM_QUANTUM_API_KEY === "string" ? env.IBM_QUANTUM_API_KEY.trim() : "";
  const instanceCrn = typeof env.IBM_QUANTUM_INSTANCE_CRN === "string" ? env.IBM_QUANTUM_INSTANCE_CRN.trim() : "";
  if (!apiKey || !instanceCrn) fail("LIVE_PHASE_REQUIRES_IBM_QUANTUM_API_KEY_AND_IBM_QUANTUM_INSTANCE_CRN_ENVIRONMENT");
  return Object.freeze({ apiKey, instanceCrn });
}

async function readPlan(options, readJson) {
  return validatePhysicalQpuFirstRunPlan(await readJson(required(options, "--plan"), "PLAN"));
}

async function buildPlanCommand(options, dependencies) {
  rejectUnexpected(options, new Set([
    "--backend",
    "--bridge-timeout-ms",
    "--evidence-root",
    "--out",
    "--repeated-runs",
    "--repeated-shots",
    "--smoke-shots",
    "--transpiler-seed",
  ]));
  const identity = await dependencies.resolveGitIdentity();
  return buildPhysicalQpuFirstRunPlan({
    sourceRevision: identity.sourceRevision,
    sourceTree: identity.sourceTree,
    backendName: required(options, "--backend"),
    transpilerSeed: parseInteger(required(options, "--transpiler-seed"), "TRANSPILER_SEED", 0, 2_147_483_647),
    evidenceRoot: required(options, "--evidence-root"),
    smokeShots: parseInteger(required(options, "--smoke-shots"), "SMOKE_SHOTS", 1, 10_000_000),
    repeatedShots: parseInteger(required(options, "--repeated-shots"), "REPEATED_SHOTS", 1, 10_000_000),
    repeatedRunCount: parseInteger(required(options, "--repeated-runs"), "REPEATED_RUNS", 5, 256),
    bridgeTimeoutMillis: parseInteger(required(options, "--bridge-timeout-ms"), "BRIDGE_TIMEOUT_MS", 1_000, 86_400_000),
  });
}

async function prepareCommand(options, dependencies) {
  rejectUnexpected(options, new Set(["--out", "--plan", "--python"]));
  const plan = await readPlan(options, dependencies.readJson);
  const coordinator = dependencies.coordinatorFactory({
    plan,
    apiKey: null,
    instanceCrn: null,
    pythonExecutable: options.values.get("--python") ?? "python3",
  });
  return coordinator.run({ sessionPhase: IBM_PHYSICAL_SESSION_PREPARE_ONLY });
}

async function authorizeSmokeCommand(options, dependencies) {
  rejectUnexpected(options, new Set([
    "--ci-status",
    "--out",
    "--plan",
    "--provider-cost-reference",
    "--request",
    "--walle-artifact-sha256",
    "--walle-summary",
  ]), new Set(["--confirm-provider-cost-or-entitlement"]));
  const plan = await readPlan(options, dependencies.readJson);
  const physicalRequest = await dependencies.readJson(required(options, "--request"), "REQUEST");
  const summary = await dependencies.readJson(required(options, "--walle-summary"), "WALLE_SUMMARY");
  const walle = validateWalleSummary(
    summary,
    plan,
    required(options, "--walle-artifact-sha256"),
    required(options, "--ci-status"),
  );
  return buildPhysicalQpuLiveAuthorizationRecord({
    plan,
    physicalRequest,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    ...walle,
    ...providerConfirmation(options),
  });
}

async function executeSmokeCommand(options, dependencies, env) {
  rejectUnexpected(options, new Set([
    "--out",
    "--plan",
    "--python",
    "--request",
    "--smoke-authorization",
  ]));
  const plan = await readPlan(options, dependencies.readJson);
  const physicalRequest = await dependencies.readJson(required(options, "--request"), "REQUEST");
  const smokeAuthorizationRecord = await dependencies.readJson(
    required(options, "--smoke-authorization"),
    "SMOKE_AUTHORIZATION",
  );
  const credentials = liveCredentials(env);
  const coordinator = dependencies.coordinatorFactory({
    plan,
    ...credentials,
    pythonExecutable: options.values.get("--python") ?? "python3",
  });
  const result = await coordinator.run({
    sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_SMOKE,
    physicalRequest,
    smokeAuthorizationRecord,
  });
  return Object.freeze({ result, credentialValues: Object.values(credentials) });
}

async function authorizeSeriesCommand(options, dependencies) {
  rejectUnexpected(options, new Set([
    "--baseline",
    "--ci-status",
    "--out",
    "--plan",
    "--prior-smoke-result",
    "--provider-cost-reference",
    "--request",
    "--walle-artifact-sha256",
    "--walle-summary",
  ]), new Set(["--confirm-provider-cost-or-entitlement"]));
  const plan = await readPlan(options, dependencies.readJson);
  const physicalRequest = await dependencies.readJson(required(options, "--request"), "REQUEST");
  const baselineProfile = await dependencies.readJson(required(options, "--baseline"), "BASELINE");
  const smokeGateResult = await dependencies.readJson(required(options, "--prior-smoke-result"), "PRIOR_SMOKE_RESULT");
  const summary = await dependencies.readJson(required(options, "--walle-summary"), "WALLE_SUMMARY");
  const walle = validateWalleSummary(
    summary,
    plan,
    required(options, "--walle-artifact-sha256"),
    required(options, "--ci-status"),
  );
  return buildRepeatedPhysicalSeriesAuthorizationRecord({
    plan,
    physicalRequest,
    baselineProfile,
    smokeGateResult,
    sourceRevision: plan.sourceRevision,
    sourceTree: plan.sourceTree,
    ...walle,
    ...providerConfirmation(options),
  });
}

async function executeSeriesCommand(options, dependencies, env) {
  rejectUnexpected(options, new Set([
    "--baseline",
    "--out",
    "--plan",
    "--prior-smoke-result",
    "--python",
    "--request",
    "--series-authorization",
  ]));
  const plan = await readPlan(options, dependencies.readJson);
  const physicalRequest = await dependencies.readJson(required(options, "--request"), "REQUEST");
  const baselineProfile = await dependencies.readJson(required(options, "--baseline"), "BASELINE");
  const priorSmokeGateResult = await dependencies.readJson(required(options, "--prior-smoke-result"), "PRIOR_SMOKE_RESULT");
  const repeatedSeriesAuthorizationRecord = await dependencies.readJson(
    required(options, "--series-authorization"),
    "SERIES_AUTHORIZATION",
  );
  const credentials = liveCredentials(env);
  const coordinator = dependencies.coordinatorFactory({
    plan,
    ...credentials,
    pythonExecutable: options.values.get("--python") ?? "python3",
  });
  const result = await coordinator.run({
    sessionPhase: IBM_PHYSICAL_SESSION_EXECUTE_REPEATED_SERIES,
    physicalRequest,
    baselineProfile,
    priorSmokeGateResult,
    repeatedSeriesAuthorizationRecord,
  });
  return Object.freeze({ result, credentialValues: Object.values(credentials) });
}

export async function runIbmPhysicalSessionCli({
  argv = process.argv.slice(2),
  env = process.env,
  readJson = defaultReadJson,
  writeJson = defaultWriteJson,
  resolveGitIdentity = defaultResolveGitIdentity,
  coordinatorFactory = createIbmPhysicalSessionCoordinator,
} = {}) {
  const options = parseIbmPhysicalSessionCliArgs(argv);
  required(options, "--out");
  const dependencies = Object.freeze({ readJson, writeJson, resolveGitIdentity, coordinatorFactory });
  let value;
  let credentialValues = [];
  if (options.command === "plan") value = await buildPlanCommand(options, dependencies);
  else if (options.command === "prepare") value = await prepareCommand(options, dependencies);
  else if (options.command === "authorize-smoke") value = await authorizeSmokeCommand(options, dependencies);
  else if (options.command === "authorize-series") value = await authorizeSeriesCommand(options, dependencies);
  else if (options.command === "smoke") {
    const live = await executeSmokeCommand(options, dependencies, env);
    value = live.result;
    credentialValues = live.credentialValues;
  } else if (options.command === "series") {
    const live = await executeSeriesCommand(options, dependencies, env);
    value = live.result;
    credentialValues = live.credentialValues;
  } else fail("UNREACHABLE_COMMAND");

  await writeJson(required(options, "--out"), value, credentialValues);
  return Object.freeze({ command: options.command, outputPath: required(options, "--out"), value });
}

async function main() {
  try {
    const result = await runIbmPhysicalSessionCli();
    process.stdout.write(`IBM_PHYSICAL_SESSION_CLI=PASS command=${result.command} output=${result.outputPath}\n`);
  } catch (error) {
    const message = String(error?.message ?? error).replace(/[\r\n]+/gu, " ").slice(0, 2_048);
    process.stderr.write(`IBM_PHYSICAL_SESSION_CLI=FAIL ${message}\n`);
    process.exitCode = 2;
  }
}

const direct = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (direct) await main();
