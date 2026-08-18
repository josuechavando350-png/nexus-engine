import { createHash } from "node:crypto";
import type { ExperienceDNA } from "@nexus/experience";
import type { OpeningCandidate } from "./opening-tournament";

export interface OpeningReferencePrinciple {
  principle: string;
  evidenceId: string;
}

export interface OpeningGenerationInput {
  dna: ExperienceDNA;
  businessSignals: readonly string[];
  references: readonly OpeningReferencePrinciple[];
}

type StrategyName = "SPATIAL_FIELD" | "EDITORIAL_SEQUENCE" | "CINEMATIC_REVEAL";

type Strategy = Readonly<{
  name: StrategyName;
  strength: number;
  concept: (input: OpeningGenerationInput, reference: OpeningReferencePrinciple) => string;
  mechanic: (dna: ExperienceDNA, reference: OpeningReferencePrinciple) => string;
  signature: (dna: ExperienceDNA) => string;
}>;

const FORBIDDEN_TEMPLATE_TERMS = ["hero", "feature cards", "pill nav", "card grid", "cta band"] as const;

function normalized(values: readonly string[], field: string, minimum: number): string[] {
  const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (result.length < minimum) throw new Error(`${field} requires at least ${minimum} distinct non-empty values`);
  return result;
}

function validateReferences(references: readonly OpeningReferencePrinciple[]): OpeningReferencePrinciple[] {
  const valid = references.map((reference) => ({ principle: reference.principle.trim(), evidenceId: reference.evidenceId.trim() }));
  if (valid.some((reference) => !reference.principle || !reference.evidenceId)) throw new Error("opening references require principle and evidenceId");
  if (new Set(valid.map((reference) => reference.evidenceId)).size < 2) throw new Error("opening generation requires at least two distinct reference evidence ids");
  if (new Set(valid.map((reference) => reference.principle.toLowerCase())).size < 2) throw new Error("opening generation requires at least two distinct reference principles");
  return valid;
}

function average(...values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function collectDnaEvidence(dna: ExperienceDNA): string[] {
  const rationales = [
    dna.composition.asymmetry.rationale,
    dna.composition.continuity.rationale,
    dna.composition.dominantFlow.rationale,
    dna.density.whitespace.rationale,
    dna.geometry.dominantShape.rationale,
    dna.typography.scaleContrast.rationale,
    dna.typography.voice.rationale,
    dna.media.dominance.rationale,
    dna.media.role.rationale,
    dna.interaction.spatiality.rationale,
    dna.interaction.language.rationale,
    dna.motion.intensity.rationale,
    dna.motion.choreography.rationale,
  ];
  return [...new Set(rationales.flatMap((rationale) => rationale.evidence ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

function assertAntiTemplate(candidate: OpeningCandidate): void {
  const haystack = `${candidate.concept} ${candidate.signatureMechanic} ${candidate.openingSignature}`.toLowerCase();
  const found = FORBIDDEN_TEMPLATE_TERMS.find((term) => haystack.includes(term));
  if (found) throw new Error(`opening generator emitted forbidden template term: ${found}`);
}

function strategies(dna: ExperienceDNA): Strategy[] {
  return [
    {
      name: "SPATIAL_FIELD",
      strength: average(dna.composition.asymmetry.value, dna.interaction.spatiality.value, dna.composition.continuity.value),
      concept: (input, reference) => `${input.dna.subject}: stage the opening as a continuous spatial field governed by ${input.dna.composition.dominantFlow.label}; business meaning comes from ${input.businessSignals[0]} and the reference principle “${reference.principle}”.`,
      mechanic: (value, reference) => `A continuous ${value.geometry.dominantShape.label} field makes ${value.interaction.language.label} interaction alter spatial emphasis while preserving “${reference.principle}” as the governing reference rule.`,
      signature: (value) => `SPATIAL_FIELD|${value.composition.dominantFlow.label}|${value.geometry.dominantShape.label}|${value.interaction.language.label}`,
    },
    {
      name: "EDITORIAL_SEQUENCE",
      strength: average(dna.editoriality.value, dna.typography.scaleContrast.value, dna.density.whitespace.value),
      concept: (input, reference) => `${input.dna.subject}: construct an editorial sequence where ${input.dna.typography.voice.label} voice and ${input.dna.composition.dominantFlow.label} flow reveal ${input.businessSignals[1]} through the reference principle “${reference.principle}”.`,
      mechanic: (value, reference) => `The opening changes reading scale and information cadence around ${value.typography.voice.label}; each transition exposes a new business-specific layer while enforcing “${reference.principle}”.`,
      signature: (value) => `EDITORIAL_SEQUENCE|${value.typography.voice.label}|${value.composition.dominantFlow.label}|${value.cta.grammar.label}`,
    },
    {
      name: "CINEMATIC_REVEAL",
      strength: average(dna.cinematicity.value, dna.media.dominance.value, dna.motion.intensity.value),
      concept: (input, reference) => `${input.dna.subject}: choreograph a progressive reveal in which ${input.dna.media.role.label} media earns attention by clarifying ${input.businessSignals[2]}, guided by the reference principle “${reference.principle}”.`,
      mechanic: (value, reference) => `${value.motion.choreography.label} choreography couples media continuity with ${value.interaction.language.label} interaction so the reveal communicates “${reference.principle}” instead of acting as decoration.`,
      signature: (value) => `CINEMATIC_REVEAL|${value.media.role.label}|${value.motion.choreography.label}|${value.interaction.language.label}`,
    },
  ];
}

export function generateOpeningCandidates(input: OpeningGenerationInput): readonly OpeningCandidate[] {
  if (input.dna.version !== 2) throw new Error("opening generation requires ExperienceDNA v2");
  if (!input.dna.subject.trim()) throw new Error("opening generation requires a DNA subject");
  const businessSignals = normalized(input.businessSignals, "businessSignals", 3);
  const references = validateReferences(input.references);
  const normalizedInput: OpeningGenerationInput = { dna: input.dna, businessSignals, references };
  const dnaEvidence = collectDnaEvidence(input.dna);

  const ranked = strategies(input.dna)
    .map((strategy, index) => ({ ...strategy, index }))
    .sort((left, right) => right.strength - left.strength || left.index - right.index);

  const candidates = ranked.map((strategy, rank) => {
    const reference = references[rank % references.length]!;
    const openingSignature = strategy.signature(input.dna);
    const identity = JSON.stringify({ subject: input.dna.subject, strategy: strategy.name, openingSignature, reference, businessSignals });
    const candidate: OpeningCandidate = Object.freeze({
      openingId: `opening_${rank + 1}_${shortHash(identity)}`,
      concept: strategy.concept(normalizedInput, reference),
      signatureMechanic: strategy.mechanic(input.dna, reference),
      openingSignature,
      evidenceIds: Object.freeze([...new Set([reference.evidenceId, ...dnaEvidence])].sort()),
    });
    assertAntiTemplate(candidate);
    return candidate;
  });

  if (new Set(candidates.map((candidate) => candidate.openingSignature.toLowerCase())).size !== 3) {
    throw new Error("opening generation did not produce three structurally distinct signatures");
  }
  if (candidates.some((candidate) => candidate.evidenceIds.length === 0)) throw new Error("generated openings require traceable evidence");
  return Object.freeze(candidates);
}
