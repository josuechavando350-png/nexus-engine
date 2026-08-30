import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assess,
  createPage,
  dataNoSnippetSectionIds,
  robotsSnippetControls,
  validateReadiness,
} from "../packages/generative-readiness/src/index.ts";

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const specPath = arg("--spec");
if (!specPath) throw new Error("usage: node scripts/audit-generative-readiness.mjs --spec <page.json> [--observed-at <ISO timestamp>]");
const observedAt = arg("--observed-at") ?? new Date().toISOString();
const raw = JSON.parse(await readFile(resolve(specPath), "utf8"));
const page = createPage(raw);
const readiness = assess(page, observedAt);
validateReadiness(page, readiness);

const output = {
  authority: "NEXUS_GENERATIVE_READINESS_V1",
  status: readiness.status,
  pageDigest: page.pageDigest,
  readiness,
  robotsSnippetControls: robotsSnippetControls(page),
  dataNoSnippetSectionIds: dataNoSnippetSectionIds(page),
  externalVisibilityClaim: "NOT_EVALUATED",
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exitCode = readiness.status === "READY" || readiness.status === "LIMITED" ? 0 : 2;
