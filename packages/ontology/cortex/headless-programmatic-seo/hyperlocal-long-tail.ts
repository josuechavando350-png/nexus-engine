import { createHash } from "node:crypto";
import {
  ProgrammaticSeoError,
  createProgrammaticSeoCatalogSnapshot,
  validateProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoPageInput,
} from "./index";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

export interface HyperlocalLongTailPolicy {
  readonly version: 1;
  readonly maxHyperlocalCatalogAgeMs: number;
  readonly maxHyperlocalPages: number;
  readonly minimumHyperlocalDistinctiveStatements: number;
  readonly minimumGeoEvidenceRefs: number;
  readonly minimumDemandEvidenceRefs: number;
  readonly geoEvidencePrefix: string;
  readonly demandEvidencePrefix: string;
  readonly allowedHyperlocalSourceIds: readonly string[];
}

export interface HyperlocalLongTailCatalogProviderOptions {
  readonly baseCatalog: ProgrammaticSeoCatalogProvider;
  readonly hyperlocalCatalog: ProgrammaticSeoCatalogProvider;
  readonly policy: HyperlocalLongTailPolicy;
  readonly now?: () => number;
}

function positiveInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be 1..${max}`);
  return value;
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function prefix(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 32 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be a safe 2..32 character prefix`);
  return normalized;
}

function canonicalUtc(value: string, field: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  return parsed.getTime();
}

export function createHyperlocalLongTailPolicy(input: HyperlocalLongTailPolicy): HyperlocalLongTailPolicy {
  if (input.version !== 1) throw new ProgrammaticSeoError("INVALID_INPUT", "hyperlocal long-tail policy version must be 1");
  const maxHyperlocalCatalogAgeMs = positiveInt(input.maxHyperlocalCatalogAgeMs, "maxHyperlocalCatalogAgeMs", 30 * 24 * 60 * 60 * 1000);
  const maxHyperlocalPages = positiveInt(input.maxHyperlocalPages, "maxHyperlocalPages", 2_000);
  const minimumHyperlocalDistinctiveStatements = positiveInt(input.minimumHyperlocalDistinctiveStatements, "minimumHyperlocalDistinctiveStatements", 20);
  const minimumGeoEvidenceRefs = positiveInt(input.minimumGeoEvidenceRefs, "minimumGeoEvidenceRefs", 20);
  const minimumDemandEvidenceRefs = positiveInt(input.minimumDemandEvidenceRefs, "minimumDemandEvidenceRefs", 20);
  const geoEvidencePrefix = prefix(input.geoEvidencePrefix, "geoEvidencePrefix");
  const demandEvidencePrefix = prefix(input.demandEvidencePrefix, "demandEvidencePrefix");
  if (geoEvidencePrefix === demandEvidencePrefix || geoEvidencePrefix.startsWith(demandEvidencePrefix) || demandEvidencePrefix.startsWith(geoEvidencePrefix)) {
    throw new ProgrammaticSeoError("INVALID_INPUT", "geo and demand evidence prefixes must be distinct and non-overlapping");
  }
  if (!Array.isArray(input.allowedHyperlocalSourceIds) || input.allowedHyperlocalSourceIds.length < 1 || input.allowedHyperlocalSourceIds.length > 32) throw new ProgrammaticSeoError("INVALID_INPUT", "allowedHyperlocalSourceIds must contain 1..32 items");
  const allowedHyperlocalSourceIds = input.allowedHyperlocalSourceIds.map((value) => identifier(value, "allowedHyperlocalSourceId"));
  if (new Set(allowedHyperlocalSourceIds).size !== allowedHyperlocalSourceIds.length) throw new ProgrammaticSeoError("INVALID_INPUT", "allowedHyperlocalSourceIds must be unique");
  return Object.freeze({
    version: 1,
    maxHyperlocalCatalogAgeMs,
    maxHyperlocalPages,
    minimumHyperlocalDistinctiveStatements,
    minimumGeoEvidenceRefs,
    minimumDemandEvidenceRefs,
    geoEvidencePrefix,
    demandEvidencePrefix,
    allowedHyperlocalSourceIds: Object.freeze(allowedHyperlocalSourceIds),
  });
}

function path(page: ProgrammaticSeoPageInput): string {
  return page.routeSegments.length === 0 ? "/" : `/${page.routeSegments.join("/")}/`;
}

function assertHyperlocalPage(page: ProgrammaticSeoPageInput, policy: HyperlocalLongTailPolicy): void {
  if (!page.indexable) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal page ${page.pageId} must be explicitly indexable to enter the long-tail bundle`);
  if (page.distinctiveStatements.length < policy.minimumHyperlocalDistinctiveStatements) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal page ${page.pageId} lacks page-specific distinctive statements`);
  const geoEvidence = page.evidenceRefs.filter((value) => value.startsWith(policy.geoEvidencePrefix));
  const demandEvidence = page.evidenceRefs.filter((value) => value.startsWith(policy.demandEvidencePrefix));
  if (geoEvidence.length < policy.minimumGeoEvidenceRefs) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal page ${page.pageId} lacks verified geographic evidence`);
  if (demandEvidence.length < policy.minimumDemandEvidenceRefs) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal page ${page.pageId} lacks verified long-tail demand evidence`);
  if (new Set(geoEvidence).size !== geoEvidence.length || new Set(demandEvidence).size !== demandEvidence.length) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal page ${page.pageId} contains duplicate evidence references`);
}

export class HyperlocalLongTailCatalogProvider implements ProgrammaticSeoCatalogProvider {
  readonly policy: HyperlocalLongTailPolicy;
  private readonly now: () => number;

  constructor(private readonly options: HyperlocalLongTailCatalogProviderOptions) {
    this.policy = createHyperlocalLongTailPolicy(options.policy);
    this.now = options.now ?? Date.now;
  }

  async getCatalog(siteId: string): Promise<ProgrammaticSeoCatalogSnapshot> {
    const [base, hyperlocal] = await Promise.all([
      this.options.baseCatalog.getCatalog(siteId),
      this.options.hyperlocalCatalog.getCatalog(siteId),
    ]);
    validateProgrammaticSeoCatalogSnapshot(base);
    validateProgrammaticSeoCatalogSnapshot(hyperlocal);
    if (base.siteId !== siteId || hyperlocal.siteId !== siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "base/hyperlocal catalog siteId mismatch");
    if (base.baseUrl !== hyperlocal.baseUrl) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "base/hyperlocal catalog baseUrl mismatch");
    if (!this.policy.allowedHyperlocalSourceIds.includes(hyperlocal.sourceId)) throw new ProgrammaticSeoError("POLICY_VIOLATION", "hyperlocal catalog source is not allowlisted");
    const hyperlocalObservedAt = canonicalUtc(hyperlocal.observedAt, "hyperlocal observedAt");
    const age = this.now() - hyperlocalObservedAt;
    if (age < 0 || age > this.policy.maxHyperlocalCatalogAgeMs) throw new ProgrammaticSeoError("POLICY_VIOLATION", "hyperlocal catalog is stale or future-dated");
    if (hyperlocal.pages.length < 1 || hyperlocal.pages.length > this.policy.maxHyperlocalPages) throw new ProgrammaticSeoError("POLICY_VIOLATION", "hyperlocal catalog page count is outside policy");

    for (const page of hyperlocal.pages) assertHyperlocalPage(page, this.policy);
    const baseIds = new Set(base.pages.map((page) => page.pageId));
    const basePaths = new Set(base.pages.map(path));
    for (const page of hyperlocal.pages) {
      if (baseIds.has(page.pageId)) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal pageId ${page.pageId} collides with the base catalog`);
      if (basePaths.has(path(page))) throw new ProgrammaticSeoError("POLICY_VIOLATION", `hyperlocal route ${path(page)} collides with the base catalog`);
    }

    const compositeSourceId = "hyperlocal-long-tail-v1";
    const compositeObservedAt = new Date(Math.min(canonicalUtc(base.observedAt, "base observedAt"), hyperlocalObservedAt)).toISOString();
    const sourceVersion = createHash("sha256").update(`${base.digest}\n${hyperlocal.digest}`, "utf8").digest("hex");
    const pages = Object.freeze([...base.pages, ...hyperlocal.pages]);
    const snapshot = createProgrammaticSeoCatalogSnapshot({
      sourceId: compositeSourceId,
      siteId,
      baseUrl: base.baseUrl,
      observedAt: compositeObservedAt,
      pages,
    });
    if (!snapshot.digest.includes("sha256:")) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `composite catalog digest failed for source version ${sourceVersion}`);
    return snapshot;
  }
}
