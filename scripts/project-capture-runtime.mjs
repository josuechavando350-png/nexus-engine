import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const PROJECT_CAPTURE_RUNTIME_BUILD_ARGS = Object.freeze([
  "--filter",
  "@nexus/mcp-server...",
  "build",
]);

export const PROJECT_CAPTURE_RUNTIME_OUTPUTS = Object.freeze([
  "packages/capture/dist/capture/index.js",
  "packages/capture/dist/capture/playwright-adapter.js",
  "packages/measurement/dist/measurement/index.js",
]);

async function assertRuntimeOutput(root, relativePath) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, relativePath);
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`project capture runtime output is missing or invalid: ${relativePath}`);
  }
  const [rootReal, fileReal] = await Promise.all([realpath(rootPath), realpath(path)]);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`project capture runtime output resolves outside repository root: ${relativePath}`);
  }
}

function defaultRunner(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

export async function prepareProjectCaptureRuntime(root, options = {}) {
  const repositoryRoot = resolve(root);
  const runner = options.runner ?? defaultRunner;
  await runner("pnpm", PROJECT_CAPTURE_RUNTIME_BUILD_ARGS, repositoryRoot);
  for (const relativePath of PROJECT_CAPTURE_RUNTIME_OUTPUTS) {
    await assertRuntimeOutput(repositoryRoot, relativePath);
  }
  return Object.freeze({
    authority: "NEXUS_PROJECT_CAPTURE_RUNTIME_V1",
    buildArgs: PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
    outputs: PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  });
}
