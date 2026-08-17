import type { GalleryEntry } from "../gallery";
import { assertCanonicalId, assertNonEmpty, assertScope, lexicalCompare, type CreativeScope } from "../shared";

export type VerdictState = "PASS" | "FAIL" | "WARNING" | "NOT_TESTED";

export type ConventionalPattern =
  | "NAV"
  | "HERO_SPLIT"
  | "HERO_OVERLAY"
  | "FEATURE_CARDS"
  | "NUMBERED_SECTIONS"
  | "TEXT_IMAGE_SPLIT"
  | "ICON_GRID"
  | "LOGO_CLOUD"
  | "TESTIMONIALS"
  | "GALLERY_GRID"
  | "CTA_BAND"
  | "CONTACT_FOOTER"
  | "PILL_NAV"
  | "DECORATIVE_ARROWS"
  | "GENERIC_GRADIENT"
  | "GENERIC_GLASS";

export type CreativeExecutionContract = Readonly<{
  schemaVersion: 1;
  projectId: string;
  scope: CreativeScope;
  visualThesis: string;
  signatureMechanic: string;
  compositionGrammar: readonly string[];
  businessSpecificSignals: readonly string[];
  referenceEntryIds: readonly string[];
  referencePrinciples: readonly string[];
  conventionalPatterns: readonly ConventionalPattern[];
  genericPatternsRejected: readonly string[];
  desktopArtDirection: string;
  mobileArtDirection: string;
  mobileTransformationSignals: readonly string[];
  motionPurpose: readonly string[];
  signatureMechanicPlacements: readonly string[];
  adversarial: Readonly<{
    brandSwapVerdict: "PASS" | "FAIL" | "NOT_TESTED";
    crossIndustryReuseReasons: readonly string[];
  }>;
}>;

export type CreativeCriticFindingCode =
  | "INVALID_CONTRACT"
  | "REFERENCE_EVIDENCE_MISSING"
  | "REFERENCE_SCOPE_MISMATCH"
  | "REFERENCE_PRINCIPLES_INSUFFICIENT"
  | "VISUAL_THESIS_WEAK"
  | "SIGNATURE_MECHANIC_WEAK"
  | "BUSINESS_SPECIFICITY_LOW"
  | "COMPOSITION_GRAMMAR_WEAK"
  | "GENERIC_PATTERN_DOMINANCE"
  | "CONVENTIONAL_STACK"
  | "MOBILE_ART_DIRECTION_WEAK"
  | "MOTION_PURPOSE_WEAK"
  | "BRAND_SWAP_NOT_TESTED"
  | "BRAND_SWAP_PORTABILITY_HIGH";

export type CreativeCriticFinding = Readonly<{
  code: CreativeCriticFindingCode;
  severity: "BLOCK" | "WARN";
  detail: string;
}>;

export type CreativeCriticReport = Readonly<{
  authority: "NEXUS_CREATIVE_CRITIC";
  verdict: VerdictState;
  approved: boolean;
  findings: readonly CreativeCriticFinding[];
  referenceEntryIds: readonly string[];
}>;

const CONVENTIONAL_STACKS = [
  ["NAV", "HERO_SPLIT", "FEATURE_CARDS", "GALLERY_GRID", "CONTACT_FOOTER"],
  ["PILL_NAV", "HERO_OVERLAY", "TEXT_IMAGE_SPLIT", "CTA_BAND"],
  ["NAV", "HERO_OVERLAY", "TEXT_IMAGE_SPLIT", "FEATURE_CARDS", "CONTACT_FOOTER"],
] as const satisfies readonly (readonly ConventionalPattern[])[];

const normalize = (value: string): string => value.trim().toLowerCase();
const unique = (values: readonly string[]): string[] => [...new Set(values.map(normalize).filter(Boolean))].sort(lexicalCompare);

function hasOrderedSubsequence<T>(values: readonly T[], expected: readonly T[]): boolean {
  let cursor = 0;
  for (const value of values) {
    if (value === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return false;
}

function validateContract(contract: CreativeExecutionContract): void {
  if (!contract || contract.schemaVersion !== 1 || !contract.scope || !contract.adversarial) {
    throw new Error("creative execution contract structure is invalid");
  }
  assertScope(contract.scope);
  assertCanonicalId(contract.projectId, "contract.projectId");
  assertNonEmpty(contract.visualThesis, "contract.visualThesis");
  assertNonEmpty(contract.signatureMechanic, "contract.signatureMechanic");
  assertNonEmpty(contract.desktopArtDirection, "contract.desktopArtDirection");
  assertNonEmpty(contract.mobileArtDirection, "contract.mobileArtDirection");
  const lists = [
    contract.compositionGrammar,
    contract.businessSpecificSignals,
    contract.referenceEntryIds,
    contract.referencePrinciples,
    contract.genericPatternsRejected,
    contract.mobileTransformationSignals,
    contract.motionPurpose,
    contract.signatureMechanicPlacements,
    contract.adversarial.crossIndustryReuseReasons,
  ];
  if (lists.some((values) => !Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim()))) {
    throw new Error("creative execution contract contains malformed string lists");
  }
  if (!Array.isArray(contract.conventionalPatterns)) throw new Error("conventionalPatterns must be an array");
  if (!["PASS", "FAIL", "NOT_TESTED"].includes(contract.adversarial.brandSwapVerdict)) {
    throw new Error("brandSwapVerdict must be PASS, FAIL, or NOT_TESTED");
  }
}

function finding(code: CreativeCriticFindingCode, detail: string, severity: "BLOCK" | "WARN" = "BLOCK"): CreativeCriticFinding {
  return Object.freeze({ code, severity, detail });
}

export class NexusCreativeCritic {
  evaluate(contract: CreativeExecutionContract, references: readonly GalleryEntry[]): CreativeCriticReport {
    const findings: CreativeCriticFinding[] = [];
    try {
      validateContract(contract);
    } catch (error) {
      return Object.freeze({
        authority: "NEXUS_CREATIVE_CRITIC",
        verdict: "FAIL",
        approved: false,
        findings: Object.freeze([finding("INVALID_CONTRACT", error instanceof Error ? error.message : "invalid contract")]),
        referenceEntryIds: Object.freeze([]),
      });
    }

    const referenceMap = new Map(references.map((entry) => [entry.entryId, entry]));
    const requestedReferences = unique(contract.referenceEntryIds);
    const resolved = requestedReferences.map((id) => referenceMap.get(id)).filter((entry): entry is GalleryEntry => Boolean(entry));
    const missing = requestedReferences.filter((id) => !referenceMap.has(id));
    if (requestedReferences.length < 2 || missing.length) {
      findings.push(finding("REFERENCE_EVIDENCE_MISSING", missing.length
        ? `missing declared gallery references: ${missing.join(", ")}`
        : "at least two traceable Creative Gallery/Vault references are required"));
    }

    const wrongScope = resolved.filter((entry) => entry.scope.tenantId !== contract.scope.tenantId || entry.scope.brandId !== contract.scope.brandId);
    if (wrongScope.length) findings.push(finding("REFERENCE_SCOPE_MISMATCH", `out-of-scope references: ${wrongScope.map((entry) => entry.entryId).sort(lexicalCompare).join(", ")}`));
    if (unique(contract.referencePrinciples).length < 2) findings.push(finding("REFERENCE_PRINCIPLES_INSUFFICIENT", "references must be translated into at least two reusable principles; copying surface styling does not count"));

    if (contract.visualThesis.trim().length < 32) findings.push(finding("VISUAL_THESIS_WEAK", "visual thesis is too weak to govern a project-specific experience"));
    if (contract.signatureMechanic.trim().length < 28 || unique(contract.signatureMechanicPlacements).length < 2) {
      findings.push(finding("SIGNATURE_MECHANIC_WEAK", "signature mechanic must be substantive and shape at least two moments of the experience"));
    }
    if (unique(contract.businessSpecificSignals).length < 3) findings.push(finding("BUSINESS_SPECIFICITY_LOW", "at least three business-specific signals are required"));
    if (unique(contract.compositionGrammar).length < 3) findings.push(finding("COMPOSITION_GRAMMAR_WEAK", "composition grammar needs at least three explicit project-specific rules"));

    const patterns = contract.conventionalPatterns;
    const conventionalRatio = patterns.length / Math.max(1, unique(contract.compositionGrammar).length + patterns.length);
    if (patterns.length >= 5 && conventionalRatio >= 0.55) {
      findings.push(finding("GENERIC_PATTERN_DOMINANCE", `conventional primitives dominate the declared grammar (${patterns.length} conventional patterns)`));
    }
    const matchedStack = CONVENTIONAL_STACKS.find((stack) => hasOrderedSubsequence(patterns, stack));
    if (matchedStack && unique(contract.signatureMechanicPlacements).length < 3) {
      findings.push(finding("CONVENTIONAL_STACK", `conventional page stack detected: ${matchedStack.join(" -> ")}`));
    }

    if (contract.mobileArtDirection.trim().length < 28 || unique(contract.mobileTransformationSignals).length < 2 || normalize(contract.mobileArtDirection) === normalize(contract.desktopArtDirection)) {
      findings.push(finding("MOBILE_ART_DIRECTION_WEAK", "mobile must be art-directed as a transformation, not a stacked or copied desktop composition"));
    }
    if (unique(contract.motionPurpose).length < 2) findings.push(finding("MOTION_PURPOSE_WEAK", "motion needs at least two explicit communicative purposes"));

    const reuseReasons = unique(contract.adversarial.crossIndustryReuseReasons);
    if (contract.adversarial.brandSwapVerdict === "NOT_TESTED") {
      findings.push(finding("BRAND_SWAP_NOT_TESTED", "brand-swap adversarial test must run before approval"));
    } else if (contract.adversarial.brandSwapVerdict === "FAIL" || reuseReasons.length >= 2) {
      findings.push(finding("BRAND_SWAP_PORTABILITY_HIGH", reuseReasons.length
        ? `brand-swap adversarial test failed: ${reuseReasons.join("; ")}`
        : "brand-swap adversarial test failed"));
    }

    const blockers = findings.filter((item) => item.severity === "BLOCK");
    const warnings = findings.filter((item) => item.severity === "WARN");
    const verdict: VerdictState = blockers.length ? "FAIL" : warnings.length ? "WARNING" : "PASS";
    return Object.freeze({
      authority: "NEXUS_CREATIVE_CRITIC",
      verdict,
      approved: verdict === "PASS",
      findings: Object.freeze(findings.sort((a, b) => lexicalCompare(a.code, b.code))),
      referenceEntryIds: Object.freeze(resolved.map((entry) => entry.entryId).sort(lexicalCompare)),
    });
  }
}
