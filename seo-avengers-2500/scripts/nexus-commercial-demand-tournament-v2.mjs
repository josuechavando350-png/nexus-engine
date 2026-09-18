#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommercialDemandTournamentV2 } from "../commercial-demand/tournament-engine-v2.mjs";
import { assertTournamentTenantEvidenceBoundary } from "../commercial-demand/tenant-evidence-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultScenario = resolve(here, "../commercial-demand/nexus-commercial-demand-v2.json");
const defaultManifest = resolve(here, "../commercial-demand/nexus-commercial-demand-v2.tenant-manifest.json");

function usage() {
  console.error("usage: nexus-commercial-demand-tournament-v2.mjs [--scenario <path> --tenant-manifest <path>] [--assert-verdict <verdict>] [--assert-selected <strategy-id>] [--assert-floor-milli <value>]");
}

function parseArgs(argv) {
  const result = {
    scenario: defaultScenario,
    tenantManifest: defaultManifest,
    explicitScenario: false,
    explicitManifest: false,
    assertVerdict: null,
    assertSelected: null,
    assertFloorMilli: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--scenario", "--tenant-manifest", "--assert-verdict", "--assert-selected", "--assert-floor-milli"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        usage();
        process.exitCode = 64;
        return null;
      }
      if (arg === "--scenario") {
        result.scenario = resolve(value);
        result.explicitScenario = true;
      }
      if (arg === "--tenant-manifest") {
        result.tenantManifest = resolve(value);
        result.explicitManifest = true;
      }
      if (arg === "--assert-verdict") result.assertVerdict = value;
      if (arg === "--assert-selected") result.assertSelected = value;
      if (arg === "--assert-floor-milli") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--assert-floor-milli must be a positive safe integer");
        result.assertFloorMilli = parsed;
      }
      index += 1;
      continue;
    }
    usage();
    process.exitCode = 64;
    return null;
  }
  if (result.explicitScenario && !result.explicitManifest) {
    throw new Error("CUSTOM_SCENARIO_REQUIRES_EXPLICIT_TENANT_MANIFEST");
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args) {
    const [raw, manifest] = await Promise.all([
      readFile(args.scenario, "utf8").then(JSON.parse),
      readFile(args.tenantManifest, "utf8").then(JSON.parse),
    ]);
    // Check tenant identity and source declarations BEFORE any tournament calculations.
    const boundary = assertTournamentTenantEvidenceBoundary(raw, manifest);
    // This statement is deliberately not inserted into the hashed engine report.
    console.error(`NEXUS_TENANT_EVIDENCE=${boundary.evidenceStatus};SALES_CLAIMS=${boundary.salesClaimStatus}`);
    const report = runCommercialDemandTournamentV2(raw);
    if (args.assertVerdict && report.targetAssessment.targetSupportVerdict !== args.assertVerdict) {
      throw new Error(`verdict assertion failed: expected ${args.assertVerdict}, got ${report.targetAssessment.targetSupportVerdict}`);
    }
    if (args.assertSelected && report.tournament.selectedStrategyId !== args.assertSelected) {
      throw new Error(`selected strategy assertion failed: expected ${args.assertSelected}, got ${report.tournament.selectedStrategyId}`);
    }
    if (args.assertFloorMilli && report.objective.minimumPlanningFloorClientsMilli !== args.assertFloorMilli) {
      throw new Error(`floor assertion failed: expected ${args.assertFloorMilli}, got ${report.objective.minimumPlanningFloorClientsMilli}`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  console.error(`NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V2_ERROR=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
