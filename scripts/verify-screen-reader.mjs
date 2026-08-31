#!/usr/bin/env node
import {
  JawsScreenReaderAdapter,
  NvdaScreenReaderAdapter,
  VoiceOverScreenReaderAdapter,
  validateScreenReaderEvidence,
} from "../packages/capture/dist/capture/screen-reader.js";

function parseArgs(argv) {
  const output = { requireObserved: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--require-observed") {
      output.requireObserved = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`unexpected argument ${item}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
    output[item.slice(2)] = value;
    index += 1;
  }
  return output;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

const args = parseArgs(process.argv.slice(2));
const reader = required(args.reader, "reader").toUpperCase();
const targetUrl = required(args.url, "url");
const scope = Object.freeze({
  tenantId: required(args.tenant, "tenant"),
  brandId: required(args.brand, "brand"),
});
const timeoutMs = args["timeout-ms"] === undefined ? undefined : Number(args["timeout-ms"]);
if (timeoutMs !== undefined && !Number.isSafeInteger(timeoutMs)) throw new Error("--timeout-ms must be an integer");

const harnessByReader = {
  NVDA: process.env.NEXUS_NVDA_HARNESS,
  JAWS: process.env.NEXUS_JAWS_HARNESS,
  VOICEOVER: process.env.NEXUS_VOICEOVER_HARNESS,
};
const harness = args.harness ?? harnessByReader[reader];
const common = { executable: harness, timeoutMs };
let adapter;
if (reader === "NVDA") adapter = new NvdaScreenReaderAdapter(common);
else if (reader === "JAWS") adapter = new JawsScreenReaderAdapter(common);
else if (reader === "VOICEOVER") adapter = new VoiceOverScreenReaderAdapter(common);
else throw new Error("--reader must be nvda, jaws, or voiceover");

const controller = new AbortController();
const overallTimer = setTimeout(() => controller.abort(), Math.min(65_000, (timeoutMs ?? 30_000) + 5_000));
try {
  const evidence = await adapter.observe({ scope, targetUrl, signal: controller.signal });
  validateScreenReaderEvidence(evidence);
  process.stdout.write(`${JSON.stringify({
    capability: "NEXUS_SCREEN_READER_ADAPTERS_V1",
    evidence,
    interpretation: evidence.status === "OBSERVED"
      ? "Observed through a configured native screen-reader harness bound to its executable digest."
      : evidence.status === "SYNTHETIC"
        ? "Synthetic fixture only; not assistive-technology observation evidence."
        : "No verified native screen-reader observation is available for this run.",
  }, null, 2)}\n`);
  if (args.requireObserved && evidence.status !== "OBSERVED") process.exitCode = 2;
} finally {
  clearTimeout(overallTimer);
}
