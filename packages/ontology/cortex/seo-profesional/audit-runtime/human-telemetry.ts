import type { SeoAuditTypingAction, SeoAuditTypingProfile } from "./contracts.js";

export const DEFAULT_SEO_AUDIT_TYPING_PROFILE: SeoAuditTypingProfile = Object.freeze({
  minKeyDelayMs: 40,
  maxKeyDelayMs: 190,
  correctionRate: 0.02,
  pauseEveryChars: 24,
  minPauseMs: 180,
  maxPauseMs: 500,
});

export class SeoAuditTelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoAuditTelemetryError";
  }
}

function seeded(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new SeoAuditTelemetryError("telemetry seed must be a safe integer");
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function integer(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function normalizeTypingProfile(input: Partial<SeoAuditTypingProfile> | undefined): SeoAuditTypingProfile {
  const profile: SeoAuditTypingProfile = Object.freeze({ ...DEFAULT_SEO_AUDIT_TYPING_PROFILE, ...(input ?? {}) });
  if (!Number.isSafeInteger(profile.minKeyDelayMs) || !Number.isSafeInteger(profile.maxKeyDelayMs) ||
    profile.minKeyDelayMs < 0 || profile.maxKeyDelayMs > 2_000 || profile.minKeyDelayMs > profile.maxKeyDelayMs ||
    typeof profile.correctionRate !== "number" || !Number.isFinite(profile.correctionRate) || profile.correctionRate < 0 || profile.correctionRate > 0.1 ||
    !Number.isSafeInteger(profile.pauseEveryChars) || profile.pauseEveryChars < 1 || profile.pauseEveryChars > 200 ||
    !Number.isSafeInteger(profile.minPauseMs) || !Number.isSafeInteger(profile.maxPauseMs) ||
    profile.minPauseMs < 0 || profile.maxPauseMs > 5_000 || profile.minPauseMs > profile.maxPauseMs) {
    throw new SeoAuditTelemetryError("typing profile is outside the bounded UX telemetry ranges");
  }
  return profile;
}

export function buildFatigueTypingPlan(text: string, seed: number, profileInput?: Partial<SeoAuditTypingProfile>): readonly SeoAuditTypingAction[] {
  if (typeof text !== "string" || text.length === 0 || text.length > 2_000) {
    throw new SeoAuditTelemetryError("UX telemetry text must contain between 1 and 2000 characters");
  }
  const profile = normalizeTypingProfile(profileInput);
  const random = seeded(seed);
  const actions: SeoAuditTypingAction[] = [];
  const alphabet = "abcdefghijklmnopqrstuvwxyz";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/^[A-Za-z]$/u.test(char) && random() < profile.correctionRate) {
      const typo = alphabet[integer(random, 0, alphabet.length - 1)]!;
      actions.push(Object.freeze({ type: "TYPE", value: typo }));
      actions.push(Object.freeze({ type: "WAIT", ms: integer(random, 120, 320) }));
      actions.push(Object.freeze({ type: "BACKSPACE" }));
      actions.push(Object.freeze({ type: "WAIT", ms: integer(random, 80, 220) }));
    }
    actions.push(Object.freeze({ type: "TYPE", value: char }));
    actions.push(Object.freeze({ type: "WAIT", ms: integer(random, profile.minKeyDelayMs, profile.maxKeyDelayMs) }));
    if ((index + 1) % profile.pauseEveryChars === 0 && index + 1 < text.length) {
      actions.push(Object.freeze({ type: "WAIT", ms: integer(random, profile.minPauseMs, profile.maxPauseMs) }));
    }
  }

  return Object.freeze(actions);
}

export interface SeoAuditPointerPoint {
  readonly x: number;
  readonly y: number;
}

export function buildBezierPointerPath(
  start: SeoAuditPointerPoint,
  end: SeoAuditPointerPoint,
  steps: number,
  seed: number,
): readonly SeoAuditPointerPoint[] {
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y) ||
    !Number.isSafeInteger(steps) || steps < 2 || steps > 120) {
    throw new SeoAuditTelemetryError("pointer trajectory input is invalid");
  }
  const random = seeded(seed);
  const controlX = start.x + (end.x - start.x) * (0.1 + random() * 0.8) + integer(random, -40, 40);
  const controlY = start.y + (end.y - start.y) * (0.1 + random() * 0.8) + integer(random, -40, 40);
  const points: SeoAuditPointerPoint[] = [];
  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1);
    const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * controlX + t ** 2 * end.x;
    const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * controlY + t ** 2 * end.y;
    points.push(Object.freeze({ x: Math.round(x), y: Math.round(y) }));
  }
  return Object.freeze(points);
}
