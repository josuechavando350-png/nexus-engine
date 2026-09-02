import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_CAPTURE_RUNTIME_BUILD_ARGS,
  PROJECT_CAPTURE_RUNTIME_OUTPUTS,
  prepareProjectCaptureRuntime,
} from "./project-capture-runtime.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nexus-project-capture-runtime-"));
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
      runner: async (command, args, cwd) => {
        calls.push({ command, args: [...args], cwd });
        writeRuntimeOutputs(root);
      },
    });

    expect(calls).toEqual([{ command: "pnpm", args: [...PROJECT_CAPTURE_RUNTIME_BUILD_ARGS], cwd: root }]);
    expect(PROJECT_CAPTURE_RUNTIME_BUILD_ARGS).toEqual(["--filter", "@nexus/mcp-server...", "build"]);
    expect(result.authority).toBe("NEXUS_PROJECT_CAPTURE_RUNTIME_V1");
    expect(result.outputs).toEqual(PROJECT_CAPTURE_RUNTIME_OUTPUTS);
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
