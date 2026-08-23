import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("deterministic Next build identity", () => {
  test("every Next build target consumes NEXUS_BUILD_ID", () => {
    const appsRoot = join(process.cwd(), "apps");
    const violations: string[] = [];
    for (const entry of readdirSync(appsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const appRoot = join(appsRoot, entry.name);
      const packagePath = join(appRoot, "package.json");
      if (!existsSync(packagePath)) continue;
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: { build?: string } };
      if (!manifest.scripts?.build?.includes("next build")) continue;
      const configPath = join(appRoot, "next.config.ts");
      if (!existsSync(configPath)) {
        violations.push(`${entry.name}: missing next.config.ts`);
        continue;
      }
      const config = readFileSync(configPath, "utf8");
      if (!config.includes("generateBuildId") || !config.includes("NEXUS_BUILD_ID")) {
        violations.push(`${entry.name}: Next build does not bind generateBuildId to NEXUS_BUILD_ID`);
      }
    }
    expect(violations).toEqual([]);
  });
});
