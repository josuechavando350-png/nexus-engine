#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runCommercialDemandTournamentV9 } from "../commercial-demand/tournament-engine-v9.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SCENARIO = resolve(ROOT, "seo-avengers-2500/commercial-demand/nexus-commercial-demand-v2.json");
const DEFAULT_V3_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/service-intent-evidence-v3.json");
const DEFAULT_V4_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/software-intent-evidence-v4.json");
const DEFAULT_V5_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/demand-fit-evidence-v5.json");
const DEFAULT_V6_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/paid-search-channel-evidence-v6.json");
const DEFAULT_V7_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/funnel-observability-evidence-v7.json");
const DEFAULT_V8_CONTRACT = resolve(ROOT, "seo-avengers-2500/commercial-demand/funnel-measurement-contract-v8.json");
const DEFAULT_V9_CONTRACT = resolve(ROOT, "seo-avengers-2500/commercial-demand/execution-sequence-contract-v9.json");

function parseArgs(argv) {
  const options = {
    scenario: DEFAULT_SCENARIO,
    v3Evidence: DEFAULT_V3_EVIDENCE,
    v4Evidence: DEFAULT_V4_EVIDENCE,
    v5Evidence: DEFAULT_V5_EVIDENCE,
    v6Evidence: DEFAULT_V6_EVIDENCE,
    v7Evidence: DEFAULT_V7_EVIDENCE,
    v8Contract: DEFAULT_V8_CONTRACT,
    v9Contract: DEFAULT_V9_CONTRACT,
    assertVerdict: null,
    assertPageCount: null,
    assertFirstWaveSessionsMilli: null,
    assertConservedSessionsMilli: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--scenario" && value) { options.scenario = resolve(value); index += 1; }
    else if (arg === "--v3-evidence" && value) { options.v3Evidence = resolve(value); index += 1; }
    else if (arg === "--v4-evidence" && value) { options.v4Evidence = resolve(value); index += 1; }
    else if (arg === "--v5-evidence" && value) { options.v5Evidence = resolve(value); index += 1; }
    else if (arg === "--v6-evidence" && value) { options.v6Evidence = resolve(value); index += 1; }
    else if (arg === "--v7-evidence" && value) { options.v7Evidence = resolve(value); index += 1; }
    else if (arg === "--v8-contract" && value) { options.v8Contract = resolve(value); index += 1; }
    else if (arg === "--v9-contract" && value) { options.v9Contract = resolve(value); index += 1; }
    else if (arg === "--assert-verdict" && value) { options.assertVerdict = value; index += 1; }
    else if (arg === "--assert-page-count" && value) { options.assertPageCount = Number(value); index += 1; }
    else if (arg === "--assert-first-wave-sessions-milli" && value) { options.assertFirstWaveSessionsMilli = Number(value); index += 1; }
    else if (arg === "--assert-conserved-sessions-milli" && value) { options.assertConservedSessionsMilli = Number(value); index += 1; }
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence, v7Evidence, v8Contract, v9Contract] = await Promise.all([
    readJson(options.scenario),
    readJson(options.v3Evidence),
    readJson(options.v4Evidence),
    readJson(options.v5Evidence),
    readJson(options.v6Evidence),
    readJson(options.v7Evidence),
    readJson(options.v8Contract),
    readJson(options.v9Contract),
  ]);
  const report = runCommercialDemandTournamentV9(scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence, v7Evidence, v8Contract, v9Contract);

  if (options.assertVerdict && report.targetSupportVerdict !== options.assertVerdict) {
    throw new Error(`expected verdict ${options.assertVerdict}, got ${report.targetSupportVerdict}`);
  }
  if (options.assertPageCount !== null && report.executionSequence.pageCount !== options.assertPageCount) {
    throw new Error(`expected page count ${options.assertPageCount}, got ${report.executionSequence.pageCount}`);
  }
  if (options.assertFirstWaveSessionsMilli !== null && report.executionSequence.waves[0].waveRelevantSessionsMilli !== options.assertFirstWaveSessionsMilli) {
    throw new Error(`expected first wave sessions milli ${options.assertFirstWaveSessionsMilli}, got ${report.executionSequence.waves[0].waveRelevantSessionsMilli}`);
  }
  if (options.assertConservedSessionsMilli !== null && report.executionSequence.conservedRelevantSessionsMilli !== options.assertConservedSessionsMilli) {
    throw new Error(`expected conserved sessions milli ${options.assertConservedSessionsMilli}, got ${report.executionSequence.conservedRelevantSessionsMilli}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V9_ERROR=${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
