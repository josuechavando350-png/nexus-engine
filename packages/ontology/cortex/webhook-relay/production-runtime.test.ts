import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebhookRelayProductionRuntimeFromEnv } from "./production-runtime";

const dirs: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];
const envKeys = [
  "NEXUS_CORTEX_11_DATABASE",
  "NEXUS_CORTEX_11_ENDPOINT",
  "NEXUS_CORTEX_11_BEARER_TOKEN_FILE",
  "NEXUS_CORTEX_11_SIGNING_SECRET_FILE",
  "NEXUS_CORTEX_11_INGEST_TOKEN",
  "NEXUS_CORTEX_11_CONTROL_TOKEN",
  "NEXUS_CORTEX_11_TIMEOUT_MS",
  "NEXUS_CORTEX_11_HOST",
  "NEXUS_CORTEX_11_PORT",
] as const;

const event = {
  eventId: "evt-00000001",
  eventType: "lead.accepted",
  occurredAt: "2026-09-06T00:00:00.000Z",
  adUserDataConsent: "GRANTED",
  userIdentifiers: [{ kind: "EMAIL_SHA256", value: `sha256:${"a".repeat(64)}` }],
  data: { source: "web" },
} as const;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const key of envKeys) delete process.env[key];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configure() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex11-runtime-"));
  dirs.push(dir);
  const bearerFile = join(dir, "bearer-token");
  const signingFile = join(dir, "signing-secret");
  writeFileSync(bearerFile, "bearer-token-v1", { mode: 0o600 });
  writeFileSync(signingFile, "s".repeat(32), { mode: 0o600 });
  vi.stubEnv("NEXUS_CORTEX_11_DATABASE", join(dir, "relay.sqlite"));
  vi.stubEnv("NEXUS_CORTEX_11_ENDPOINT", "https://relay.example/v1/events");
  vi.stubEnv("NEXUS_CORTEX_11_BEARER_TOKEN_FILE", bearerFile);
  vi.stubEnv("NEXUS_CORTEX_11_SIGNING_SECRET_FILE", signingFile);
  vi.stubEnv("NEXUS_CORTEX_11_INGEST_TOKEN", "ingest-" + "i".repeat(32));
  vi.stubEnv("NEXUS_CORTEX_11_CONTROL_TOKEN", "control-" + "c".repeat(32));
  vi.stubEnv("NEXUS_CORTEX_11_PORT", "18081");
  return { dir, bearerFile, signingFile };
}

describe("CORTEX #11 production runtime", () => {
  it("constructs fail-closed and rereads outbound bearer/signing files on every dispatch", async () => {
    const { bearerFile, signingFile } = configure();
    const authorizations: string[] = [];
    const signatures: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      authorizations.push(headers.authorization);
      signatures.push(headers["x-nexus-signature"]);
      return new Response(null, { status: 204, headers: { "x-request-id": `request-0000000${authorizations.length}` } });
    }));
    const runtime = createWebhookRelayProductionRuntimeFromEnv();
    runtimes.push(runtime);
    expect(runtime.control.read().mode).toBe("KILLED");
    runtime.control.setMode("ACTIVE", 0);
    runtime.relay.prepare(event);
    await runtime.relay.dispatch(event.eventId);

    writeFileSync(bearerFile, "bearer-token-v2", { mode: 0o600 });
    writeFileSync(signingFile, "t".repeat(32), { mode: 0o600 });
    const second = { ...event, eventId: "evt-00000002" };
    runtime.relay.prepare(second);
    await runtime.relay.dispatch(second.eventId);

    expect(authorizations).toEqual(["Bearer bearer-token-v1", "Bearer bearer-token-v2"]);
    expect(signatures[0]).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(signatures[1]).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(signatures[1]).not.toBe(signatures[0]);
  });

  it("requires absolute state and secret paths, HTTPS destination and distinct server credentials", async () => {
    configure();
    vi.stubEnv("NEXUS_CORTEX_11_DATABASE", "relative.sqlite");
    expect(() => createWebhookRelayProductionRuntimeFromEnv()).toThrowError(/absolute path/u);

    configure();
    vi.stubEnv("NEXUS_CORTEX_11_ENDPOINT", "http://relay.example/v1/events");
    expect(() => createWebhookRelayProductionRuntimeFromEnv()).toThrowError(/HTTPS/u);

    configure();
    vi.stubEnv("NEXUS_CORTEX_11_CONTROL_TOKEN", process.env.NEXUS_CORTEX_11_INGEST_TOKEN!);
    expect(() => createWebhookRelayProductionRuntimeFromEnv()).toThrowError(/distinct credentials/u);
  });
});
