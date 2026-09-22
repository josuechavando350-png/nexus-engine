import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(new URL("../sastre/live-market.test.mjs", import.meta.url));

describe("Sastre Live Market native evidence checks", () => {
  it("executes at least eight passing native tests with zero failures", () => {
    const result = spawnSync(process.execPath, ["--test", testFile], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // Node 22 uses TAP (# pass 8); Node 24 may use the spec reporter (ℹ pass 8).
    const passed = /^(?:#|ℹ)\s+pass\s+([1-9]\d*)\s*$/mu.exec(result.stdout);
    expect(passed, result.stdout).not.toBeNull();
    expect(Number(passed?.[1])).toBeGreaterThanOrEqual(8);
    expect(result.stdout).toMatch(/^(?:#|ℹ)\s+fail\s+0\s*$/mu);
  });
});
