import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

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

async function installedPnpmIdentity(repositoryRoot) {
  const metadataPath = join(repositoryRoot, "node_modules", ".modules.yaml");
  const metadata = await readFile(metadataPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("project capture preparation requires an existing node_modules/.modules.yaml; run pnpm install --frozen-lockfile before CAPTURE");
    }
    throw error;
  });
  const storeMatch = /^storeDir:\s*(\S.*?)\s*$/m.exec(metadata);
  if (!storeMatch) {
    throw new Error("project capture preparation requires node_modules/.modules.yaml to declare storeDir; refusing to install or purge dependencies");
  }
  const store = storeMatch[1].replace(/^(['"])(.*)\1$/, "$2");
  if (!store || !isAbsolute(store)) {
    throw new Error(`project capture preparation requires an absolute storeDir in node_modules/.modules.yaml; received ${JSON.stringify(store)}`);
  }
  const installedPackageManager = /^packageManager:\s*(\S.*?)\s*$/m.exec(metadata)?.[1];
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (!installedPackageManager || installedPackageManager !== manifest.packageManager) {
    throw new Error(`project capture preparation requires node_modules installed by ${manifest.packageManager}; found ${installedPackageManager ?? "no packageManager in node_modules/.modules.yaml"}`);
  }
  return { store, packageManager: installedPackageManager };
}

async function workspaceBuildEnvironment(repositoryRoot, environment, store) {
  const buildRoot = join(repositoryRoot, ".nexus-cache", "capture-workspace-build");
  const home = join(buildRoot, "home");
  const config = join(buildRoot, "npmrc");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "xdg-config"), { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "xdg-cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(buildRoot, "pnpm-home"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(config, "# Repository-scoped pnpm configuration for CAPTURE preparation.\n", { flag: "wx", mode: 0o600 })
    .catch((error) => { if (error?.code !== "EEXIST") throw error; });
  const parentCache = environment.XDG_CACHE_HOME ?? (environment.HOME ? join(environment.HOME, ".cache") : undefined);
  const corepackHome = environment.COREPACK_HOME ?? (parentCache ? join(parentCache, "node", "corepack") : undefined);
  if (!corepackHome) throw new Error("project capture preparation requires COREPACK_HOME or HOME to locate the pinned pnpm toolchain");
  return {
    ...forwardedBuildEnvironment(environment),
    HOME: home,
    XDG_CONFIG_HOME: join(buildRoot, "xdg-config"),
    XDG_CACHE_HOME: join(buildRoot, "xdg-cache"),
    NPM_CONFIG_USERCONFIG: config,
    PNPM_HOME: join(buildRoot, "pnpm-home"),
    // Reuse only Corepack's verified package-manager cache. HOME, XDG and the
    // user's npmrc remain excluded from the child environment.
    COREPACK_HOME: corepackHome,
    npm_config_store_dir: store,
    npm_config_frozen_lockfile: "true",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function prepareProjectCaptureRuntime(root, options = {}) {
  const repositoryRoot = resolve(root);
  const runner = options.runner ?? defaultRunner;
  const installed = await installedPnpmIdentity(repositoryRoot);
  const environment = await workspaceBuildEnvironment(repositoryRoot, options.environment ?? process.env, installed.store);
  // Workspace preparation is trusted repository work. It reuses the exact
  // store recorded by the existing frozen installation, but retains a stable,
  // repository-scoped HOME/npmrc. pnpm's dependency status check remains on;
  // missing or invalid installation metadata fails closed above, never purges.
  await runner("corepack", ["pnpm", ...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS], repositoryRoot, environment);
  for (const relativePath of PROJECT_CAPTURE_RUNTIME_OUTPUTS) {
    await assertRuntimeOutput(repositoryRoot, relativePath);
  }
  return Object.freeze({
    authority: "NEXUS_PROJECT_CAPTURE_RUNTIME_V1",
    packageManager: installed.packageManager,
    storeDir: installed.store,
    buildArgs: PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
    outputs: PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  });
}
