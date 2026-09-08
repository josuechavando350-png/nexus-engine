import {
  GoogleAdsOfflineConversionClient,
  GoogleDataManagerOfflineConversionSink,
  QualifiedOfflineConversionEngine,
  type GoogleAdsOfflineConversionClientConfig,
  type GoogleDataManagerOfflineConversionSinkConfig,
  type OfflineConversionProvider,
  type OfflineConversionQualificationPolicy,
  type OfflineConversionCandidate,
  type OfflineConversionUploadOptions,
  type QualifiedOfflineConversionEngineResult,
} from "./offline-conversions.js";

const CUSTOMER_ID = /^\d{5,20}$/u;

export interface OfflineConversionDestinationIdentity {
  readonly provider: OfflineConversionProvider;
  readonly googleAdsCustomerId: string;
}

export class IdentifiedQualifiedOfflineConversionEngine {
  private constructor(
    private readonly identity: OfflineConversionDestinationIdentity,
    private readonly engine: QualifiedOfflineConversionEngine,
  ) {}

  static forGoogleAdsApi(
    policy: OfflineConversionQualificationPolicy,
    config: GoogleAdsOfflineConversionClientConfig,
  ): IdentifiedQualifiedOfflineConversionEngine {
    const googleAdsCustomerId = normalizeCustomerId(config.customerId, "customerId");
    const sink = new GoogleAdsOfflineConversionClient(config);
    return new IdentifiedQualifiedOfflineConversionEngine(
      Object.freeze({ provider: "GOOGLE_ADS_API", googleAdsCustomerId }),
      new QualifiedOfflineConversionEngine(policy, sink),
    );
  }

  static forGoogleDataManager(
    policy: OfflineConversionQualificationPolicy,
    config: GoogleDataManagerOfflineConversionSinkConfig,
  ): IdentifiedQualifiedOfflineConversionEngine {
    const googleAdsCustomerId = normalizeCustomerId(config.destination.operatingAccountId, "destination.operatingAccountId");
    const sink = new GoogleDataManagerOfflineConversionSink(config);
    return new IdentifiedQualifiedOfflineConversionEngine(
      Object.freeze({ provider: "GOOGLE_DATA_MANAGER", googleAdsCustomerId }),
      new QualifiedOfflineConversionEngine(policy, sink),
    );
  }

  destinationIdentity(): OfflineConversionDestinationIdentity {
    return this.identity;
  }

  process(
    candidate: OfflineConversionCandidate,
    options?: OfflineConversionUploadOptions,
  ): Promise<QualifiedOfflineConversionEngineResult> {
    return this.engine.process(candidate, options);
  }
}

function normalizeCustomerId(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.replaceAll("-", "").trim();
  if (!CUSTOMER_ID.test(normalized)) throw new TypeError(`${label} is malformed`);
  return normalized;
}
