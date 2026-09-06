import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import {
  createProgrammaticSeoBundleRef,
  createProgrammaticSeoCatalogSnapshot,
  createProgrammaticSeoPolicy,
  type ProgrammaticSeoBundle,
  type ProgrammaticSeoBundleRef,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoPublishReceipt,
  type ProgrammaticSeoPublisher,
  type PublishedProgrammaticSeoBundle,
} from "./index";
import { JsonFileProgrammaticSeoPublisher } from "./json-file-page-bundle-publisher";
import { createProgrammaticSeoProductionRuntime, parseProgrammaticSeoProductionConfig, type ProgrammaticSeoProductionRuntime } from "./production-runtime";
import { ProgrammaticSeoRuntimeController } from "./runtime-control";

const NOW = Date.parse("2026-09-06T04:00:00.000Z");
const RUN_TOKEN = "programmatic-run-token-0000000000000000000000";
const CONTROL_TOKEN = "programmatic-control-token-00000000000000000";
const BUNDLE_TOKEN = "programmatic-bundle-token-000000000000000000";
const scope = Object.freeze({ tenantId: "tenant-prod", organizationId: "org-prod", brandId: "cano-penal" });
const policyInput = Object.freeze({ policyId: "cano-programmatic", version: "v1", maxCatalogAgeMs: 300_000, maxPages: 20, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.85, maxRouteDepth: 5, maxWriteRetries: 3, mode: "ACTIVE" as const });
const config = parseProgrammaticSeoProductionConfig({ version: 1, scope, intervalMs: 300_000, siteId: "cano-penal", baseUrl: "https://canopenal.com/", policy: policyInput });
const directories: string[] = [];

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function snapshot(now = NOW): ProgrammaticSeoCatalogSnapshot {
  return createProgrammaticSeoCatalogSnapshot({
    sourceId: "approved-cano-content",
    siteId: "cano-penal",
    baseUrl: "https://canopenal.com/",
    observedAt: new Date(now).toISOString(),
    pages: [{
      pageId: "home",
      routeSegments: [],
      parentPageId: null,
      locale: "es-MX",
      title: "CANO | Defensa Penal",
      description: "Contenido aprobado de defensa penal.",
      heading: "Defensa penal estratégica",
      bodyText: "Defensa penal estratégica. Contenido aprobado y verificado para la página principal.",
      distinctiveStatements: ["Contenido aprobado y verificado para la página principal."],
      evidenceRefs: ["cano:home:approved"],
      updatedAt: new Date(NOW - 1_000).toISOString(),
      indexable: true,
    }],
  });
}

class Source implements ProgrammaticSeoCatalogProvider {
  calls = 0;
  constructor(private readonly now: () => number = () => NOW) {}
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { this.calls += 1; return snapshot(this.now()); }
}

class BlockingSource implements ProgrammaticSeoCatalogProvider {
  calls = 0;
  readonly entered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;
  constructor(private readonly now: () => number) {
    this.entered = new Promise<void>((resolve) => { this.enter = resolve; });
    this.released = new Promise<void>((resolve) => { this.release = resolve; });
  }
  unblock(): void { this.release(); }
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { this.calls += 1; this.enter(); await this.released; return snapshot(this.now()); }
}

class KillBeforeApplyPublisher implements ProgrammaticSeoPublisher {
  applyCalls = 0;
  private staged: ProgrammaticSeoBundle | null = null;
  constructor(private readonly kill: () => void) {}
  async stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef> {
    this.staged = bundle;
    const ref = createProgrammaticSeoBundleRef(bundle.siteId, bundle.digest, `bundle-${bundle.digest.slice(7)}`);
    this.kill();
    return ref;
  }
  async load(): Promise<ProgrammaticSeoBundle> {
    if (!this.staged) throw new Error("missing staged bundle");
    return this.staged;
  }
  async read(): Promise<PublishedProgrammaticSeoBundle | null> { return null; }
  async apply(): Promise<ProgrammaticSeoPublishReceipt> {
    this.applyCalls += 1;
    throw new Error("underlying publisher must never be reached after kill");
  }
}

async function listen(runtime: ProgrammaticSeoProductionRuntime): Promise<string> {
  await new Promise<void>((resolve, reject) => { runtime.server.once("error", reject); runtime.server.listen(0, "127.0.0.1", () => resolve()); });
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("runtime did not expose TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function api(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

function runtimeOptions(store: SqliteOntologyTransactionStore, source: ProgrammaticSeoCatalogProvider, publisher: ProgrammaticSeoPublisher, now: () => number) {
  return { transactions: store, config, catalog: source, publisher, runToken: RUN_TOKEN, controlToken: CONTROL_TOKEN, bundleToken: BUNDLE_TOKEN, now } as const;
}

describe("programmatic SEO production runtime", () => {
  it("persists kill, serves the real bundle, and permits explicit rollback across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-programmatic-production-")); directories.push(directory);
    const dbPath = join(directory, "cortex.sqlite");
    const manifestPath = join(directory, "programmatic-manifest.json");
    let now = NOW;
    const source = new Source(() => now);
    const publisher = new JsonFileProgrammaticSeoPublisher({ manifestPath });
    let store = new SqliteOntologyTransactionStore(dbPath);
    let runtime = createProgrammaticSeoProductionRuntime(runtimeOptions(store, source, publisher, () => now));
    let base = await listen(runtime);

    const first = await runtime.runOnce("MANUAL");
    expect(first).toMatchObject({ status: "APPLIED", reason: "BUNDLE_PUBLISHED", mode: "ACTIVE" });
    expect(source.calls).toBe(1);

    const bundle = await api(base, "/v1/programmatic-seo/bundle?siteId=cano-penal", BUNDLE_TOKEN);
    expect(bundle.status).toBe(200);
    expect(await bundle.json()).toMatchObject({ siteId: "cano-penal", bundle: { siteId: "cano-penal", baseUrl: "https://canopenal.com/", pages: [{ pageId: "home", title: "CANO | Defensa Penal" }] } });

    const kill = await api(base, "/v1/programmatic-seo/control", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "emergency stop for production investigation" }) });
    expect(kill.status).toBe(200);
    expect(await kill.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 }, effectiveMode: "KILLED" });

    const sourceCalls = source.calls;
    const killed = await runtime.runOnce("SCHEDULED");
    expect(killed).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });
    expect(source.calls).toBe(sourceCalls);

    await runtime.close(); store.close();
    store = new SqliteOntologyTransactionStore(dbPath);
    runtime = createProgrammaticSeoProductionRuntime(runtimeOptions(store, source, publisher, () => now));
    base = await listen(runtime);
    const persisted = await api(base, "/v1/programmatic-seo/control", CONTROL_TOKEN);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 }, effectiveMode: "KILLED", history: [{ fromMode: "ACTIVE", toMode: "KILLED", targetRevision: 1 }] });

    const rollback = await api(base, "/v1/programmatic-seo/rollback", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ runId: "rollback-001" }) });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ result: { status: "ROLLED_BACK", reason: "ROLLBACK_APPLIED" } });
    const afterRollback = await api(base, "/v1/programmatic-seo/bundle?siteId=cano-penal", BUNDLE_TOKEN);
    expect(afterRollback.status).toBe(404);
    await runtime.close(); store.close();
  });

  it("re-reads durable control at the final publisher boundary and blocks a late kill", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const policy = createProgrammaticSeoPolicy(policyInput);
    const control = new ProgrammaticSeoRuntimeController(store, scope, policy.digest, policy.mode, () => NOW);
    const publisher = new KillBeforeApplyPublisher(() => {
      control.set({ expectedRevision: 0, mode: "KILLED", reason: "late incident containment" });
    });
    const runtime = createProgrammaticSeoProductionRuntime({
      transactions: store,
      config,
      catalog: new Source(),
      publisher,
      runToken: RUN_TOKEN,
      controlToken: CONTROL_TOKEN,
      bundleToken: BUNDLE_TOKEN,
      now: () => NOW,
    });

    await expect(runtime.runOnce("MANUAL")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(publisher.applyCalls).toBe(0);
    expect(control.effectiveMode()).toBe("KILLED");
    await runtime.close();
  });

  it("blocks a kill that lands while catalog I/O is in flight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-programmatic-race-")); directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    const publisher = new JsonFileProgrammaticSeoPublisher({ manifestPath: join(directory, "manifest.json") });
    const source = new BlockingSource(() => NOW);
    const runtime = createProgrammaticSeoProductionRuntime(runtimeOptions(store, source, publisher, () => NOW));
    const base = await listen(runtime);

    const run = runtime.runOnce("MANUAL");
    await source.entered;
    const kill = await api(base, "/v1/programmatic-seo/control", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "last moment production containment" }) });
    expect(kill.status).toBe(200);
    source.unblock();
    await expect(run).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(await publisher.read("cano-penal")).toBeNull();
    await runtime.close(); store.close();
  });

  it("separates privileges and rejects unknown production config fields", async () => {
    expect(() => parseProgrammaticSeoProductionConfig({ ...config, unexpected: true })).toThrow(/unknown field unexpected/i);
    const directory = mkdtempSync(join(tmpdir(), "nexus-programmatic-auth-")); directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    const runtime = createProgrammaticSeoProductionRuntime(runtimeOptions(store, new Source(), new JsonFileProgrammaticSeoPublisher({ manifestPath: join(directory, "manifest.json") }), () => NOW));
    const base = await listen(runtime);
    expect((await api(base, "/v1/programmatic-seo/control", RUN_TOKEN)).status).toBe(401);
    expect((await api(base, "/v1/programmatic-seo/bundle?siteId=cano-penal", CONTROL_TOKEN)).status).toBe(401);
    expect((await api(base, "/v1/programmatic-seo/run", BUNDLE_TOKEN, { method: "POST", body: "{}" })).status).toBe(401);
    await runtime.close(); store.close();
  });
});
