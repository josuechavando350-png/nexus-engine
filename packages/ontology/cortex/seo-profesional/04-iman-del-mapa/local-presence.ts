import {
  createLocalBusinessPresenceSnapshot,
  type LocalBusinessPostalAddress,
  type LocalBusinessPresenceSnapshot,
  type LocalBusinessProfile,
} from "./local-business.js";
import {
  GoogleBusinessProfileClient,
  type GoogleBusinessProfileExecutionMode,
  type GoogleBusinessProfileGoogleUpdated,
  type GoogleBusinessProfileLocation,
  type GoogleBusinessProfilePatch,
  type GoogleBusinessProfilePostalAddress,
  type GoogleBusinessProfileUpdateField,
} from "./google-business-profile.js";

export type LocalPresenceDriftField = GoogleBusinessProfileUpdateField;

export interface LocalPresenceSyncPlan {
  readonly status: "IN_SYNC" | "DRIFT";
  readonly driftFields: readonly LocalPresenceDriftField[];
  readonly updateMask: readonly GoogleBusinessProfileUpdateField[];
  readonly patch: Readonly<GoogleBusinessProfilePatch>;
}

export interface LocalPresenceAudit {
  readonly local: LocalBusinessPresenceSnapshot;
  readonly remote: GoogleBusinessProfileLocation;
  readonly syncPlan: LocalPresenceSyncPlan;
  readonly googleUpdated: GoogleBusinessProfileGoogleUpdated | null;
}

export interface LocalPresenceSyncReceipt {
  readonly status: "IN_SYNC" | "VALIDATED" | "APPLIED";
  readonly locationName: string;
  readonly driftFields: readonly LocalPresenceDriftField[];
  readonly localProfileDigest: `sha256:${string}`;
  readonly remote: GoogleBusinessProfileLocation;
}

export interface LocalBusinessPresenceEngineConfig {
  readonly profile: LocalBusinessProfile;
  readonly locationName: string;
  readonly client: GoogleBusinessProfileClient;
}

export class LocalBusinessPresenceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "GOOGLE_UPDATE_REVIEW_REQUIRED"
      | "LOCATION_NOT_UPDATABLE"
      | "POSTCONDITION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "LocalBusinessPresenceError";
  }
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^+0-9]/gu, "");
  return normalized || null;
}

function normalizeWebsite(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return value.trim();
  }
}

function normalizeAddress(value: LocalBusinessPostalAddress | GoogleBusinessProfilePostalAddress | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify({
    regionCode: value.regionCode.trim().toUpperCase(),
    addressLines: value.addressLines.map((line) => line.normalize("NFKC").replace(/\s+/gu, " ").trim()),
    locality: value.locality?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? null,
    administrativeArea: value.administrativeArea?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? null,
    postalCode: value.postalCode?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? null,
  });
}

function gbpAddress(value: LocalBusinessPostalAddress): GoogleBusinessProfilePostalAddress {
  return Object.freeze({
    regionCode: value.regionCode,
    addressLines: value.addressLines,
    ...(value.locality === undefined ? {} : { locality: value.locality }),
    ...(value.administrativeArea === undefined ? {} : { administrativeArea: value.administrativeArea }),
    ...(value.postalCode === undefined ? {} : { postalCode: value.postalCode }),
  });
}

export function buildLocalPresenceSyncPlan(
  local: LocalBusinessPresenceSnapshot,
  remote: GoogleBusinessProfileLocation,
): LocalPresenceSyncPlan {
  if (!local || typeof local !== "object" || !remote || typeof remote !== "object") {
    throw new LocalBusinessPresenceError("INVALID_INPUT", "local and remote presence snapshots are required");
  }
  const patch: {
    title?: string;
    websiteUri?: string;
    phoneNumbers?: Readonly<{ primaryPhone: string }>;
    storefrontAddress?: GoogleBusinessProfilePostalAddress;
  } = {};
  const driftFields: GoogleBusinessProfileUpdateField[] = [];
  const profile = local.profile;

  if (remote.title !== profile.name) {
    patch.title = profile.name;
    driftFields.push("title");
  }
  if (normalizeWebsite(remote.websiteUri) !== normalizeWebsite(profile.websiteUri)) {
    patch.websiteUri = profile.websiteUri;
    driftFields.push("websiteUri");
  }
  if (profile.primaryPhone !== undefined && normalizePhone(remote.phoneNumbers.primaryPhone) !== normalizePhone(profile.primaryPhone)) {
    patch.phoneNumbers = Object.freeze({ primaryPhone: profile.primaryPhone });
    driftFields.push("phoneNumbers.primaryPhone");
  }
  if (profile.storefrontAddress !== undefined && normalizeAddress(remote.storefrontAddress) !== normalizeAddress(profile.storefrontAddress)) {
    patch.storefrontAddress = gbpAddress(profile.storefrontAddress);
    driftFields.push("storefrontAddress");
  }

  return Object.freeze({
    status: driftFields.length === 0 ? "IN_SYNC" : "DRIFT",
    driftFields: Object.freeze(driftFields),
    updateMask: Object.freeze([...driftFields]),
    patch: Object.freeze(patch),
  });
}

export class LocalBusinessPresenceEngine {
  private readonly local: LocalBusinessPresenceSnapshot;
  private readonly locationName: string;
  private readonly client: GoogleBusinessProfileClient;

  constructor(config: LocalBusinessPresenceEngineConfig) {
    if (!config || typeof config !== "object") throw new LocalBusinessPresenceError("INVALID_CONFIG", "local presence config is required");
    if (!(config.client instanceof GoogleBusinessProfileClient)) throw new LocalBusinessPresenceError("INVALID_CONFIG", "GoogleBusinessProfileClient is required");
    if (typeof config.locationName !== "string" || !/^locations\/[A-Za-z0-9_-]{1,128}$/u.test(config.locationName)) {
      throw new LocalBusinessPresenceError("INVALID_CONFIG", "locationName must reference an existing Business Profile location");
    }
    this.local = createLocalBusinessPresenceSnapshot(config.profile);
    this.locationName = config.locationName;
    this.client = config.client;
  }

  snapshot(): LocalBusinessPresenceSnapshot {
    return this.local;
  }

  canonicalWebsiteOrigin(): string {
    return this.local.canonicalWebsiteOrigin;
  }

  async auditGoogleBusinessProfile(): Promise<LocalPresenceAudit> {
    const remote = await this.client.getLocation(this.locationName);
    const googleUpdated = remote.metadata.hasGoogleUpdated === true
      ? await this.client.getGoogleUpdated(this.locationName)
      : null;
    return Object.freeze({
      local: this.local,
      remote,
      syncPlan: buildLocalPresenceSyncPlan(this.local, remote),
      googleUpdated,
    });
  }

  async syncGoogleBusinessProfile(executionMode: GoogleBusinessProfileExecutionMode): Promise<LocalPresenceSyncReceipt> {
    if (!(executionMode === "VALIDATE_ONLY" || executionMode === "APPLY")) throw new LocalBusinessPresenceError("INVALID_INPUT", "executionMode must be VALIDATE_ONLY or APPLY");
    const remote = await this.client.getLocation(this.locationName);
    if (remote.metadata.hasGoogleUpdated === true) {
      throw new LocalBusinessPresenceError("GOOGLE_UPDATE_REVIEW_REQUIRED", "Google has pending location updates; review them before NEXUS writes Business Profile fields");
    }
    const plan = buildLocalPresenceSyncPlan(this.local, remote);
    if (plan.status === "IN_SYNC") {
      return Object.freeze({
        status: "IN_SYNC",
        locationName: this.locationName,
        driftFields: plan.driftFields,
        localProfileDigest: this.local.profileDigest,
        remote,
      });
    }
    if (remote.metadata.canUpdate === false) throw new LocalBusinessPresenceError("LOCATION_NOT_UPDATABLE", "Business Profile reports that this location cannot be updated");
    const mutationResult = await this.client.patchLocation(this.locationName, plan.patch, plan.updateMask, executionMode);
    if (executionMode === "VALIDATE_ONLY") {
      return Object.freeze({
        status: "VALIDATED",
        locationName: this.locationName,
        driftFields: plan.driftFields,
        localProfileDigest: this.local.profileDigest,
        remote: mutationResult,
      });
    }

    const verified = await this.client.getLocation(this.locationName);
    const postcondition = buildLocalPresenceSyncPlan(this.local, verified);
    if (postcondition.status !== "IN_SYNC") {
      throw new LocalBusinessPresenceError("POSTCONDITION_FAILED", `Business Profile still differs after apply: ${postcondition.driftFields.join(",")}`);
    }
    return Object.freeze({
      status: "APPLIED",
      locationName: this.locationName,
      driftFields: plan.driftFields,
      localProfileDigest: this.local.profileDigest,
      remote: verified,
    });
  }
}
