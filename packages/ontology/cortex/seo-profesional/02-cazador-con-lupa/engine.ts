import {
  GoogleAdsExactMatchClient,
  type ExactMatchMaterializationOptions,
  type ExactMatchMaterializationReceipt,
} from "./google-ads-keywords.js";
import {
  selectExactMatchCandidates,
  type ExactMatchSelectionPolicy,
  type ExactMatchSelectionResult,
} from "./search-term-synthesizer.js";

export interface ExactMatchSynthesizerRunRequest {
  readonly customerId: string;
  readonly policy: ExactMatchSelectionPolicy;
  readonly campaignIds?: readonly string[];
  readonly materialization: ExactMatchMaterializationOptions;
}

export interface ExactMatchSynthesizerRunResult {
  readonly observationCount: number;
  readonly selection: ExactMatchSelectionResult;
  readonly materialization: ExactMatchMaterializationReceipt;
}

export class ExactMatchSynthesizerEngine {
  constructor(private readonly client: GoogleAdsExactMatchClient) {
    if (!client || typeof client.fetchSearchTermObservations !== "function" || typeof client.materializeExactMatches !== "function") {
      throw new TypeError("GoogleAdsExactMatchClient is required");
    }
  }

  async run(request: ExactMatchSynthesizerRunRequest): Promise<ExactMatchSynthesizerRunResult> {
    if (!request || typeof request !== "object") throw new TypeError("exact match synthesizer request is required");
    const observations = await this.client.fetchSearchTermObservations(request.customerId, {
      startDate: request.policy.startDate,
      endDate: request.policy.endDate,
      campaignIds: request.campaignIds,
    });
    const selection = selectExactMatchCandidates(observations, request.policy);
    const materialization = await this.client.materializeExactMatches(request.customerId, selection.selected, request.materialization);
    return Object.freeze({ observationCount: observations.length, selection, materialization });
  }
}
