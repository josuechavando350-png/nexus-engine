import { describe, expect, it } from "vitest";
import {
  createInteractionPointerPrerenderer,
  parseInteractionPointerControl,
  type InteractionPointerControl,
  type InteractionPointerDecision,
  type InteractionPointerEnvironment,
} from "./index.js";

function control(mode: InteractionPointerControl["mode"] = "ACTIVE", maxPreparedTargets = 2): InteractionPointerControl {
  return { mode, allowedPaths: ["/explore", "/proof"], maxPreparedTargets };
}

function harness(options: { saveData?: boolean; reducedData?: boolean; reducedMotion?: boolean; speculation?: boolean } = {}) {
  const listeners = new Map<string, EventListener>();
  const applied: Array<{ action: string; target: string }> = [];
  let rollbacks = 0;
  const environment: InteractionPointerEnvironment = {
    locationHref: () => "https://probe.example/",
    saveData: () => options.saveData === true,
    reducedData: () => options.reducedData === true,
    reducedMotion: () => options.reducedMotion === true,
    speculationRulesSupported: () => options.speculation !== false,
    closestHref: (target) => typeof target === "string" ? target : null,
    addListener: (type, handler) => { listeners.set(type, handler); },
    removeListener: (type) => { listeners.delete(type); },
    apply: (action, target) => { applied.push({ action, target }); },
    rollbackOwned: () => { rollbacks += 1; },
  };
  const fire = async (type: string, target: string) => {
    listeners.get(type)?.({ target } as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { environment, applied, listeners, fire, rollbacks: () => rollbacks };
}

describe("CORTEX #8 interaction pointer prerenderer", () => {
  it("rejects non-exact or unsafe control contracts", () => {
    expect(() => parseInteractionPointerControl({ mode: "ACTIVE", allowedPaths: ["/explore"], maxPreparedTargets: 2, extra: true })).toThrow(/unknown or missing/i);
    expect(() => parseInteractionPointerControl({ mode: "ACTIVE", allowedPaths: ["https://evil.example/"], maxPreparedTargets: 2 })).toThrow(/absolute path/i);
    expect(() => parseInteractionPointerControl({ mode: "ACTIVE", allowedPaths: ["/explore", "/explore"], maxPreparedTargets: 2 })).toThrow(/unique/i);
  });

  it("uses real pointer input, rechecks control at the final boundary, and applies one owned action", async () => {
    const h = harness();
    let reads = 0;
    const decisions: InteractionPointerDecision[] = [];
    const runtime = createInteractionPointerPrerenderer({
      environment: h.environment,
      controlProvider: async () => { reads += 1; return control(); },
      onDecision: (decision) => { decisions.push(decision); },
    });
    runtime.start();
    await h.fire("pointerover", "https://probe.example/explore");
    expect(reads).toBe(2);
    expect(h.applied).toEqual([{ action: "PRERENDER", target: "https://probe.example/explore" }]);
    expect(runtime.preparedTargets()).toEqual(["https://probe.example/explore"]);
    expect(decisions.at(-1)).toMatchObject({ reason: "SELECTED", action: "PRERENDER" });
    runtime.stop();
    expect(h.listeners.size).toBe(0);
  });

  it("blocks an in-flight side effect when kill changes after planning and rolls back owned hints", async () => {
    const h = harness();
    const states = [control("ACTIVE"), control("KILLED")];
    const decisions: InteractionPointerDecision[] = [];
    const runtime = createInteractionPointerPrerenderer({
      environment: h.environment,
      controlProvider: async () => states.shift() ?? control("KILLED"),
      onDecision: (decision) => { decisions.push(decision); },
    });
    runtime.start();
    await h.fire("pointerdown", "https://probe.example/proof");
    expect(h.applied).toEqual([]);
    expect(h.rollbacks()).toBe(1);
    expect(decisions.at(-1)?.reason).toBe("KILL_SWITCH");
  });

  it("keeps observe-only free of speculative side effects and falls back to prefetch when rules are unsupported", async () => {
    const observe = harness();
    const observed: InteractionPointerDecision[] = [];
    const observeRuntime = createInteractionPointerPrerenderer({
      environment: observe.environment,
      controlProvider: async () => control("OBSERVE_ONLY"),
      onDecision: (decision) => { observed.push(decision); },
    });
    observeRuntime.start();
    await observe.fire("focusin", "https://probe.example/explore");
    expect(observe.applied).toEqual([]);
    expect(observed.at(-1)).toMatchObject({ reason: "OBSERVE_ONLY", action: "PRERENDER" });

    const fallback = harness({ speculation: false });
    const fallbackRuntime = createInteractionPointerPrerenderer({ environment: fallback.environment, controlProvider: async () => control() });
    fallbackRuntime.start();
    await fallback.fire("touchstart", "https://probe.example/proof");
    expect(fallback.applied[0]?.action).toBe("PREFETCH");
  });

  it("fails closed for cross-origin, query-bearing, reduced-data, and unavailable-control requests", async () => {
    const h = harness({ saveData: true });
    const decisions: InteractionPointerDecision[] = [];
    const runtime = createInteractionPointerPrerenderer({
      environment: h.environment,
      controlProvider: async () => control(),
      onDecision: (decision) => { decisions.push(decision); },
    });
    runtime.start();
    await h.fire("pointerover", "https://other.example/explore");
    await h.fire("pointerover", "https://probe.example/explore?q=raw");
    await h.fire("pointerover", "https://probe.example/explore");
    expect(h.applied).toEqual([]);
    expect(decisions.map((decision) => decision.reason)).toEqual(["CROSS_ORIGIN", "QUERY_NOT_ALLOWED", "REDUCED_DATA"]);

    const unavailable = harness();
    const unavailableDecisions: InteractionPointerDecision[] = [];
    const unavailableRuntime = createInteractionPointerPrerenderer({
      environment: unavailable.environment,
      controlProvider: async () => { throw new Error("offline"); },
      onDecision: (decision) => { unavailableDecisions.push(decision); },
    });
    unavailableRuntime.start();
    await unavailable.fire("pointerover", "https://probe.example/explore");
    expect(unavailable.applied).toEqual([]);
    expect(unavailableDecisions.at(-1)?.reason).toBe("CONTROL_UNAVAILABLE");
  });

  it("enforces the preparation budget under concurrent pointer signals and supports operational rollback", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const runtime = createInteractionPointerPrerenderer({
      environment: h.environment,
      controlProvider: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return control("ACTIVE", 1);
      },
    });
    runtime.start();
    h.listeners.get("pointerover")?.({ target: "https://probe.example/explore" } as unknown as Event);
    await Promise.resolve();
    await h.fire("pointerdown", "https://probe.example/proof");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.applied).toHaveLength(1);
    runtime.rollback();
    expect(h.rollbacks()).toBe(1);
    expect(runtime.preparedTargets()).toEqual([]);
  });
});
