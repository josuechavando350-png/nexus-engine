import { digestValue } from "@nexus/visual-algebra";
import type { SemanticEffect, SemanticState, SemanticValue } from "./types.js";

export class SemanticStateError extends Error {
  constructor(
    public readonly code: "INVALID_STATE" | "MISSING_METRIC" | "INVALID_EFFECT",
    message: string,
  ) {
    super(message);
    this.name = "SemanticStateError";
  }
}

function assertName(name: string, label: string): void {
  if (typeof name !== "string" || !name.trim()) throw new SemanticStateError("INVALID_STATE", `${label} must be a non-empty string`);
}

function assertSemanticValue(value: SemanticValue, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw new SemanticStateError("INVALID_STATE", `${label} must be a scalar semantic value`);
}

function sortedRecord<T>(input: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.freeze(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
}

export function createSemanticState(input: {
  readonly facts?: Readonly<Record<string, SemanticValue>>;
  readonly metrics?: Readonly<Record<string, number>>;
} = {}): SemanticState {
  const facts: Record<string, SemanticValue> = {};
  for (const [name, value] of Object.entries(input.facts ?? {})) {
    assertName(name, "fact name");
    assertSemanticValue(value, `fact ${name}`);
    facts[name] = value;
  }
  const metrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(input.metrics ?? {})) {
    assertName(name, "metric name");
    if (!Number.isFinite(value)) throw new SemanticStateError("INVALID_STATE", `metric ${name} must be finite`);
    metrics[name] = value;
  }
  const base = {
    authority: "NEXUS_SEMANTIC_STATE_V1" as const,
    facts: sortedRecord(facts),
    metrics: sortedRecord(metrics),
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}

export function validateSemanticState(state: SemanticState): void {
  if (state.authority !== "NEXUS_SEMANTIC_STATE_V1") throw new SemanticStateError("INVALID_STATE", "Unsupported semantic-state authority");
  const rebuilt = createSemanticState({ facts: state.facts, metrics: state.metrics });
  if (rebuilt.digest !== state.digest) throw new SemanticStateError("INVALID_STATE", "Semantic state digest mismatch");
}

export function applySemanticEffects(state: SemanticState, effects: readonly SemanticEffect[]): SemanticState {
  validateSemanticState(state);
  const facts: Record<string, SemanticValue> = { ...state.facts };
  const metrics: Record<string, number> = { ...state.metrics };

  for (const effect of effects) {
    assertName(effect.name, "effect name");
    switch (effect.kind) {
      case "set_fact":
        assertSemanticValue(effect.value, `effect ${effect.name}`);
        facts[effect.name] = effect.value;
        break;
      case "delete_fact":
        delete facts[effect.name];
        break;
      case "set_metric":
        if (!Number.isFinite(effect.value)) throw new SemanticStateError("INVALID_EFFECT", `metric effect ${effect.name} must be finite`);
        metrics[effect.name] = effect.value;
        break;
      case "add_metric":
      case "min_metric":
      case "max_metric": {
        if (!Number.isFinite(effect.value)) throw new SemanticStateError("INVALID_EFFECT", `metric effect ${effect.name} must be finite`);
        const current = metrics[effect.name];
        if (current === undefined) throw new SemanticStateError("MISSING_METRIC", `metric ${effect.name} does not exist`);
        const next =
          effect.kind === "add_metric" ? current + effect.value :
          effect.kind === "min_metric" ? Math.min(current, effect.value) :
          Math.max(current, effect.value);
        if (!Number.isFinite(next)) throw new SemanticStateError("INVALID_EFFECT", `metric effect ${effect.name} produced a non-finite value`);
        metrics[effect.name] = next;
        break;
      }
      default: {
        const exhaustive: never = effect;
        throw new SemanticStateError("INVALID_EFFECT", `Unsupported semantic effect: ${String(exhaustive)}`);
      }
    }
  }
  return createSemanticState({ facts, metrics });
}

export function mergeSemanticStates(states: readonly SemanticState[]): SemanticState {
  const facts: Record<string, SemanticValue> = {};
  const metrics: Record<string, number> = {};
  for (const state of states) {
    validateSemanticState(state);
    for (const [name, value] of Object.entries(state.facts)) {
      if (Object.prototype.hasOwnProperty.call(facts, name) && facts[name] !== value) {
        throw new SemanticStateError("INVALID_STATE", `Conflicting fact ${name}`);
      }
      facts[name] = value;
    }
    for (const [name, value] of Object.entries(state.metrics)) {
      if (Object.prototype.hasOwnProperty.call(metrics, name) && metrics[name] !== value) {
        throw new SemanticStateError("INVALID_STATE", `Conflicting metric ${name}`);
      }
      metrics[name] = value;
    }
  }
  return createSemanticState({ facts, metrics });
}
