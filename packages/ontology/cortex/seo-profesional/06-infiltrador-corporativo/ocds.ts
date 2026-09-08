import { createHash } from "node:crypto";

export class OcdsParseError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "MALFORMED_OCDS" | "BOUNDS_EXCEEDED", message: string) {
    super(message);
    this.name = "OcdsParseError";
  }
}

export interface ProcurementOpportunity {
  readonly opportunityId: string;
  readonly sourceKind: "OCDS" | "PUBLIC_HTML";
  readonly sourceUrl: string;
  readonly buyerName: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: string | null;
  readonly procurementMethod: string | null;
  readonly deadline: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly documentUrls: readonly string[];
  readonly observedAt: string;
}

const MAX_RELEASES = 500;
const MAX_TEXT = 20_000;
const MAX_DOCUMENTS = 32;

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new OcdsParseError("BOUNDS_EXCEEDED", "OCDS text field exceeds the configured bound");
  return normalized;
}

function canonicalDate(value: unknown): string | null {
  const text = boundedText(value, 128);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeUrl(value: unknown, sourceOrigin: string): string | null {
  const text = boundedText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text, sourceOrigin);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stableOpportunityId(sourceUrl: string, releaseId: string): string {
  return `ocds_${createHash("sha256").update(`${sourceUrl}\n${releaseId}`, "utf8").digest("hex")}`;
}

function releaseList(input: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(input.releases)) return input.releases;
  if (Array.isArray(input.records)) {
    const releases: unknown[] = [];
    for (const recordValue of input.records) {
      const record = plainObject(recordValue);
      if (!record) continue;
      const compiledRelease = plainObject(record.compiledRelease);
      if (compiledRelease) releases.push(compiledRelease);
    }
    return releases;
  }
  throw new OcdsParseError("MALFORMED_OCDS", "OCDS payload must expose releases or records");
}

export function parseOcdsOpportunities(input: unknown, sourceUrl: URL, observedAt: string): readonly ProcurementOpportunity[] {
  const root = plainObject(input);
  if (!root || !(sourceUrl instanceof URL) || sourceUrl.protocol !== "https:") throw new OcdsParseError("INVALID_INPUT", "OCDS parser input is invalid");
  const when = new Date(observedAt);
  if (!Number.isFinite(when.getTime()) || when.toISOString() !== observedAt) throw new OcdsParseError("INVALID_INPUT", "observedAt must be canonical UTC");
  const releases = releaseList(root);
  if (releases.length > MAX_RELEASES) throw new OcdsParseError("BOUNDS_EXCEEDED", "OCDS payload contains too many releases");

  const opportunities: ProcurementOpportunity[] = [];
  for (const releaseValue of releases) {
    const release = plainObject(releaseValue);
    if (!release) continue;
    const tender = plainObject(release.tender);
    if (!tender) continue;
    const releaseId = boundedText(release.id, 512) ?? boundedText(release.ocid, 512);
    const title = boundedText(tender.title) ?? boundedText(release.tag, 512);
    if (!releaseId || !title) continue;
    const buyer = plainObject(release.buyer);
    const period = plainObject(tender.tenderPeriod);
    const value = plainObject(tender.value);
    const docs = Array.isArray(tender.documents) ? tender.documents.slice(0, MAX_DOCUMENTS) : [];
    const documentUrls = docs.flatMap((entry) => {
      const doc = plainObject(entry);
      const url = doc ? safeUrl(doc.url, sourceUrl.origin) : null;
      return url ? [url] : [];
    });
    const amount = typeof value?.amount === "number" && Number.isFinite(value.amount) && value.amount >= 0 ? value.amount : null;
    opportunities.push(Object.freeze({
      opportunityId: stableOpportunityId(sourceUrl.toString(), releaseId),
      sourceKind: "OCDS" as const,
      sourceUrl: sourceUrl.toString(),
      buyerName: boundedText(buyer?.name, 2000),
      title,
      description: boundedText(tender.description) ?? "",
      status: boundedText(tender.status, 128),
      procurementMethod: boundedText(tender.procurementMethodDetails, 512) ?? boundedText(tender.procurementMethod, 128),
      deadline: canonicalDate(period?.endDate),
      amount,
      currency: boundedText(value?.currency, 16),
      documentUrls: Object.freeze(documentUrls),
      observedAt,
    }));
  }
  return Object.freeze(opportunities);
}
