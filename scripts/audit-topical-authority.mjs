import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessAuthority, createGraph, validateAssessment } from "../packages/topical-authority-graph/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-topical-authority.mjs --spec <graph.json>");
const source = JSON.parse(await readFile(resolve(args[specIndex + 1]), "utf8"));
const graph = createGraph(source);
const assessment = assessAuthority(graph);
validateAssessment(graph, assessment);
process.stdout.write(`${JSON.stringify({ authority: "NEXUS_TOPICAL_AUTHORITY_GRAPH_V1", graphDigest: graph.digest, assessment }, null, 2)}\n`);
process.exitCode = assessment.status === "READY" ? 0 : 2;
