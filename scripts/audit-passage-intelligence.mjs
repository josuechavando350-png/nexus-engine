import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPage, assessPage, validateAssessment } from "../packages/passage-intelligence/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-passage-intelligence.mjs --spec <page.json>");
const source = JSON.parse(await readFile(resolve(args[specIndex + 1]), "utf8"));
const page = createPage(source);
const assessment = assessPage(page);
validateAssessment(page, assessment);
process.stdout.write(`${JSON.stringify({ authority: "NEXUS_PASSAGE_INTELLIGENCE_V1", pageDigest: page.pageDigest, assessment }, null, 2)}\n`);
process.exitCode = assessment.status === "READY" ? 0 : 2;
