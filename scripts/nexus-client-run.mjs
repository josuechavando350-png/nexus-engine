import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function exactRepositoryPreflight(spec) {
  const expected = spec?.sourceRevision;
  if (typeof expected !== "string" || !/^[a-f0-9]{40}$/.test(expected)) {
    throw new Error("production client execution requires a canonical 40-character spec.sourceRevision");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (head !== expected) throw new Error(`production client sourceRevision ${expected} does not match repository HEAD ${head}`);
  const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  if (porcelain.length) throw new Error("production client execution requires a globally clean exact-SHA repository before loading engine source");
}

async function main() {
  const args = process.argv.slice(2);
  const specIndex = args.indexOf("--spec");
  const outIndex = args.indexOf("--out");
  if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/nexus-client-run.mjs --spec <json> [--out <dir>]");
  const specPath = resolve(args[specIndex + 1]);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (outIndex >= 0 && args[outIndex + 1]) spec.outputDir = resolve(args[outIndex + 1]);

  exactRepositoryPreflight(spec);
  const { installRepositoryTypeScriptRuntime } = await import("./typescript-source-runtime.mjs");
  installRepositoryTypeScriptRuntime();
  const { runNexusClientPipelineWithWorkspaceRuntime } = await import("./nexus-client-pipeline.mjs");
  const result = await runNexusClientPipelineWithWorkspaceRuntime(spec, { runtimeOptions: { root: REPOSITORY_ROOT } });
  process.stdout.write(`${JSON.stringify({ authority: result.authority, status: result.status, certification: result.certification, blocker: result.blocker }, null, 2)}\n`);
  process.exitCode = result.status === "CERTIFIED" ? 0 : 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
