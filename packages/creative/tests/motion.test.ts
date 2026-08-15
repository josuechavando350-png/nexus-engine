import { describe, expect, it } from "vitest";
import { DeterministicMotionRuntime, MotionError, validateTimeline, type MotionTimeline } from "../motion";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const timeline: MotionTimeline = Object.freeze({
  timelineId: "timeline-1", scope,
  tracks: Object.freeze([
    Object.freeze({ trackId: "opacity", property: "opacity", durationMs: 1000, delayMs: 0, easing: "linear", keyframes: Object.freeze([Object.freeze({ at: 0, value: 0 }), Object.freeze({ at: 1, value: 1 })]) }),
    Object.freeze({ trackId: "translate", property: "translateX", durationMs: 500, delayMs: 250, easing: "ease-in-out", keyframes: Object.freeze([Object.freeze({ at: 0, value: 0 }), Object.freeze({ at: 0.5, value: 40 }), Object.freeze({ at: 1, value: 100 })]) })
  ])
});

describe("DeterministicMotionRuntime", () => {
  it("samples the same timeline deterministically", () => {
    const runtime = new DeterministicMotionRuntime(timeline);
    expect(runtime.sample(500, scope)).toEqual(runtime.sample(500, scope));
  });

  it("canonicalizes track order independent of input ordering", () => {
    const reversed = { ...timeline, tracks: [...timeline.tracks].reverse() };
    expect(new DeterministicMotionRuntime(reversed).sample(500, scope)).toEqual(new DeterministicMotionRuntime(timeline).sample(500, scope));
  });

  it("interpolates linear motion and clamps before/after duration", () => {
    const runtime = new DeterministicMotionRuntime(timeline);
    expect(runtime.sample(500, scope).samples.find((sample) => sample.trackId === "opacity")?.value).toBe(0.5);
    expect(runtime.sample(0, scope).samples.find((sample) => sample.trackId === "translate")?.value).toBe(0);
    expect(runtime.sample(2000, scope).samples.every((sample) => sample.complete)).toBe(true);
  });

  it("rejects cross-scope sampling", () => {
    const runtime = new DeterministicMotionRuntime(timeline);
    expect(() => runtime.sample(100, { tenantId: "tenant-b", brandId: "brand-a" })).toThrowError(MotionError);
    expect(() => runtime.sample(100, { tenantId: "tenant-a", brandId: "brand-b" })).toThrowError(MotionError);
  });

  it("rejects NaN, Infinity, negative time, and invalid durations", () => {
    const runtime = new DeterministicMotionRuntime(timeline);
    expect(() => runtime.sample(Number.NaN, scope)).toThrowError(MotionError);
    expect(() => runtime.sample(Number.POSITIVE_INFINITY, scope)).toThrowError(MotionError);
    expect(() => runtime.sample(-1, scope)).toThrowError(MotionError);
    expect(() => validateTimeline({ ...timeline, tracks: [{ ...timeline.tracks[0]!, durationMs: 0 }] })).toThrowError(MotionError);
  });

  it("rejects malformed keyframes and duplicate track IDs", () => {
    expect(() => validateTimeline({ ...timeline, tracks: [{ ...timeline.tracks[0]!, keyframes: [{ at: 0, value: 0 }, { at: 0, value: 1 }] }] })).toThrowError(MotionError);
    expect(() => validateTimeline({ ...timeline, tracks: [timeline.tracks[0]!, { ...timeline.tracks[0]! }] })).toThrowError(MotionError);
  });

  it("contains no browser or vendor dependency in its public contract", () => {
    const runtime = new DeterministicMotionRuntime(timeline);
    const frame = runtime.sample(250, scope);
    expect(Object.keys(frame).sort()).toEqual(["atMs", "samples", "timelineId"]);
  });
});
