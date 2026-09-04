import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
  PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  prepareProjectCaptureRuntime,
} from "../scripts/project-capture-runtime.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nexus-project-capture-runtime-"));
  writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@10.15.0"}\n');
  roots.push(root);
  return root;
}

function writeInstalledModules(root, store = join(root, "existing-pnpm-store")) {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".modules.yaml"), `packageManager: pnpm@10.15.0\nstoreDir: ${store}\nvirtualStoreDir: .pnpm\n`);
  return store;
}

function writeRuntimeOutputs(root, outputs = PROJECT_CAPTURE_RUNTIME_OUTPUTS) {
  for (const relativePath of outputs) {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export {};\n");
  }
}

describe("project capture runtime preparation", () => {
  it("builds the declared MCP dependency closure and verifies every executable runtime output", async () => {
    const root = tempRoot();
    const store = writeInstalledModules(root);
    const calls = [];
    const result = await prepareProjectCaptureRuntime(root, {
      runner: async (command, args, cwd, environment) => {
        calls.push({ command, args: [...args], cwd, environment });
        writeRuntimeOutputs(root);
      },
    });

    expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
      { command: "corepack", args: ["pnpm", ...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS], cwd: root },
    ]);
    expect(calls[0].environment.HOME).toContain(join(root, ".nexus-cache", "capture-workspace-build"));
    expect(calls[0].environment.NPM_CONFIG_USERCONFIG).not.toBe(process.env.NPM_CONFIG_USERCONFIG);
    expect(calls[0].environment.HOME).not.toBe(process.env.HOME);
    expect(calls[0].environment.COREPACK_HOME).toBe(join(process.env.HOME, ".cache", "node", "corepack"));
    expect(calls[0].environment.npm_config_store_dir).toBe(store);
    expect(calls[0].environment.npm_config_frozen_lockfile).toBe("true");
    expect(PROJECT_CAPTURE_RUNTIME_BUILD_ARGS).toEqual(["--filter", "@nexus/mcp-server...", "build"]);
    expect(result.authority).toBe("NEXUS_PROJECT_CAPTURE_RUNTIME_V1");
    expect(result.outputs).toEqual(PROJECT_CAPTURE_RUNTIME_OUTPUTS);
  });

  it("does not install or purge a valid node_modules created before capture preparation", async () => {
    const root = tempRoot();
    const existingStore = writeInstalledModules(root, "/preexisting/pnpm/store/v10");
    const calls = [];
    const runner = async (command, args, _cwd, environment) => {
      calls.push({ command, args: [...args], storeDir: environment.npm_config_store_dir });
      expect(args).not.toContain("install");
      writeRuntimeOutputs(root);
    };

    await prepareProjectCaptureRuntime(root, { runner, environment: { PATH: process.env.PATH, HOME: "/host/home" } });

    expect(calls).toEqual([
      { command: "corepack", args: ["pnpm", ...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS], storeDir: existingStore },
    ]);
  });

  it("fails closed instead of installing when pnpm installation metadata is absent or has no storeDir", async () => {
    const missing = tempRoot();
    await expect(prepareProjectCaptureRuntime(missing, { runner: async () => undefined })).rejects.toThrow(/requires an existing node_modules\/\.modules\.yaml/);

    const invalid = tempRoot();
    mkdirSync(join(invalid, "node_modules"), { recursive: true });
    writeFileSync(join(invalid, "node_modules", ".modules.yaml"), "virtualStoreDir: .pnpm\n");
    await expect(prepareProjectCaptureRuntime(invalid, { runner: async () => undefined })).rejects.toThrow(/requires node_modules\/\.modules\.yaml to declare storeDir/);
  });

  it("fails closed when the dependency build does not produce measurement runtime bytes", async () => {
    const root = tempRoot();
    writeInstalledModules(root);
    await expect(prepareProjectCaptureRuntime(root, {
      runner: async () => {
        writeRuntimeOutputs(root, PROJECT_CAPTURE_RUNTIME_OUTPUTS.filter((path) => !path.includes("measurement")));
      },
    })).rejects.toThrow(/measurement\/dist\/measurement\/index\.js/);
  });
});
