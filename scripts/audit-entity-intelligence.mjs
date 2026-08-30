import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assessEntities,
  validateAnalysisSnapshot,
  validateEntityAssessment,
  validateEntityDocument,
  validateEntityResolution,
} from "../packages/entity-intelligence/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-entity-intelligence.mjs --spec <evidence.json>");

const source = JSON.parse(await readFile(resolve(args[specIndex + 1]), "utf8"));
const { document, snapshot, resolutions = [], assessment: suppliedAssessment } = source;
validateEntityDocument(document);
validateAnalysisSnapshot(document, snapshot);
for (const resolution of resolutions) {
  const entity = snapshot.entities.find((candidate) => candidate.digest === resolution.entityDigest);
  if (!entity) throw new Error("resolution references entity outside snapshot");
  validateEntityResolution(document, entity, resolution);
}
const assessment = assessEntities(document, snapshot, resolutions);
if (suppliedAssessment !== undefined) validateEntityAssessment(document, snapshot, resolutions, suppliedAssessment);
process.stdout.write(`${JSON.stringify({ authority: "NEXUS_ENTITY_INTELLIGENCE_V1", documentDigest: document.digest, snapshotDigest: snapshot.digest, assessment }, null, 2)}\n`);
process.exitCode = assessment.status === "READY" ? 0 : 2;
