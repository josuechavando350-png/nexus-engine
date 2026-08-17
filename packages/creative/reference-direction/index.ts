import {
  DeterministicArtDirectionEngine,
  type CreativeBrief,
  type DirectionCandidate,
  type DirectionConfig,
  type DirectionProposal,
} from "../direction";
import type { GalleryEntry } from "../gallery";
import type { RankedMemory } from "../memory";
import { lexicalCompare } from "../shared";

export type ReferenceSupport = Readonly<{
  directionId: string;
  score: number;
  referenceEntryIds: readonly string[];
  matchedSignals: readonly string[];
}>;

export type ReferenceGroundedDirectionProposal = Readonly<{
  proposal: DirectionProposal;
  referenceSupport: readonly ReferenceSupport[];
  referenceEntryIds: readonly string[];
}>;

export type ReferenceGroundingConfig = Readonly<{
  minimumReferences: number;
  minimumReferenceSupport: number;
}>;

const normalize = (value: string): string => value.trim().toLowerCase();
const unique = (values: readonly string[]): string[] => [...new Set(values.map(normalize).filter(Boolean))].sort(lexicalCompare);

function referenceSignals(entry: GalleryEntry): string[] {
  return unique([entry.title, entry.description, ...entry.tags, ...entry.intents, ...entry.techniques]);
}

function candidateSignals(candidate: DirectionCandidate): string[] {
  return unique([candidate.label, ...candidate.keywords, ...candidate.brandSignals, ...candidate.satisfiesConstraints]);
}

function supportFor(candidate: DirectionCandidate, references: readonly GalleryEntry[]): ReferenceSupport {
  const candidateValues = candidateSignals(candidate);
  const matchedSignals = new Set<string>();
  const matchedEntries: string[] = [];
  let total = 0;

  for (const entry of references) {
    const signals = referenceSignals(entry);
    const matches = candidateValues.filter((candidateValue) => signals.some((signal) => signal.includes(candidateValue) || candidateValue.includes(signal)));
    const score = candidateValues.length ? matches.length / candidateValues.length : 0;
    if (score > 0) {
      matchedEntries.push(entry.entryId);
      matches.forEach((match) => matchedSignals.add(match));
      total += score;
    }
  }

  return Object.freeze({
    directionId: candidate.directionId,
    score: references.length ? Math.min(1, total / references.length) : 0,
    referenceEntryIds: Object.freeze(matchedEntries.sort(lexicalCompare)),
    matchedSignals: Object.freeze([...matchedSignals].sort(lexicalCompare)),
  });
}

export class ReferenceGroundedArtDirectionEngine {
  constructor(private readonly engine = new DeterministicArtDirectionEngine()) {}

  propose(input: Readonly<{
    brief: CreativeBrief;
    candidates: readonly DirectionCandidate[];
    memory: readonly RankedMemory[];
    references: readonly GalleryEntry[];
    directionConfig: DirectionConfig;
    groundingConfig: ReferenceGroundingConfig;
  }>): ReferenceGroundedDirectionProposal {
    const { minimumReferences, minimumReferenceSupport } = input.groundingConfig;
    if (!Number.isInteger(minimumReferences) || minimumReferences < 1) throw new Error("minimumReferences must be a positive integer");
    if (!Number.isFinite(minimumReferenceSupport) || minimumReferenceSupport < 0 || minimumReferenceSupport > 1) throw new Error("minimumReferenceSupport must be in [0,1]");

    const uniqueReferences = new Map(input.references.map((entry) => [entry.entryId, entry]));
    if (uniqueReferences.size < minimumReferences) throw new Error(`at least ${minimumReferences} unique Creative Gallery/Vault references are required`);
    const references = [...uniqueReferences.values()];
    const wrongScope = references.filter((entry) => entry.scope.tenantId !== input.brief.scope.tenantId || entry.scope.brandId !== input.brief.scope.brandId);
    if (wrongScope.length) throw new Error(`reference scope mismatch: ${wrongScope.map((entry) => entry.entryId).sort(lexicalCompare).join(", ")}`);

    const referenceSupport = input.candidates.map((candidate) => supportFor(candidate, references));
    const eligibleIds = new Set(referenceSupport.filter((support) => support.score >= minimumReferenceSupport).map((support) => support.directionId));
    const eligibleCandidates = input.candidates.filter((candidate) => eligibleIds.has(candidate.directionId));
    if (!eligibleCandidates.length) throw new Error("no art-direction candidate is grounded in the supplied Creative Gallery/Vault references");

    const proposal = this.engine.propose({
      brief: input.brief,
      candidates: eligibleCandidates,
      memory: input.memory,
      config: input.directionConfig,
    });

    return Object.freeze({
      proposal,
      referenceSupport: Object.freeze(referenceSupport.sort((a, b) => b.score - a.score || lexicalCompare(a.directionId, b.directionId))),
      referenceEntryIds: Object.freeze(references.map((entry) => entry.entryId).sort(lexicalCompare)),
    });
  }
}
