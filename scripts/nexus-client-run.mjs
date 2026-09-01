import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const REPOSITORY_PREFIX = `${REPOSITORY_ROOT}${sep}`;
const SHA1 = /^[a-f0-9]{40}$/;

function git(args) {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
}

function committedProductionSpec(specArgument) {
  const absolute = resolve(specArgument);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("production client spec must be a regular non-symlink file");
  const real = realpathSync(absolute);
  if (!real.startsWith(REPOSITORY_PREFIX)) throw new Error("production client spec must stay inside the NEXUS repository");
  const relativePath = relative(REPOSITORY_ROOT, real).split(sep).join("/");
  if (!relativePath || relativePath.startsWith("../")) throw new Error("production client spec path is invalid");

  const head = git(["rev-parse", "HEAD"]);
  if (!SHA1.test(head)) throw new Error("production client repository HEAD is not a canonical SHA-1");

  let committedBlob;
  try {
    committedBlob = git(["rev-parse", `${head}:${relativePath}`]);
  } catch {
    throw new Error(`production client spec must be committed at ${head}: ${relativePath}`);
  }
  const workingBlob = git(["hash-object", "--", relativePath]);
  if (!SHA1.test(committedBlob) || committedBlob !== workingBlob) {
    throw new Error("production client spec bytes are not identical to the declared HEAD blob");
  }

  const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  if (porcelain.length) throw new Error("production client execution requires a globally clean exact-SHA repository before loading engine source");

  const parsed = JSON.parse(readFileSync(real, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("production client spec must be a JSON object");
  if (Object.prototype.hasOwnProperty.call(parsed, "sourceRevision")) {
    throw new Error("production client spec must not self-declare sourceRevision; NEXUS binds it to the verified Git HEAD");
  }
  return { ...parsed, sourceRevision: head };
}

async function main() {
  const args = process.argv.slice(2);
  const specIndex = args.indexOf("--spec");
  const outIndex = args.indexOf("--out");
  if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/nexus-client-run.mjs --spec <committed-json> [--out <dir>]");
  const spec = committedProductionSpec(args[specIndex + 1]);
  if (outIndex >= 0 && args[outIndex + 1]) spec.outputDir = resolve(args[outIndex + 1]);

  const { installRepositoryTypeScriptRuntime } = await import("./typescript-source-runtime.mjs");
  installRepositoryTypeScriptRuntime();
  const { runNexusClientPipelineWithWorkspaceRuntime } = await import("./nexus-client-pipeline.mjs");
  const result = await runNexusClientPipelineWithWorkspaceRuntime(spec, { runtimeOptions: { root: REPOSITORY_ROOT } });
  process.stdout.write(`${JSON.stringify({ authority: result.authority, status: result.status, certification: result.certification, blocker: result.blocker }, null, 2)}\n`);
  process.exitCode = result.status === "CERTIFIED" ? 0 : 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
