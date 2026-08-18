import { createHash } from "node:crypto";
import type { DnaContentConstraints } from "./content-constraints";
import type { CopyAssetInput } from "./content-readiness";

export type GroundedFactKind =
  | "BRAND_NAME"
  | "BUSINESS_TYPE"
  | "LOCATION"
  | "ADDRESS"
  | "PHONE"
  | "RATING"
  | "REVIEW_COUNT"
  | "HOURS"
  | "DIFFERENTIATOR"
  | "PROOF"
  | "OFFER"
  | "PRICE"
  | "BOOKING"
  | "SUBSCRIPTION"
  | "PRIMARY_ACTION_LABEL";

export interface GroundedFact {
  id: string;
  kind: GroundedFactKind;
  value: string;
  sourceId: string;
  provider?: string;
}

export interface GroundedCopyItem {
  role: string;
  text: string;
  sourceId: string;
  evidenceIds: readonly string[];
}

export interface GroundedCopyResult {
  authority: "NEXUS_GROUNDED_COPY_V1";
  locale: string;
  items: readonly GroundedCopyItem[];
  copyAssets: readonly CopyAssetInput[];
  evidenceFactIds: readonly string[];
  synthesisDigest: `sha256:${string}`;
}

const VALID_KINDS = new Set<GroundedFactKind>([
  "BRAND_NAME", "BUSINESS_TYPE", "LOCATION", "ADDRESS", "PHONE", "RATING", "REVIEW_COUNT", "HOURS",
  "DIFFERENTIATOR", "PROOF", "OFFER", "PRICE", "BOOKING", "SUBSCRIPTION", "PRIMARY_ACTION_LABEL",
]);
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function normalizeFacts(facts: readonly GroundedFact[]): readonly GroundedFact[] {
  const ids = new Set<string>();
  return Object.freeze(facts.map((fact) => {
    const id = fact.id.trim();
    const value = fact.value.trim();
    const sourceId = fact.sourceId.trim();
    if (!id || ids.has(id)) throw new Error("grounded facts require unique non-empty ids");
    ids.add(id);
    if (!VALID_KINDS.has(fact.kind) || !value || !sourceId) throw new Error(`grounded fact ${id} requires kind, value and sourceId`);
    return Object.freeze({ ...fact, id, value, sourceId, provider: fact.provider?.trim() || undefined });
  }));
}

function byKind(facts: readonly GroundedFact[], kind: GroundedFactKind): readonly GroundedFact[] {
  return facts.filter((fact) => fact.kind === kind);
}

function first(facts: readonly GroundedFact[], kind: GroundedFactKind): GroundedFact | undefined {
  return facts.find((fact) => fact.kind === kind);
}

function required(facts: readonly GroundedFact[], kind: GroundedFactKind, role: string): GroundedFact {
  const fact = first(facts, kind);
  if (!fact) throw new Error(`grounded copy cannot synthesize ${role}: missing ${kind} fact`);
  return fact;
}

function joinEvidence(facts: readonly GroundedFact[]): readonly string[] {
  return Object.freeze([...new Set(facts.flatMap((fact) => [fact.id, fact.sourceId]))]);
}

function sourceId(role: string, evidence: readonly string[]): string {
  return `nexus-grounded-copy:${role}:${sha256(JSON.stringify(evidence)).slice("sha256:".length, "sha256:".length + 16)}`;
}

function createItem(role: string, text: string, facts: readonly GroundedFact[]): GroundedCopyItem {
  if (!text.trim() || !facts.length) throw new Error(`grounded copy role ${role} requires text and evidence facts`);
  const evidenceIds = joinEvidence(facts);
  return Object.freeze({ role, text: text.trim(), sourceId: sourceId(role, evidenceIds), evidenceIds });
}

function localized(locale: string) {
  const es = locale.toLowerCase().startsWith("es");
  return es ? {
    at: "en",
    phone: "Teléfono",
    address: "Dirección",
    location: "Ubicación",
    hours: "Horario",
    rating: "Calificación",
    reviews: "reseñas",
    proofFallback: "Evidencia verificada",
    contact: "Contacto",
    details: "Información verificada",
  } : {
    at: "in",
    phone: "Phone",
    address: "Address",
    location: "Location",
    hours: "Hours",
    rating: "Rating",
    reviews: "reviews",
    proofFallback: "Verified evidence",
    contact: "Contact",
    details: "Verified information",
  };
}

function proofFacts(facts: readonly GroundedFact[]): readonly GroundedFact[] {
  return Object.freeze([
    ...byKind(facts, "PROOF"),
    ...byKind(facts, "RATING"),
    ...byKind(facts, "REVIEW_COUNT"),
  ]);
}

function proofText(facts: readonly GroundedFact[], locale: string): { text: string; facts: readonly GroundedFact[] } {
  const l = localized(locale);
  const explicit = byKind(facts, "PROOF");
  const rating = first(facts, "RATING");
  const reviewCount = first(facts, "REVIEW_COUNT");
  const parts: string[] = explicit.map((fact) => fact.value);
  if (rating && reviewCount) {
    const provider = rating.provider || reviewCount.provider;
    parts.push(`${provider ? `${provider}: ` : ""}${l.rating} ${rating.value}, ${reviewCount.value} ${l.reviews}.`);
  } else if (rating) {
    parts.push(`${rating.provider ? `${rating.provider}: ` : ""}${l.rating} ${rating.value}.`);
  } else if (reviewCount) {
    parts.push(`${reviewCount.provider ? `${reviewCount.provider}: ` : ""}${reviewCount.value} ${l.reviews}.`);
  }
  const used = proofFacts(facts);
  if (!parts.length || !used.length) throw new Error("grounded copy cannot synthesize proof without explicit proof/rating/review facts");
  return { text: parts.join(" "), facts: used };
}

function textForRole(role: string, facts: readonly GroundedFact[], locale: string): GroundedCopyItem {
  const l = localized(locale);
  switch (role) {
    case "headline": {
      const brand = required(facts, "BRAND_NAME", role);
      return createItem(role, brand.value, [brand]);
    }
    case "value-proposition": {
      const business = required(facts, "BUSINESS_TYPE", role);
      const location = first(facts, "LOCATION");
      const brand = first(facts, "BRAND_NAME");
      const used = [business, ...(location ? [location] : []), ...(brand ? [brand] : [])];
      const text = location ? `${business.value} ${l.at} ${location.value}.` : `${business.value}.`;
      return createItem(role, text, used);
    }
    case "primary-cta": {
      const label = first(facts, "PRIMARY_ACTION_LABEL");
      if (label) return createItem(role, label.value, [label]);
      const phone = required(facts, "PHONE", role);
      return createItem(role, l.contact, [phone]);
    }
    case "proof":
    case "credentials-and-proof": {
      const proof = proofText(facts, locale);
      return createItem(role, proof.text, proof.facts);
    }
    case "qualification-and-contact": {
      const phone = required(facts, "PHONE", role);
      const address = first(facts, "ADDRESS");
      const used = [phone, ...(address ? [address] : [])];
      const text = address ? `${l.phone}: ${phone.value}. ${l.address}: ${address.value}.` : `${l.phone}: ${phone.value}.`;
      return createItem(role, text, used);
    }
    case "location-and-hours": {
      const address = required(facts, "ADDRESS", role);
      const hours = first(facts, "HOURS");
      const used = [address, ...(hours ? [hours] : [])];
      const text = hours ? `${l.location}: ${address.value}. ${l.hours}: ${hours.value}.` : `${l.location}: ${address.value}.`;
      return createItem(role, text, used);
    }
    case "differentiators": {
      const values = byKind(facts, "DIFFERENTIATOR");
      if (!values.length) throw new Error("grounded copy cannot synthesize differentiators without DIFFERENTIATOR facts");
      return createItem(role, values.map((fact) => fact.value).join(" · "), values);
    }
    case "booking-details": {
      const booking = required(facts, "BOOKING", role);
      return createItem(role, booking.value, [booking]);
    }
    case "offer-and-pricing": {
      const offer = required(facts, "OFFER", role);
      const prices = byKind(facts, "PRICE");
      return createItem(role, [offer.value, ...prices.map((fact) => fact.value)].join(" "), [offer, ...prices]);
    }
    case "subscription-value": {
      const subscription = required(facts, "SUBSCRIPTION", role);
      return createItem(role, subscription.value, [subscription]);
    }
    default:
      throw new Error(`grounded copy has no evidence-safe grammar for required role ${role}`);
  }
}

export function synthesizeGroundedCopy(input: {
  constraints: DnaContentConstraints;
  facts: readonly GroundedFact[];
  locale: string;
}): GroundedCopyResult {
  const locale = input.locale.trim();
  if (!locale) throw new Error("grounded copy synthesis requires locale");
  const facts = normalizeFacts(input.facts);
  if (!facts.length) throw new Error("grounded copy synthesis requires factual evidence");

  const requiredProof = input.constraints.minimumProofItems;
  const availableProofFacts = proofFacts(facts);
  if (availableProofFacts.length < requiredProof) {
    throw new Error(`grounded copy requires at least ${requiredProof} distinct proof fact(s), but only ${availableProofFacts.length} were supplied`);
  }

  const items = input.constraints.requiredCopyRoles.map((role) => textForRole(role, facts, locale));
  const copyAssets = items.map((item) => Object.freeze({ role: item.role, text: item.text, source: item.sourceId }));
  const evidenceFactIds = Object.freeze([...new Set(items.flatMap((item) => item.evidenceIds))].sort((a, b) => a.localeCompare(b, "en")));
  const synthesisDigest = sha256(JSON.stringify(items.map(({ role, text, evidenceIds }) => ({ role, text, evidenceIds }))));
  return Object.freeze({ authority: "NEXUS_GROUNDED_COPY_V1", locale, items: Object.freeze(items), copyAssets: Object.freeze(copyAssets), evidenceFactIds, synthesisDigest });
}
