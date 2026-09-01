import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runNexusClientPipeline } from "./nexus-client-pipeline.mjs";
import { createWorkspaceClientRuntimeAdapters } from "./nexus-client-runtime.mjs";

async function main() {
  const args = process.argv.slice(2);
  const specIndex = args.indexOf("--spec");
  const outIndex = args.indexOf("--out");
  if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/nexus-client-run.mjs --spec <json> [--out <dir>]");
  const specPath = resolve(args[specIndex + 1]);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (outIndex >= 0 && args[outIndex + 1]) spec.outputDir = resolve(args[outIndex + 1]);
  const adapters = await createWorkspaceClientRuntimeAdapters(spec);
  const result = await runNexusClientPipeline(spec, adapters);
  process.stdout.write(`${JSON.stringify({ authority: result.authority, status: result.status, certification: result.certification, blocker: result.blocker }, null, 2)}\n`);
  process.exitCode = result.status === "CERTIFIED" ? 0 : 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
