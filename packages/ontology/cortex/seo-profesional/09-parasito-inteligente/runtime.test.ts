import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "../../../transaction.js";
import {
  createProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoPublisher,
} from "../../headless-programmatic-seo/index.js";
import {
  PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY,
  ProgrammaticPropertyAuthorizationError,
  type ProgrammaticPropertyAuthorizationPort,
} from "./property-authorization.js";
import { AuthorizedProgrammaticSeoRuntime } from "./runtime.js";

const NOW = Date.parse("2026-09-08T20:45:00.000Z");

function snapshot() {
  return createProgrammaticSeoCatalogSnapshot({
    sourceId: "editorial-main",
    siteId: "site-main",
    baseUrl: "https://example.test/guides/",
    observedAt: "2026-09-08T20:44:00.000Z",
    pages: [{
      pageId: "root",
      routeSegments: [],
      parentPageId: null,
      locale: "es-MX",
      title: "Guías de arquitectura digital",
      description: "Guías editoriales con evidencia first-party y navegación útil.",
      heading: "Arquitectura digital",
      bodyText: "Arquitectura digital. La guía documenta decisiones concretas de arquitectura digital. Una guía editorial controlada con evidencia específica para el usuario.",
      distinctiveStatements: ["La guía documenta decisiones concretas de arquitectura digital."],
      evidenceRefs: ["first-party:architecture-guide:2026-09"],
      updatedAt: "2026-09-08T20:40:00.000Z",
      indexable: true,
    }],
  });
}

function publisher(readCounter: { value: number }): ProgrammaticSeoPublisher {
  return {
    stage: async () => { throw new Error("OBSERVE_ONLY must not stage"); },
    load: async () => { throw new Error("not exercised"); },
    read: async () => { readCounter.value += 1; return null; },
    apply: async () => { throw new Error("OBSERVE_ONLY must not apply"); },
  };
}

function validAuthorizer(counter: { value: number }): ProgrammaticPropertyAuthorizationPort {
  return {
    verify: async (input) => {
      counter.value += 1;
      return Object.freeze({
        kind: "FIRST_PARTY_CANONICAL_ORIGIN" as const,
        siteId: input.siteId,
        propertyBaseUrl: input.propertyBaseUrl,
        propertyOrigin: new URL(input.propertyBaseUrl).origin,
        operatorWebsiteOrigin: input.operatorWebsiteOrigin,
        verifiedAt: "2026-09-08T20:45:00.000Z",
        expiresAt: null,
        dnsName: null,
        proofDigest: `sha256:${"a".repeat(64)}`,
        policyVersion: PROGRAMMATIC_PROPERTY_AUTHORIZATION_POLICY,
      });
    },
  };
}

function runtime(input: { authorizer: ProgrammaticPropertyAuthorizationPort; catalog?: ProgrammaticSeoCatalogProvider; readCounter?: { value: number } }) {
  const readCounter = input.readCounter ?? { value: 0 };
  return new AuthorizedProgrammaticSeoRuntime({
    siteId: "site-main",
    propertyBaseUrl: "https://example.test/guides/",
    operatorWebsiteOrigin: "https://example.test",
    scope: { tenantId: "tenant-main", organizationId: "org-main" },
    policy: { policyId: "seo9-policy", version: "v1", maxCatalogAgeMs: 86_400_000, maxPages: 20, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.8, maxRouteDepth: 8, mode: "OBSERVE_ONLY" },
    transactions: new InMemoryOntologyTransactionStore(),
    catalog: input.catalog ?? { getCatalog: async () => snapshot() },
    publisher: publisher(readCounter),
    authorizer: input.authorizer,
    allowedSources: [{ sourceId: "editorial-main", relationship: "OPERATOR_FIRST_PARTY" }],
    now: () => NOW,
  });
}

describe("AuthorizedProgrammaticSeoRuntime", () => {
  it("runs the canonical ProgrammaticSeoEngine only after current property authorization", async () => {
    const auth = { value: 0 };
    const reads = { value: 0 };
    const result = await runtime({ authorizer: validAuthorizer(auth), readCounter: reads }).build({ runId: "seo9-observe-001" });
    expect(result.programmatic).toMatchObject({ status: "NOOP", reason: "OBSERVE_ONLY", mode: "OBSERVE_ONLY" });
    expect(result.authorization).toMatchObject({ kind: "FIRST_PARTY_CANONICAL_ORIGIN" });
    expect(result.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(auth.value).toBe(1);
    expect(reads.value).toBe(1);
  });

  it("fails before catalog/publisher I/O when property authorization is denied", async () => {
    let catalogCalls = 0;
    const catalog: ProgrammaticSeoCatalogProvider = { getCatalog: async () => { catalogCalls += 1; return snapshot(); } };
    const authorizer: ProgrammaticPropertyAuthorizationPort = { verify: async () => { throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_REQUIRED", "missing delegation"); } };
    const reads = { value: 0 };
    await expect(runtime({ authorizer, catalog, readCounter: reads }).build({ runId: "seo9-denied-001" })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect(catalogCalls).toBe(0);
    expect(reads.value).toBe(0);
  });

  it("preserves canonical KILLED semantics with zero authorization/catalog/publisher I/O", async () => {
    const auth = { value: 0 };
    let catalogCalls = 0;
    const catalog: ProgrammaticSeoCatalogProvider = { getCatalog: async () => { catalogCalls += 1; return snapshot(); } };
    const reads = { value: 0 };
    const result = await runtime({ authorizer: validAuthorizer(auth), catalog, readCounter: reads }).build({ runId: "seo9-killed-001", mode: "KILLED" });
    expect(result.programmatic).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });
    expect(result.authorization).toBeNull();
    expect(auth.value).toBe(0);
    expect(catalogCalls).toBe(0);
    expect(reads.value).toBe(0);
  });

  it("requires fresh authorization before rollback can reach the canonical engine", async () => {
    const authorizer: ProgrammaticPropertyAuthorizationPort = { verify: async () => { throw new ProgrammaticPropertyAuthorizationError("AUTHORIZATION_EXPIRED", "expired"); } };
    await expect(runtime({ authorizer }).rollbackLastMutation({ runId: "seo9-rollback-001" })).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  });
});
