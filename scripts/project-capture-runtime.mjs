import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS = Object.freeze([
  "install",
  "--frozen-lockfile",
]);

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

function defaultRunner(command, args, cwd, environment) {
  execFileSync(command, args, { cwd, env: environment, stdio: "inherit" });
}

function forwardedBuildEnvironment(environment) {
  const forwarded = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "CI", "NODE_ENV", "SOURCE_DATE_EPOCH"]) {
    if (environment[name] !== undefined) forwarded[name] = environment[name];
  }
  return forwarded;
}

async function workspaceBuildEnvironment(repositoryRoot, environment) {
  const buildRoot = join(repositoryRoot, ".nexus-cache", "capture-workspace-build");
  const home = join(buildRoot, "home");
  const config = join(buildRoot, "npmrc");
  const store = join(repositoryRoot, ".pnpm-store");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "xdg-config"), { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "xdg-cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "pnpm-home"), { recursive: true, mode: 0o700 }),
    mkdir(store, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(config, "# Repository-scoped pnpm configuration for CAPTURE preparation.\n", { flag: "wx", mode: 0o600 })
    .catch((error) => { if (error?.code !== "EEXIST") throw error; });
  return {
    ...forwardedBuildEnvironment(environment),
    HOME: home,
    XDG_CONFIG_HOME: join(buildRoot, "xdg-config"),
    XDG_CACHE_HOME: join(buildRoot, "xdg-cache"),
    NPM_CONFIG_USERCONFIG: config,
    PNPM_HOME: join(buildRoot, "pnpm-home"),
    npm_config_store_dir: store,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function installState(repositoryRoot, environment) {
  const [lockfile, packageManifest] = await Promise.all([
    readFile(join(repositoryRoot, "pnpm-lock.yaml")),
    readFile(join(repositoryRoot, "package.json"), "utf8"),
  ]);
  const packageManager = JSON.parse(packageManifest).packageManager;
  if (typeof packageManager !== "string" || !packageManager.startsWith("pnpm@")) {
    throw new Error("project capture preparation requires a pinned pnpm packageManager");
  }
  const identity = createHash("sha256")
    .update(lockfile)
    .update(`\0${packageManager}\0`)
    .update(environment.HOME)
    .update("\0")
    .update(environment.NPM_CONFIG_USERCONFIG)
    .update("\0")
    .update(environment.npm_config_store_dir)
    .digest("hex");
  return {
    identity,
    marker: join(repositoryRoot, ".nexus-cache", "capture-workspace-build", "install-state.sha256"),
  };
}

export async function prepareProjectCaptureRuntime(root, options = {}) {
  const repositoryRoot = resolve(root);
  const runner = options.runner ?? defaultRunner;
  const environment = await workspaceBuildEnvironment(repositoryRoot, options.environment ?? process.env);
  const state = await installState(repositoryRoot, environment);
  const installed = await readFile(state.marker, "utf8").catch(() => "");
  const modulesMetadata = await lstat(join(repositoryRoot, "node_modules", ".modules.yaml")).catch(() => null);
  if (installed.trim() !== state.identity || !modulesMetadata?.isFile() || modulesMetadata.size <= 0) {
    // Workspace preparation is trusted repository work. It uses a stable,
    // repository-scoped pnpm identity so dependency verification and build see
    // the same HOME, config and store without inheriting the user's HOME/npmrc.
    await runner("pnpm", PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS, repositoryRoot, environment);
    await writeFile(state.marker, `${state.identity}\n`, { mode: 0o600 });
  }
  await runner("pnpm", PROJECT_CAPTURE_RUNTIME_BUILD_ARGS, repositoryRoot, environment);
  for (const relativePath of PROJECT_CAPTURE_RUNTIME_OUTPUTS) {
    await assertRuntimeOutput(repositoryRoot, relativePath);
  }
  return Object.freeze({
    authority: "NEXUS_PROJECT_CAPTURE_RUNTIME_V1",
    installIdentity: `sha256:${state.identity}`,
    buildArgs: PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
    outputs: PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  });
}
