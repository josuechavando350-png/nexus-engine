import type { ExperienceDNA } from "./dna";
import type { ContentReadinessPolicy } from "./content-readiness";

export type BusinessGoal = "BOOK" | "BUY" | "VISIT" | "INQUIRE" | "TRUST" | "SUBSCRIBE";

export interface BusinessContentProfile {
  businessType: string;
  goals: readonly BusinessGoal[];
  differentiators: readonly string[];
}

export interface DerivedContentConstraint {
  kind: "COPY_ROLE" | "PHOTO_ROLE" | "STRUCTURE";
  role: string;
  because: string;
}

export interface DnaContentConstraints {
  authority: "NEXUS_DNA_CONTENT_CONSTRAINTS_V1";
  subject: string;
  businessType: string;
  requiredCopyRoles: readonly string[];
  requiredPhotoRoles: readonly string[];
  maximumPrimaryCtaOccurrences: number;
  minimumProofItems: number;
  constraints: readonly DerivedContentConstraint[];
}

const uniqueSorted = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b, "en")));

function assertProfile(profile: BusinessContentProfile): void {
  if (!profile.businessType.trim()) throw new Error("businessType is required");
  if (!profile.goals.length) throw new Error("at least one business goal is required");
  if (new Set(profile.goals).size !== profile.goals.length) throw new Error("business goals cannot contain duplicates");
  if (profile.differentiators.some((value) => !value.trim())) throw new Error("differentiators cannot contain empty values");
}

function goalCopyRole(goal: BusinessGoal): string {
  switch (goal) {
    case "BOOK": return "booking-details";
    case "BUY": return "offer-and-pricing";
    case "VISIT": return "location-and-hours";
    case "INQUIRE": return "qualification-and-contact";
    case "TRUST": return "credentials-and-proof";
    case "SUBSCRIBE": return "subscription-value";
  }
}

export function deriveDnaContentConstraints(
  dna: ExperienceDNA,
  profile: BusinessContentProfile,
): DnaContentConstraints {
  assertProfile(profile);

  const requiredCopyRoles = ["headline", "value-proposition", "primary-cta", "proof"];
  const requiredPhotoRoles: string[] = [];
  const constraints: DerivedContentConstraint[] = [
    { kind: "COPY_ROLE", role: "headline", because: "Every experience needs an explicit subject-level promise rather than generic decorative copy." },
    { kind: "COPY_ROLE", role: "value-proposition", because: `The experience must explain why this ${profile.businessType.trim()} is materially specific.` },
    { kind: "COPY_ROLE", role: "proof", because: "Delivery cannot rely on unsubstantiated premium language without concrete evidence." },
    { kind: "COPY_ROLE", role: "primary-cta", because: "The primary business action must be explicit and content-backed." },
  ];

  for (const goal of profile.goals) {
    const role = goalCopyRole(goal);
    requiredCopyRoles.push(role);
    constraints.push({ kind: "COPY_ROLE", role, because: `Required by business goal ${goal}.` });
  }

  if (profile.differentiators.length > 0) {
    requiredCopyRoles.push("differentiators");
    constraints.push({ kind: "COPY_ROLE", role: "differentiators", because: "The supplied business differentiators must survive into production content rather than being replaced by generic category copy." });
  }

  if (dna.media.dominance.value >= 0.55) {
    requiredPhotoRoles.push("hero-media", "proof-media");
    constraints.push(
      { kind: "PHOTO_ROLE", role: "hero-media", because: "ExperienceDNA.media.dominance requires real media evidence in the dominant opening role." },
      { kind: "PHOTO_ROLE", role: "proof-media", because: "A media-dominant direction cannot reuse one decorative asset as all visual proof." },
    );
  }

  if (dna.media.documentaryVsAbstract.value >= 0.6) {
    requiredPhotoRoles.push("documentary-context");
    constraints.push({ kind: "PHOTO_ROLE", role: "documentary-context", because: "ExperienceDNA.media.documentaryVsAbstract requests documentary evidence of the real business/context." });
  }

  if (dna.cinematicity.value >= 0.7 && dna.media.dominance.value >= 0.45) {
    requiredPhotoRoles.push("cinematic-sequence");
    constraints.push({ kind: "PHOTO_ROLE", role: "cinematic-sequence", because: "High cinematicity with meaningful media dominance requires a second production-ready visual beat, not a single hero still." });
  }

  const maximumPrimaryCtaOccurrences = dna.cta.repetition.value < 0.34 ? 1 : dna.cta.repetition.value < 0.67 ? 2 : 3;
  constraints.push({
    kind: "STRUCTURE",
    role: "primary-cta-occurrences",
    because: `ExperienceDNA.cta.repetition=${dna.cta.repetition.value} constrains primary CTA repetition to at most ${maximumPrimaryCtaOccurrences}.`,
  });

  const minimumProofItems = dna.editoriality.value >= 0.7 || profile.goals.includes("TRUST") ? 2 : 1;
  constraints.push({
    kind: "STRUCTURE",
    role: "proof-items",
    because: `Editorial depth and business trust requirements require at least ${minimumProofItems} distinct proof item(s).`,
  });

  return Object.freeze({
    authority: "NEXUS_DNA_CONTENT_CONSTRAINTS_V1",
    subject: dna.subject,
    businessType: profile.businessType.trim(),
    requiredCopyRoles: uniqueSorted(requiredCopyRoles),
    requiredPhotoRoles: uniqueSorted(requiredPhotoRoles),
    maximumPrimaryCtaOccurrences,
    minimumProofItems,
    constraints: Object.freeze(constraints.map((constraint) => Object.freeze(constraint))),
  });
}

export function toContentReadinessPolicy(
  constraints: DnaContentConstraints,
  imageMinimums: { widthPx?: number; heightPx?: number } = {},
): ContentReadinessPolicy {
  if (imageMinimums.widthPx !== undefined && (!Number.isInteger(imageMinimums.widthPx) || imageMinimums.widthPx < 1)) throw new Error("widthPx must be a positive integer");
  if (imageMinimums.heightPx !== undefined && (!Number.isInteger(imageMinimums.heightPx) || imageMinimums.heightPx < 1)) throw new Error("heightPx must be a positive integer");
  return Object.freeze({
    requiredPhotoRoles: constraints.requiredPhotoRoles,
    requiredCopyRoles: constraints.requiredCopyRoles,
    minimumPhotoWidthPx: imageMinimums.widthPx,
    minimumPhotoHeightPx: imageMinimums.heightPx,
  });
}
