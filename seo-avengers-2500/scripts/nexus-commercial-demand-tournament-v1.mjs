#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runCommercialDemandTournament } from "../commercial-demand/tournament-engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultScenario = resolve(here, "../commercial-demand/nexus-commercial-demand-v1.json");

function usage() {
  console.error("usage: nexus-commercial-demand-tournament-v1.mjs [--scenario <path>] [--assert-verdict <verdict>] [--assert-selected <strategy-id>]");
}

function parseArgs(argv) {
  const result = { scenario: defaultScenario, assertVerdict: null, assertSelected: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario" || arg === "--assert-verdict" || arg === "--assert-selected") {
      const value = argv[index + 1];
      if (!value) {
        usage();
        process.exitCode = 64;
        return null;
      }
      if (arg === "--scenario") result.scenario = resolve(value);
      if (arg === "--assert-verdict") result.assertVerdict = value;
      if (arg === "--assert-selected") result.assertSelected = value;
      index += 1;
      continue;
    }
    usage();
    process.exitCode = 64;
    return null;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (args) {
  try {
    const raw = JSON.parse(await readFile(args.scenario, "utf8"));
    const report = runCommercialDemandTournament(raw);
    if (args.assertVerdict && report.targetAssessment.targetSupportVerdict !== args.assertVerdict) {
      throw new Error(`verdict assertion failed: expected ${args.assertVerdict}, got ${report.targetAssessment.targetSupportVerdict}`);
    }
    if (args.assertSelected && report.tournament.selectedStrategyId !== args.assertSelected) {
      throw new Error(`selected strategy assertion failed: expected ${args.assertSelected}, got ${report.tournament.selectedStrategyId}`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
