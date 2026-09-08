import type { ValidatedSchema } from "../../../index.js";
import type { OntologyReadPort } from "../../../persistence-query.js";
import { buildUnifiedSemanticGraph, type UnifiedSemanticGraph } from "../../../semantic-graph.js";
import {
  VerifiedStructuredKnowledgeEngine,
  type GroundedRichResultRule,
  type GroundedStructuredDataArtifact,
  type RenderedPageEvidence,
} from "./structured-knowledge.js";

export interface SemanticGraphProviderPort {
  current(): Promise<UnifiedSemanticGraph>;
}

export interface RenderedPageEvidencePort {
  capture(pageUrl: string): Promise<RenderedPageEvidence>;
}

export interface StructuredKnowledgePublishRequest {
  readonly pageUrl: string;
  readonly rules: readonly GroundedRichResultRule[];
}

export class CanonicalSemanticGraphProvider implements SemanticGraphProviderPort {
  constructor(
    private readonly readPort: OntologyReadPort,
    private readonly schema: ValidatedSchema,
    private readonly now: () => number = Date.now,
  ) {}

  async current(): Promise<UnifiedSemanticGraph> {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("semantic graph clock returned a non-finite value");
    return buildUnifiedSemanticGraph(this.readPort, this.schema, new Date(now).toISOString());
  }
}

export class VerifiedStructuredKnowledgeRuntime {
  private readonly engine: VerifiedStructuredKnowledgeEngine;

  constructor(input: {
    readonly publisherWebsiteOrigin: string;
    readonly graphProvider: SemanticGraphProviderPort;
    readonly pageEvidence: RenderedPageEvidencePort;
    readonly now?: () => number;
    readonly maxEvidenceAgeMs?: number;
  }) {
    if (!input.graphProvider || typeof input.graphProvider.current !== "function") throw new Error("graphProvider.current is required");
    if (!input.pageEvidence || typeof input.pageEvidence.capture !== "function") throw new Error("pageEvidence.capture is required");
    this.graphProvider = input.graphProvider;
    this.pageEvidence = input.pageEvidence;
    this.engine = new VerifiedStructuredKnowledgeEngine({
      publisherWebsiteOrigin: input.publisherWebsiteOrigin,
      ...(input.now ? { now: input.now } : {}),
      ...(input.maxEvidenceAgeMs === undefined ? {} : { maxEvidenceAgeMs: input.maxEvidenceAgeMs }),
    });
  }

  private readonly graphProvider: SemanticGraphProviderPort;
  private readonly pageEvidence: RenderedPageEvidencePort;

  identity() {
    return this.engine.identity();
  }

  async publish(input: StructuredKnowledgePublishRequest): Promise<GroundedStructuredDataArtifact> {
    if (!input || typeof input !== "object") throw new Error("structured knowledge publish input is required");
    const graph = await this.graphProvider.current();
    const pageEvidence = await this.pageEvidence.capture(input.pageUrl);
    return this.engine.build({ graph, pageUrl: input.pageUrl, pageEvidence, rules: input.rules });
  }
}
