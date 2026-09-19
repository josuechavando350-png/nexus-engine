import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(new URL("../sastre/live-market.test.mjs", import.meta.url));

describe("Sastre Live Market native evidence checks", () => {
  it("executes the native Node market test suite", () => {
    const result = spawnSync(process.execPath, ["--test", testFile], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# pass [1-9][0-9]*/u);
    expect(result.stdout).toContain("# fail 0");
  });
});
