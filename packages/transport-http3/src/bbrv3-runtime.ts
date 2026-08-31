import { closeSync, openSync, readSync } from "node:fs";
import { release } from "node:os";
import { assessBbrV3, validateBbrV3Assessment, type BbrV3Assessment, type BbrV3Observation } from "./bbrv3.js";

export type { BbrV3Assessment, BbrV3Observation } from "./bbrv3.js";
export { validateBbrV3Assessment } from "./bbrv3.js";

const MAX_PROC_BYTES = 4_096;
const ACTIVE_PATH = "/proc/sys/net/ipv4/tcp_congestion_control";
const AVAILABLE_PATH = "/proc/sys/net/ipv4/tcp_available_congestion_control";

function readBoundedText(path: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_PROC_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_PROC_BYTES) throw new Error(`runtime evidence at ${path} exceeds ${MAX_PROC_BYTES} bytes`);
    const value = buffer.subarray(0, bytes).toString("utf8").trim();
    if (!value) return null;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code === 0 || code === 0x7f) throw new Error(`runtime evidence at ${path} contains invalid control data`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && /exceeds|control data/.test(error.message)) throw error;
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function collectLiveBbrV3Observation(now: () => Date = () => new Date()): BbrV3Observation {
  const observedAt = now().toISOString();
  const kernelRelease = release();
  if (process.platform !== "linux") {
    return Object.freeze({
      authority: "LIVE_OS",
      source: `node-os:${process.platform}`,
      observedAt,
      observationAvailable: false,
      activeCongestionControl: null,
      availableCongestionControls: Object.freeze([]),
      kernelRelease,
      versionMarker: null,
      versionMarkerSource: null,
    });
  }

  const active = readBoundedText(ACTIVE_PATH);
  const availableRaw = readBoundedText(AVAILABLE_PATH);
  const available = availableRaw === null
    ? []
    : availableRaw.split(/\s+/u).map((value) => value.trim().toLowerCase()).filter(Boolean);

  return Object.freeze({
    authority: "LIVE_OS",
    source: `linux-procfs:${ACTIVE_PATH},${AVAILABLE_PATH}`,
    observedAt,
    observationAvailable: active !== null && availableRaw !== null,
    activeCongestionControl: active?.toLowerCase() ?? null,
    availableCongestionControls: Object.freeze(available),
    kernelRelease,
    // Procfs exposes an algorithm label such as "bbr" but no authoritative BBR generation.
    // This collector therefore cannot manufacture a BBRv3 version marker.
    versionMarker: null,
    versionMarkerSource: null,
  });
}

export function assessLiveBbrV3(now: () => Date = () => new Date()): BbrV3Assessment {
  const assessment = assessBbrV3(collectLiveBbrV3Observation(now));
  validateBbrV3Assessment(assessment);
  return assessment;
}
