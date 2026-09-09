import {
  EdgeResilienceError,
  type EdgeCircuitDecision,
  type EdgeCircuitFailurePolicy,
  type EdgeCircuitState,
  type EdgeCircuitStatePort,
} from "./contracts.js";

function assertKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 256) throw new EdgeResilienceError("INVALID_INPUT", "circuit key is malformed");
  return normalized;
}

function assertNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new EdgeResilienceError("INVALID_INPUT", "circuit clock is invalid");
  return value;
}

function closed(nowMs: number, consecutiveFailures = 0): EdgeCircuitState {
  return Object.freeze({ phase: "CLOSED" as const, consecutiveFailures, openedAt: null, retryAt: null, probeUntil: null, updatedAt: nowMs });
}

function open(nowMs: number, retryAt: number, consecutiveFailures: number): EdgeCircuitState {
  return Object.freeze({ phase: "OPEN" as const, consecutiveFailures, openedAt: nowMs, retryAt, probeUntil: null, updatedAt: nowMs });
}

function halfOpen(nowMs: number, probeUntil: number, failures: number): EdgeCircuitState {
  return Object.freeze({ phase: "HALF_OPEN" as const, consecutiveFailures: failures, openedAt: null, retryAt: null, probeUntil, updatedAt: nowMs });
}

/**
 * Per-isolate/test implementation only. Distributed production deployments should
 * inject an EdgeCircuitStatePort whose three operations are atomic for each key.
 */
export class InMemoryEdgeCircuitStateStore implements EdgeCircuitStatePort {
  private readonly states = new Map<string, EdgeCircuitState>();

  async beforeRequest(keyInput: string, nowInput: number, halfOpenProbeLeaseMs: number): Promise<EdgeCircuitDecision> {
    const key = assertKey(keyInput);
    const nowMs = assertNow(nowInput);
    if (!Number.isSafeInteger(halfOpenProbeLeaseMs) || halfOpenProbeLeaseMs < 1) {
      throw new EdgeResilienceError("INVALID_CONFIG", "half-open probe lease must be positive");
    }
    const current = this.states.get(key) ?? closed(nowMs);
    if (current.phase === "CLOSED") {
      this.states.set(key, current);
      return Object.freeze({ allowed: true, state: current });
    }
    if (current.phase === "OPEN") {
      if (current.retryAt === null || nowMs < current.retryAt) return Object.freeze({ allowed: false, state: current });
      const next = halfOpen(nowMs, nowMs + halfOpenProbeLeaseMs, current.consecutiveFailures);
      this.states.set(key, next);
      return Object.freeze({ allowed: true, state: next });
    }
    if (current.probeUntil !== null && nowMs < current.probeUntil) return Object.freeze({ allowed: false, state: current });
    const next = halfOpen(nowMs, nowMs + halfOpenProbeLeaseMs, current.consecutiveFailures);
    this.states.set(key, next);
    return Object.freeze({ allowed: true, state: next });
  }

  async recordSuccess(keyInput: string, nowInput: number): Promise<EdgeCircuitState> {
    const key = assertKey(keyInput);
    const nowMs = assertNow(nowInput);
    const next = closed(nowMs, 0);
    this.states.set(key, next);
    return next;
  }

  async recordFailure(keyInput: string, nowInput: number, policy: EdgeCircuitFailurePolicy): Promise<EdgeCircuitState> {
    const key = assertKey(keyInput);
    const nowMs = assertNow(nowInput);
    if (!Number.isSafeInteger(policy.failureThreshold) || policy.failureThreshold < 1 || !Number.isSafeInteger(policy.openCircuitMs) || policy.openCircuitMs < 1) {
      throw new EdgeResilienceError("INVALID_CONFIG", "circuit failure policy is invalid");
    }
    const current = this.states.get(key) ?? closed(nowMs);
    if (current.phase === "HALF_OPEN") {
      const next = open(nowMs, nowMs + policy.openCircuitMs, Math.max(policy.failureThreshold, current.consecutiveFailures + 1));
      this.states.set(key, next);
      return next;
    }
    if (current.phase === "OPEN") {
      const next = open(nowMs, Math.max(current.retryAt ?? 0, nowMs + policy.openCircuitMs), Math.max(policy.failureThreshold, current.consecutiveFailures + 1));
      this.states.set(key, next);
      return next;
    }
    const failures = current.consecutiveFailures + 1;
    const next = failures >= policy.failureThreshold ? open(nowMs, nowMs + policy.openCircuitMs, failures) : closed(nowMs, failures);
    this.states.set(key, next);
    return next;
  }
}
