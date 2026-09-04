import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
  PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS,
  PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  prepareProjectCaptureRuntime,
} from "../scripts/project-capture-runtime.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nexus-project-capture-runtime-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@10.15.0"}\n');
  roots.push(root);
  return root;
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
    const calls = [];
    const result = await prepareProjectCaptureRuntime(root, {
      runner: async (command, args, cwd, environment) => {
        calls.push({ command, args: [...args], cwd, environment });
        writeRuntimeOutputs(root);
      },
    });

    expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
      { command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS], cwd: root },
      { command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS], cwd: root },
    ]);
    expect(calls[0].environment).toBe(calls[1].environment);
    expect(calls[0].environment.HOME).toContain(join(root, ".nexus-cache", "capture-workspace-build"));
    expect(calls[0].environment.NPM_CONFIG_USERCONFIG).not.toBe(process.env.NPM_CONFIG_USERCONFIG);
    expect(calls[0].environment.HOME).not.toBe(process.env.HOME);
    expect(calls[0].environment.npm_config_store_dir).toBe(join(root, ".pnpm-store"));
    expect(PROJECT_CAPTURE_RUNTIME_BUILD_ARGS).toEqual(["--filter", "@nexus/mcp-server...", "build"]);
    expect(PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS).toEqual(["install", "--frozen-lockfile"]);
    expect(result.authority).toBe("NEXUS_PROJECT_CAPTURE_RUNTIME_V1");
    expect(result.outputs).toEqual(PROJECT_CAPTURE_RUNTIME_OUTPUTS);
  });

  it("does not reinstall dependencies when node_modules already matches the frozen lockfile identity", async () => {
    const root = tempRoot();
    const calls = [];
    const runner = async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args[0] === "install") {
        mkdirSync(join(root, "node_modules"), { recursive: true });
        writeFileSync(join(root, "node_modules", ".modules.yaml"), "storeDir: test\n");
      }
      writeRuntimeOutputs(root);
    };

    await prepareProjectCaptureRuntime(root, { runner, environment: { PATH: process.env.PATH } });
    await prepareProjectCaptureRuntime(root, { runner, environment: { PATH: process.env.PATH } });

    expect(calls).toEqual([
      { command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_INSTALL_ARGS] },
      { command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS] },
      { command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS] },
    ]);
  });

  it("fails closed when the dependency build does not produce measurement runtime bytes", async () => {
    const root = tempRoot();
    await expect(prepareProjectCaptureRuntime(root, {
      runner: async () => {
        writeRuntimeOutputs(root, PROJECT_CAPTURE_RUNTIME_OUTPUTS.filter((path) => !path.includes("measurement")));
      },
    })).rejects.toThrow(/measurement\/dist\/measurement\/index\.js/);
  });
});
