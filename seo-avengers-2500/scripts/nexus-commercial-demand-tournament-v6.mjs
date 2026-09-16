#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runCommercialDemandTournamentV6 } from "../commercial-demand/tournament-engine-v6.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SCENARIO = resolve(ROOT, "seo-avengers-2500/commercial-demand/nexus-commercial-demand-v2.json");
const DEFAULT_V3_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/service-intent-evidence-v3.json");
const DEFAULT_V4_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/software-intent-evidence-v4.json");
const DEFAULT_V5_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/demand-fit-evidence-v5.json");
const DEFAULT_V6_EVIDENCE = resolve(ROOT, "seo-avengers-2500/commercial-demand/paid-search-channel-evidence-v6.json");

function parseArgs(argv) {
  const options = {
    scenario: DEFAULT_SCENARIO,
    v3Evidence: DEFAULT_V3_EVIDENCE,
    v4Evidence: DEFAULT_V4_EVIDENCE,
    v5Evidence: DEFAULT_V5_EVIDENCE,
    v6Evidence: DEFAULT_V6_EVIDENCE,
    assertVerdict: null,
    assertMaxExactClientsMilli: null,
    assertRequiredFloorPpm: null,
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
    } else if (arg === "--assert-verdict" && value) {
      options.assertVerdict = value;
      index += 1;
    } else if (arg === "--assert-max-exact-clients-milli" && value) {
      options.assertMaxExactClientsMilli = Number(value);
      index += 1;
    } else if (arg === "--assert-required-floor-ppm" && value) {
      options.assertRequiredFloorPpm = Number(value);
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
  const [scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence] = await Promise.all([
    readJson(options.scenario),
    readJson(options.v3Evidence),
    readJson(options.v4Evidence),
    readJson(options.v5Evidence),
    readJson(options.v6Evidence),
  ]);
  const report = runCommercialDemandTournamentV6(scenario, v3Evidence, v4Evidence, v5Evidence, v6Evidence);

  if (options.assertVerdict && report.targetSupportVerdict !== options.assertVerdict) {
    throw new Error(`expected verdict ${options.assertVerdict}, got ${report.targetSupportVerdict}`);
  }
  if (
    options.assertMaxExactClientsMilli !== null
    && report.channelFrontier.maxExactCaptureEnvelope.highConversionUpperBoundModeledClientsMilli !== options.assertMaxExactClientsMilli
  ) {
    throw new Error(`expected max exact clients milli ${options.assertMaxExactClientsMilli}, got ${report.channelFrontier.maxExactCaptureEnvelope.highConversionUpperBoundModeledClientsMilli}`);
  }
  if (
    options.assertRequiredFloorPpm !== null
    && report.channelFrontier.maxExactCaptureEnvelope.requiredSessionToClientPpmFor15Clients !== options.assertRequiredFloorPpm
  ) {
    throw new Error(`expected required floor ppm ${options.assertRequiredFloorPpm}, got ${report.channelFrontier.maxExactCaptureEnvelope.requiredSessionToClientPpmFor15Clients}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V6_ERROR=${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
