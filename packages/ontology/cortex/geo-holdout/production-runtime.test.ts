import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createGeoHoldoutProductionRuntimeFromEnv } from "./production-runtime";

const dirs: string[] = [];
const ENV_KEYS = [
  "NEXUS_CORTEX_12_DATABASE",
  "NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE",
  "NEXUS_CORTEX_12_CONTROL_TOKEN_FILE",
  "NEXUS_CORTEX_12_HOST",
  "NEXUS_CORTEX_12_PORT",
] as const;
const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex12-runtime-"));
  dirs.push(dir);
  return dir;
}

function configure(dir: string): void {
  const experimentFile = join(dir, "experiment-token");
  const controlFile = join(dir, "control-token");
  writeFileSync(experimentFile, "experiment-token-cortex12-production-0001\n", { mode: 0o600 });
  writeFileSync(controlFile, "control-token-cortex12-production-0000001\n", { mode: 0o600 });
  process.env.NEXUS_CORTEX_12_DATABASE = join(dir, "geo.sqlite");
  process.env.NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE = experimentFile;
  process.env.NEXUS_CORTEX_12_CONTROL_TOKEN_FILE = controlFile;
  process.env.NEXUS_CORTEX_12_HOST = "127.0.0.1";
  process.env.NEXUS_CORTEX_12_PORT = "18082";
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const geos = Array.from({ length: 20 }, (_, index) => ({ geoId: `geo-${String(index + 1).padStart(4, "0")}`, baselineOutcome: 1_000 + index * 10 }));
const designInput = {
  experimentId: "experiment-runtime-001",
  seed: "runtime-seed-with-at-least-sixteen-chars",
  holdoutFraction: 0.4,
  maxBaselineImbalance: 0.2,
  minGeosPerArm: 3,
  geos,
} as const;

describe("CORTEX #12 production runtime", () => {
  it("starts fail-closed and binds registry mutation to the durable control state", async () => {
    const dir = directory();
    configure(dir);
    const runtime = createGeoHoldoutProductionRuntimeFromEnv();
    try {
      expect(runtime.control.read().mode).toBe("KILLED");
      expect(() => runtime.registry.registerDesign(designInput)).toThrowError(/runtime mode blocks/u);
      runtime.control.setMode("ACTIVE", 0);
      expect(runtime.registry.registerDesign(designInput).design.status).toBe("READY");
      runtime.control.setMode("KILLED", 1);
      const second = { ...designInput, experimentId: "experiment-runtime-002" };
      expect(() => runtime.registry.registerDesign(second)).toThrowError(/runtime mode blocks/u);
    } finally {
      await runtime.close();
    }
  });

  it("requires absolute durable storage and absolute bounded credential files", () => {
    const dir = directory();
    configure(dir);
    process.env.NEXUS_CORTEX_12_DATABASE = "relative.sqlite";
    expect(() => createGeoHoldoutProductionRuntimeFromEnv()).toThrowError(/absolute path/u);
    process.env.NEXUS_CORTEX_12_DATABASE = join(dir, "geo.sqlite");
    process.env.NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE = "relative-secret";
    expect(() => createGeoHoldoutProductionRuntimeFromEnv()).toThrowError(/absolute path/u);
  });

  it("rejects shared credential files and equal experiment/control secrets", () => {
    const dir = directory();
    configure(dir);
    process.env.NEXUS_CORTEX_12_CONTROL_TOKEN_FILE = process.env.NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE;
    expect(() => createGeoHoldoutProductionRuntimeFromEnv()).toThrowError(/distinct files/u);

    configure(dir);
    const controlFile = process.env.NEXUS_CORTEX_12_CONTROL_TOKEN_FILE!;
    writeFileSync(controlFile, "experiment-token-cortex12-production-0001\n", { mode: 0o600 });
    expect(() => createGeoHoldoutProductionRuntimeFromEnv()).toThrowError(/credentials must be distinct/u);
  });
});
