import { assertCanonicalId, assertScope, lexicalCompare, type CreativeScope } from "../shared";

export type MotionEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";
export type MotionErrorCode = "INVALID_INPUT" | "SCOPE_MISMATCH" | "TRACK_NOT_FOUND";

export class MotionError extends Error {
  constructor(readonly code: MotionErrorCode, message: string) {
    super(message);
    this.name = "MotionError";
  }
}

export type MotionKeyframe = Readonly<{ at: number; value: number }>;
export type MotionTrack = Readonly<{
  trackId: string;
  property: string;
  durationMs: number;
  delayMs: number;
  easing: MotionEasing;
  keyframes: readonly MotionKeyframe[];
}>;
export type MotionTimeline = Readonly<{
  timelineId: string;
  scope: CreativeScope;
  tracks: readonly MotionTrack[];
}>;
export type MotionSample = Readonly<{ trackId: string; property: string; value: number; progress: number; complete: boolean }>;
export type MotionFrame = Readonly<{ timelineId: string; atMs: number; samples: readonly MotionSample[] }>;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new MotionError("INVALID_INPUT", `${field} must be finite`);
}
function ease(value: number, easing: MotionEasing): number {
  const t = clamp(value);
  if (easing === "ease-in") return t * t;
  if (easing === "ease-out") return 1 - (1 - t) * (1 - t);
  if (easing === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

export function validateTimeline(timeline: MotionTimeline): MotionTimeline {
  try {
    assertCanonicalId(timeline.timelineId, "timeline.timelineId");
    assertScope(timeline.scope);
  } catch (error) {
    throw new MotionError("INVALID_INPUT", error instanceof Error ? error.message : "invalid timeline");
  }
  if (!Array.isArray(timeline.tracks) || !timeline.tracks.length) throw new MotionError("INVALID_INPUT", "timeline requires tracks");
  const ids = new Set<string>();
  for (const track of timeline.tracks) {
    try { assertCanonicalId(track.trackId, "track.trackId"); } catch (error) { throw new MotionError("INVALID_INPUT", error instanceof Error ? error.message : "invalid track"); }
    if (ids.has(track.trackId)) throw new MotionError("INVALID_INPUT", "track IDs must be unique");
    ids.add(track.trackId);
    if (typeof track.property !== "string" || !track.property.trim()) throw new MotionError("INVALID_INPUT", "track property is required");
    finite(track.durationMs, "track.durationMs"); finite(track.delayMs, "track.delayMs");
    if (track.durationMs <= 0 || track.delayMs < 0) throw new MotionError("INVALID_INPUT", "duration must be positive and delay non-negative");
    if (!Array.isArray(track.keyframes) || track.keyframes.length < 2) throw new MotionError("INVALID_INPUT", "track requires at least two keyframes");
    let previous = -1;
    for (const frame of track.keyframes) {
      finite(frame.at, "keyframe.at"); finite(frame.value, "keyframe.value");
      if (frame.at < 0 || frame.at > 1 || frame.at <= previous) throw new MotionError("INVALID_INPUT", "keyframe positions must be unique, increasing, and in [0,1]");
      previous = frame.at;
    }
    if (track.keyframes[0]?.at !== 0 || track.keyframes.at(-1)?.at !== 1) throw new MotionError("INVALID_INPUT", "keyframes must cover 0 through 1");
  }
  return Object.freeze({ ...timeline, scope: Object.freeze({ ...timeline.scope }), tracks: Object.freeze([...timeline.tracks].sort((a, b) => lexicalCompare(a.trackId, b.trackId))) });
}

function interpolate(track: MotionTrack, progress: number): number {
  const p = ease(progress, track.easing);
  let left = track.keyframes[0]!;
  for (let index = 1; index < track.keyframes.length; index += 1) {
    const right = track.keyframes[index]!;
    if (p <= right.at) {
      const local = (p - left.at) / (right.at - left.at);
      return left.value + (right.value - left.value) * local;
    }
    left = right;
  }
  return track.keyframes.at(-1)!.value;
}

export class DeterministicMotionRuntime {
  private readonly timeline: MotionTimeline;
  constructor(timeline: MotionTimeline) { this.timeline = validateTimeline(timeline); }

  sample(atMs: number, scope: CreativeScope): MotionFrame {
    finite(atMs, "atMs");
    if (atMs < 0) throw new MotionError("INVALID_INPUT", "atMs must be non-negative");
    if (scope.tenantId !== this.timeline.scope.tenantId || scope.brandId !== this.timeline.scope.brandId) throw new MotionError("SCOPE_MISMATCH", "motion timeline scope mismatch");
    const samples = this.timeline.tracks.map((track): MotionSample => {
      const raw = clamp((atMs - track.delayMs) / track.durationMs);
      return Object.freeze({ trackId: track.trackId, property: track.property, value: interpolate(track, raw), progress: raw, complete: raw === 1 });
    });
    return Object.freeze({ timelineId: this.timeline.timelineId, atMs, samples: Object.freeze(samples) });
  }
}
