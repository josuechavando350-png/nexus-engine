import { canonicalSpeculationJson, speculationDigest, type SpeculativeEvidenceState } from "./speculative-delivery.js";

export type BbrObservationAuthority = "LIVE_OS" | "SYNTHETIC_TEST";

export interface BbrV3Observation {
  authority: BbrObservationAuthority;
  source: string;
  observedAt: string;
  observationAvailable: boolean;
  activeCongestionControl: string | null;
  availableCongestionControls: readonly string[];
  kernelRelease: string | null;
  versionMarker: "BBRv3" | null;
  versionMarkerSource: string | null;
}

export interface BbrV3Assessment {
  claim: "BBRv3";
  state: SpeculativeEvidenceState;
  active: boolean;
  reason: string;
  observation: BbrV3Observation | null;
  evidenceDigest: string;
}

function safeText(value: string, label: string, max = 512): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${label} contains control characters`);
  }
  return trimmed;
}

function normalizeObservedAt(value: string): string {
  const safe = safeText(value, "observedAt", 64);
  const timestamp = Date.parse(safe);
  if (!Number.isFinite(timestamp)) throw new Error("observedAt must be an ISO-compatible timestamp");
  return new Date(timestamp).toISOString();
}

function normalizeObservation(input: BbrV3Observation): BbrV3Observation {
  if (input.availableCongestionControls.length > 64) throw new Error("too many congestion-control names");
  const available = [...new Set(input.availableCongestionControls.map((value) => safeText(value.toLowerCase(), "congestion-control name", 64)))].sort();
  const active = input.activeCongestionControl === null ? null : safeText(input.activeCongestionControl.toLowerCase(), "active congestion control", 64);
  const kernelRelease = input.kernelRelease === null ? null : safeText(input.kernelRelease, "kernelRelease", 256);
  const versionMarkerSource = input.versionMarkerSource === null ? null : safeText(input.versionMarkerSource, "versionMarkerSource", 512);
  if (input.versionMarker !== null && versionMarkerSource === null) throw new Error("version marker requires versionMarkerSource");
  if (input.versionMarker === null && versionMarkerSource !== null) throw new Error("versionMarkerSource requires version marker");
  return Object.freeze({
    authority: input.authority,
    source: safeText(input.source, "source", 512),
    observedAt: normalizeObservedAt(input.observedAt),
    observationAvailable: input.observationAvailable === true,
    activeCongestionControl: active,
    availableCongestionControls: Object.freeze(available),
    kernelRelease,
    versionMarker: input.versionMarker,
    versionMarkerSource,
  });
}

export function assessBbrV3(observationInput: BbrV3Observation | null): BbrV3Assessment {
  if (observationInput === null) {
    const core = {
      claim: "BBRv3" as const,
      state: "NOT_VERIFIED" as const,
      active: false,
      reason: "no runtime BBR evidence supplied",
      observation: null,
    };
    return Object.freeze({ ...core, evidenceDigest: speculationDigest(core) });
  }

  const observation = normalizeObservation(observationInput);
  let state: SpeculativeEvidenceState;
  let active = false;
  let reason: string;

  if (!observation.observationAvailable) {
    state = "UNAVAILABLE";
    reason = "runtime congestion-control observation unavailable";
  } else if (observation.authority !== "LIVE_OS") {
    state = "NOT_VERIFIED";
    reason = "synthetic observation cannot verify live BBRv3";
  } else if (observation.versionMarker !== "BBRv3") {
    state = "NOT_VERIFIED";
    reason = observation.activeCongestionControl === "bbr"
      ? "generic BBR is active but the runtime evidence does not establish BBRv3"
      : "runtime evidence does not establish BBRv3";
  } else if (observation.activeCongestionControl === "bbr") {
    state = "OBSERVED";
    active = true;
    reason = "live OS evidence identifies BBRv3 and reports bbr as the active congestion control";
  } else if (observation.availableCongestionControls.includes("bbr")) {
    state = "SUPPORTED";
    reason = "live OS evidence identifies BBRv3 support but bbr is not active";
  } else {
    state = "NOT_VERIFIED";
    reason = "BBRv3 marker exists but runtime congestion-control availability is contradictory";
  }

  const core = { claim: "BBRv3" as const, state, active, reason, observation };
  return Object.freeze({ ...core, evidenceDigest: speculationDigest(core) });
}

export function validateBbrV3Assessment(assessment: BbrV3Assessment): void {
  const replay = assessBbrV3(assessment.observation);
  if (canonicalSpeculationJson(replay) !== canonicalSpeculationJson(assessment)) throw new Error("BBRv3 assessment replay mismatch");
}
