import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test discovery boundary", () => {
  it("executes package-level test files instead of only __tests__ directories", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");

    expect(config).toContain('"packages/**/*.test.ts"');
    expect(config).toContain('"tests/**/*.test.ts"');
    expect(config).not.toContain('"packages/**/__tests__/**/*.test.ts"');
  });
});
