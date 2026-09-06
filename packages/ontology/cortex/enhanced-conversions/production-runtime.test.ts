import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnhancedConversionProductionRuntimeFromEnv } from "./production-runtime";

const dirs: string[] = [];
const envKeys = [
  "NEXUS_CORTEX_10_DATABASE",
  "NEXUS_CORTEX_10_ACCESS_TOKEN_FILE",
  "NEXUS_CORTEX_10_TENANT_ID",
  "NEXUS_CORTEX_10_ORGANIZATION_ID",
  "NEXUS_CORTEX_10_BRAND_ID",
  "NEXUS_CORTEX_10_OPERATING_ACCOUNT_ID",
  "NEXUS_CORTEX_10_CONVERSION_ACTION_ID",
  "NEXUS_CORTEX_10_LOGIN_ACCOUNT_ID",
  "NEXUS_CORTEX_10_INGEST_TOKEN",
  "NEXUS_CORTEX_10_CONTROL_TOKEN",
  "NEXUS_CORTEX_10_DATA_MANAGER_TIMEOUT_MS",
  "NEXUS_CORTEX_10_HOST",
  "NEXUS_CORTEX_10_PORT",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of envKeys) delete process.env[key];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configure() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex10-runtime-"));
  dirs.push(dir);
  const tokenFile = join(dir, "google-access-token");
  writeFileSync(tokenFile, "access-token-long-enough-for-runtime", { mode: 0o600 });
  vi.stubEnv("NEXUS_CORTEX_10_DATABASE", join(dir, "state.sqlite"));
  vi.stubEnv("NEXUS_CORTEX_10_ACCESS_TOKEN_FILE", tokenFile);
  vi.stubEnv("NEXUS_CORTEX_10_TENANT_ID", "tenant-cortex");
  vi.stubEnv("NEXUS_CORTEX_10_ORGANIZATION_ID", "org-cortex");
  vi.stubEnv("NEXUS_CORTEX_10_OPERATING_ACCOUNT_ID", "1234567890");
  vi.stubEnv("NEXUS_CORTEX_10_CONVERSION_ACTION_ID", "9876543210");
  vi.stubEnv("NEXUS_CORTEX_10_INGEST_TOKEN", "ingest-" + "i".repeat(32));
  vi.stubEnv("NEXUS_CORTEX_10_CONTROL_TOKEN", "control-" + "c".repeat(32));
  vi.stubEnv("NEXUS_CORTEX_10_PORT", "18080");
  return { dir, tokenFile };
}

describe("CORTEX #10 production runtime environment", () => {
  it("constructs a durable runtime that remains KILLED until the control ledger is activated", async () => {
    configure();
    const runtime = createEnhancedConversionProductionRuntimeFromEnv();
    try {
      expect(runtime.control.read().mode).toBe("KILLED");
      expect(runtime.engine.get("order-12345678")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("requires absolute durable state and token paths plus distinct credentials", () => {
    configure();
    vi.stubEnv("NEXUS_CORTEX_10_DATABASE", "relative.sqlite");
    expect(() => createEnhancedConversionProductionRuntimeFromEnv()).toThrowError(/absolute path/u);

    configure();
    vi.stubEnv("NEXUS_CORTEX_10_ACCESS_TOKEN_FILE", "relative-token");
    expect(() => createEnhancedConversionProductionRuntimeFromEnv()).toThrowError(/absolute path/u);

    configure();
    vi.stubEnv("NEXUS_CORTEX_10_CONTROL_TOKEN", process.env.NEXUS_CORTEX_10_INGEST_TOKEN!);
    expect(() => createEnhancedConversionProductionRuntimeFromEnv()).toThrowError(/distinct credentials/u);
  });
});
