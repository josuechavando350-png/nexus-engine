#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runCommercialDemandTournamentV8 } from "../commercial-demand/tournament-engine-v8.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SCENARIO = resolve(ROOT, "seo-avengers-2500/commercial-demand/nexus-commercial-demand-v2.json");
const DEFAULT_V3_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/service-intent-evidence-v3.json");
const DEFAULT_V4_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/software-intent-evidence-v4.json");
const DEFAULT_V5_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/demand-fit-evidence-v5.json");
const DEFAULT_V6_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/paid-search-channel-evidence-v6.json");
const DEFAULT_V7_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/funnel-observability-evidence-v7.json");
const DEFAULT_V8_CONTRACT = resolve(ROOT, "seo-avengers-2500/commercial-demand/funnel-measurement-contract-v8.json");

function parseArgs(argv) {
  const options = {
    scenario: DEFAULT_SCENARIO,
    v3Evidence: DEFAULT_V3_EVIDENCE,
    v4Evidence: DEFAULT_V4_EVIDENCE,
    v5Evidence: DEFAULT_V5_EVIDENCE,
    v6Evidence: DEFAULT_V6_EVIDENCE,
    v7Evidence: DEFAULT_V7_EVIDENCE,
    v8Contract: DEFAULT_V8_CONTRACT,
    assertVerdict: null,
    assertTargetPpm: null,
    assertFirstCheckpointClients: null,
    assertFourthCheckpointClients: null,
    assertProbabilityStatus: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--scenario" && value) {
      options.scenario = resolve(value);
      index += 1;
    } else if (arg === "--v3-evidence" && value) {
      options.v3Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v4-evidence" && value) {
      options.v4Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v5-evidence" && value) {
      options.v5Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v6-evidence" && value) {
      options.v6Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v7-evidence" && value) {
      options.v7Evidence = resolve(value);
      index += 1;
    } else if (arg === "--v8-contract" && value) {
      options.v8Contract = resolve(value);
      index += 1;
    } else if (arg === "--assert-verdict" && value) {
      options.assertVerdict = value;
      index += 1;
    } else if (arg === "--assert-target-ppm" && value) {
      options.assertTargetPpm = Number(value);
      index += 1;
    } else if (arg === "--assert-first-checkpoint-clients" && value) {
      options.assertFirstCheckpointClients = Number(value);
      index += 1;
    } else if (arg === "--assert-fourth-checkpoint-clients" && value) {
      options.assertFourthCheckpointClients = Number(value);
      index += 1;
    } else if (arg === "--assert-probability-status" && value) {
      options.assertProbabilityStatus = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence, v7Evidence, v8Contract] = await Promise.all([
    readJson(options.scenario),
    readJson(options.v3Evidence),
    readJson(options.v4Evidence),
    readJson(options.v5Evidence),
    readJson(options.v6Evidence),
    readJson(options.v7Evidence),
    readJson(options.v8Contract),
  ]);
  const report = runCommercialDemandTournamentV8(scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence, v7Evidence, v8Contract);

  if (options.assertVerdict && report.targetSupportVerdict !== options.assertVerdict) {
    throw new Error(`expected verdict ${options.assertVerdict}, got ${report.targetSupportVerdict}`);
  }
  if (options.assertTargetPpm !== null && report.statisticalAcceptanceFrontier.targetSessionToClientPpm !== options.assertTargetPpm) {
    throw new Error(`expected target ppm ${options.assertTargetPpm}, got ${report.statisticalAcceptanceFrontier.targetSessionToClientPpm}`);
  }
  const checkpoints = report.statisticalAcceptanceFrontier.checkpoints;
  if (
    options.assertFirstCheckpointClients !== null
    && checkpoints[0].minimumUniqueNewClosedClientsForWilsonLowerBound !== options.assertFirstCheckpointClients
  ) {
    throw new Error(`expected first checkpoint clients ${options.assertFirstCheckpointClients}, got ${checkpoints[0].minimumUniqueNewClosedClientsForWilsonLowerBound}`);
  }
  if (
    options.assertFourthCheckpointClients !== null
    && checkpoints[3].minimumUniqueNewClosedClientsForWilsonLowerBound !== options.assertFourthCheckpointClients
  ) {
    throw new Error(`expected fourth checkpoint clients ${options.assertFourthCheckpointClients}, got ${checkpoints[3].minimumUniqueNewClosedClientsForWilsonLowerBound}`);
  }
  if (
    options.assertProbabilityStatus
    && report.measurementImplementationReadiness.probabilityOfAtLeast15ClientsPerMonth !== options.assertProbabilityStatus
  ) {
    throw new Error(`expected probability status ${options.assertProbabilityStatus}, got ${report.measurementImplementationReadiness.probabilityOfAtLeast15ClientsPerMonth}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V8_ERROR=${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
