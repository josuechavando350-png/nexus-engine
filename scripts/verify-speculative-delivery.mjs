import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assessBbrV3, validateBbrV3Assessment } from "../packages/transport-http3/dist/bbrv3.js";
import { collectLiveBbrV3Observation } from "../packages/transport-http3/dist/bbrv3-runtime.js";
import {
  parseSpeculativeDeliveryRequest,
  planSpeculativeDelivery,
  serializeResourceHintTags,
  serializeSpeculationRulesScript,
  validateSpeculativeDeliveryResult,
} from "../packages/transport-http3/dist/speculative-runtime.js";

const MAX_INPUT_BYTES = 512 * 1024;
const EXECUTION_BUDGET_MS = 5_000;

function usage() {
  return "usage: node scripts/verify-speculative-delivery.mjs --input <json> --tenant <tenantId> --scope <scope> [--probe-bbrv3] [--require-bbrv3-observed]";
}

function parseArgs(argv) {
  const result = {
    input: null,
    tenant: null,
    scope: null,
    probeBbrV3: false,
    requireBbrV3Observed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--probe-bbrv3") {
      result.probeBbrV3 = true;
      continue;
    }
    if (arg === "--require-bbrv3-observed") {
      result.requireBbrV3Observed = true;
      continue;
    }
    if (arg === "--input" || arg === "--tenant" || arg === "--scope") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--input") result.input = value;
      else if (arg === "--tenant") result.tenant = value;
      else result.scope = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!result.input || !result.tenant || !result.scope) throw new Error(usage());
  if (result.requireBbrV3Observed && !result.probeBbrV3) throw new Error("--require-bbrv3-observed requires --probe-bbrv3");
  return result;
}

async function readBoundedJson(path) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("input path is not a regular file");
  if (metadata.size > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  const text = await readFile(absolute, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("input is not valid JSON");
  }
}

function browserSummary(plan) {
  const evidence = plan.capabilityEvidence;
  const states = new Set(evidence.map((item) => item.state));
  if (states.has("OBSERVED")) return "OBSERVED";
  if (states.has("SUPPORTED")) return "SUPPORTED";
  if (states.has("UNAVAILABLE")) return "UNAVAILABLE";
  if (states.has("NOT_VERIFIED")) return "NOT_VERIFIED";
  return "CONFIGURED";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readBoundedJson(args.input);
  const request = parseSpeculativeDeliveryRequest(raw);
  if (request.tenantId !== args.tenant) throw new Error("tenant mismatch between runtime context and request");
  if (request.scope !== args.scope) throw new Error("scope mismatch between runtime context and request");

  const deadlineEpochMs = Date.now() + EXECUTION_BUDGET_MS;
  const plan = planSpeculativeDelivery(request, { deadlineEpochMs });
  validateSpeculativeDeliveryResult(plan);

  const bbrObservation = args.probeBbrV3 ? collectLiveBbrV3Observation() : null;
  const bbrv3 = assessBbrV3(bbrObservation);
  validateBbrV3Assessment(bbrv3);

  const output = {
    capability: "#15_SPECULATIVE_LOADING_BBRV3",
    tenantId: plan.request.tenantId,
    scope: plan.request.scope,
    requestDigest: plan.requestDigest,
    planDigest: plan.planDigest,
    selectedBytes: plan.selectedBytes,
    selectedNavigationBytes: plan.selectedNavigationBytes,
    decisions: plan.decisions,
    resourceHints: plan.resourceHints,
    resourceHintHtml: serializeResourceHintTags(plan),
    speculationRules: plan.speculationRules,
    speculationRulesHtml: serializeSpeculationRulesScript(plan),
    capabilityEvidence: plan.capabilityEvidence,
    browserStatus: browserSummary(plan),
    bbrv3,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (args.requireBbrV3Observed && bbrv3.state !== "OBSERVED") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
