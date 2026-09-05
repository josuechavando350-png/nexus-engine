import type { OntologyScope } from "@nexus/ontology";
import type { OntologyTransactionPort } from "@nexus/ontology/transaction";
import {
  BehavioralSignalTrackingEngine,
  type BehavioralSignalEventInput,
  type BehavioralSignalPolicy,
  type BehavioralSignalPrivacyConfig,
  type BehavioralSignalIngestResult,
  type BehavioralSessionSnapshot,
  type BehavioralSiteSnapshot,
} from "./index";
import {
  BehavioralMicroInteractionTrackingEngine,
  type BehavioralMicroInteractionInput,
  type BehavioralMicroInteractionResult,
  type BehavioralMicroSessionSnapshot,
  type BehavioralMicroSiteSnapshot,
} from "./browser-micro-signals";

export * from "./index";
export * from "./browser-micro-signals";

export class CortexBehavioralSignalSuite {
  readonly behavioralSignals: BehavioralSignalTrackingEngine;
  readonly microInteractions: BehavioralMicroInteractionTrackingEngine;

  constructor(
    transactions: OntologyTransactionPort,
    scope: OntologyScope,
    policy: BehavioralSignalPolicy,
    privacy: BehavioralSignalPrivacyConfig,
    now: () => number = Date.now,
  ) {
    this.behavioralSignals = new BehavioralSignalTrackingEngine(transactions, scope, policy, privacy, now);
    this.microInteractions = new BehavioralMicroInteractionTrackingEngine(transactions, scope, policy, privacy, now);
  }

  ingest(input: BehavioralSignalEventInput): BehavioralSignalIngestResult {
    return this.behavioralSignals.ingest(input);
  }

  ingestMicroInteraction(input: BehavioralMicroInteractionInput): BehavioralMicroInteractionResult {
    return this.microInteractions.ingest(input);
  }

  getSessionSnapshot(siteId: string, sessionId: string): BehavioralSessionSnapshot | null {
    return this.behavioralSignals.getSessionSnapshot(siteId, sessionId);
  }

  getSiteSnapshot(siteId: string): BehavioralSiteSnapshot | null {
    return this.behavioralSignals.getSiteSnapshot(siteId);
  }

  getMicroSessionSnapshot(siteId: string, sessionId: string): BehavioralMicroSessionSnapshot | null {
    return this.microInteractions.getSessionSnapshot(siteId, sessionId);
  }

  getMicroSiteSnapshot(siteId: string): BehavioralMicroSiteSnapshot | null {
    return this.microInteractions.getSiteSnapshot(siteId);
  }
}
