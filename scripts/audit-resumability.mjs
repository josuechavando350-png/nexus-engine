import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderPayload, validateManifest, validateState } from "../packages/resumability/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-resumability.mjs --spec <resume.json>");

const source = JSON.parse(await readFile(resolve(args[specIndex + 1]), "utf8"));
const { manifest, state } = source;
validateManifest(manifest);
validateState(state);
const payload = renderPayload(manifest, state);
process.stdout.write(`${JSON.stringify({ authority: "NEXUS_RESUMABILITY_AUDIT_V1", manifestDigest: manifest.digest, stateDigest: state.digest, payload }, null, 2)}\n`);
