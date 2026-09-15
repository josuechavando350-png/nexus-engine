#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommercialDemandTournamentV3 } from "../commercial-demand/tournament-engine-v3.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultBaseScenario = resolve(here, "../commercial-demand/nexus-commercial-demand-v2.json");
const defaultEvidence = resolve(here, "../commercial-demand/service-intent-evidence-v3.json");

function usage() {
  console.error("usage: nexus-commercial-demand-tournament-v3.mjs [--base-scenario <path>] [--evidence <path>] [--assert-verdict <verdict>] [--assert-selected <strategy-id>] [--assert-floor-milli <value>] [--assert-worst-milli <value>]");
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function parseArgs(argv) {
  const result = {
    baseScenario: defaultBaseScenario,
    evidence: defaultEvidence,
    assertVerdict: null,
    assertSelected: null,
    assertFloorMilli: null,
    assertWorstMilli: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--base-scenario", "--evidence", "--assert-verdict", "--assert-selected", "--assert-floor-milli", "--assert-worst-milli"].includes(arg)) {
      usage();
      process.exitCode = 64;
      return null;
    }
    const value = argv[index + 1];
    if (!value) {
      usage();
      process.exitCode = 64;
      return null;
    }
    if (arg === "--base-scenario") result.baseScenario = resolve(value);
    if (arg === "--evidence") result.evidence = resolve(value);
    if (arg === "--assert-verdict") result.assertVerdict = value;
    if (arg === "--assert-selected") result.assertSelected = value;
    if (arg === "--assert-floor-milli") result.assertFloorMilli = positiveInteger(value, arg);
    if (arg === "--assert-worst-milli") result.assertWorstMilli = positiveInteger(value, arg);
    index += 1;
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args) {
    const [baseScenario, evidence] = await Promise.all([
      readFile(args.baseScenario, "utf8").then(JSON.parse),
      readFile(args.evidence, "utf8").then(JSON.parse),
    ]);
    const report = runCommercialDemandTournamentV3(baseScenario, evidence);
    if (args.assertVerdict && report.targetSupportVerdict !== args.assertVerdict) {
      throw new Error(`verdict assertion failed: expected ${args.assertVerdict}, got ${report.targetSupportVerdict}`);
    }
    if (args.assertSelected && report.selectedStrategyId !== args.assertSelected) {
      throw new Error(`selected strategy assertion failed: expected ${args.assertSelected}, got ${report.selectedStrategyId}`);
    }
    if (args.assertFloorMilli && report.objective.minimumPlanningFloorClientsMilli !== args.assertFloorMilli) {
      throw new Error(`floor assertion failed: expected ${args.assertFloorMilli}, got ${report.objective.minimumPlanningFloorClientsMilli}`);
    }
    if (args.assertWorstMilli && report.growthFrontier.winnerWorstCaseModeledClientsMilli !== args.assertWorstMilli) {
      throw new Error(`worst-case assertion failed: expected ${args.assertWorstMilli}, got ${report.growthFrontier.winnerWorstCaseModeledClientsMilli}`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  console.error(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V3_ERROR=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
