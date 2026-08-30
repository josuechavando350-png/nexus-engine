import { canonicalJson } from "./index.js";
import type { ObjectRecord, PropertyValue } from "./transaction.js";
import { canonicalUtc, hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import {
  BANDIT_DECISION_TYPE,
  BANDIT_STATE_TYPE,
  BDP,
  BSP,
  ContextualBanditError,
  type BanditContext,
  type BanditDecisionRecord,
  type BanditDecisionStatus,
  type BanditStateRecord,
  type ContextualBanditPolicy,
} from "./chatbot-bandit-types.js";

function stringProperty(record: ObjectRecord, id: string): string {
  const value = record.properties[id];
  if (typeof value !== "string" || !value.trim()) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid string`);
  return value;
}

function numberProperty(record: ObjectRecord, id: string): number {
  const value = record.properties[id];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid number`);
  return value;
}

function optionalNumberProperty(record: ObjectRecord, id: string): number | undefined {
  const value = record.properties[id];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid number`);
  return value;
}

function optionalStringProperty(record: ObjectRecord, id: string): string | undefined {
  const value = record.properties[id];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id}.${id} is not a valid string`);
  return value;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new ContextualBanditError("INTEGRITY_FAILURE", `${name} must be a non-negative integer`);
}

function assertReward(value: number, code: "INVALID_INPUT" | "INTEGRITY_FAILURE"): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new ContextualBanditError(code, "reward must be a finite number from 0 to 1");
}

export function normalizeBanditContext(context: BanditContext, policy: ContextualBanditPolicy): { contextKey: string; contextDigest: string } {
  const entries = Object.entries(context);
  if (entries.length === 0) throw new ContextualBanditError("INVALID_INPUT", "bandit context must not be empty");
  if (entries.length > policy.maxContextFeatures) throw new ContextualBanditError("POLICY_VIOLATION", "bandit context exceeds configured feature limit");
  const allowed = new Set(policy.allowedContextKeys);
  const normalized: Record<string, string | number | boolean> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeIdentifier(rawKey, "context feature key");
    if (!allowed.has(key)) throw new ContextualBanditError("POLICY_VIOLATION", `context feature ${key} is not allowed by policy`);
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue) || Math.abs(rawValue) > 1_000_000) throw new ContextualBanditError("INVALID_INPUT", `numeric context feature ${key} is invalid`);
      normalized[key] = rawValue;
    } else if (typeof rawValue === "boolean") {
      normalized[key] = rawValue;
    } else if (typeof rawValue === "string") {
      const value = rawValue.trim().toLowerCase();
      if (!value || value.length > 128) throw new ContextualBanditError("INVALID_INPUT", `string context feature ${key} is invalid`);
      normalized[key] = value;
    } else {
      throw new ContextualBanditError("INVALID_INPUT", `context feature ${key} has unsupported value type`);
    }
  }
  const ordered = Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
  const contextDigest = hash("cbcontext", ordered);
  return { contextKey: hash("cbucket", ordered), contextDigest };
}

export function banditStateId(banditId: string, armId: string, contextKey: string): string {
  return hash("cbstate", {
    banditId: normalizeIdentifier(banditId, "banditId"),
    armId: normalizeIdentifier(armId, "armId"),
    contextKey: normalizeIdentifier(contextKey, "contextKey"),
  });
}

export function banditDecisionId(banditId: string, interactionId: string): string {
  return hash("cbdecision", {
    banditId: normalizeIdentifier(banditId, "banditId"),
    interactionId: normalizeIdentifier(interactionId, "interactionId"),
  });
}

export function statePayload(input: {
  banditId: string;
  armId: string;
  contextKey: string;
  pulls: number;
  rewardSum: number;
  rewardSquareSum: number;
  createdAt: string;
  updatedAt: string;
}): Readonly<Record<string, PropertyValue>> {
  assertNonNegativeInteger(input.pulls, "pulls");
  if (!Number.isFinite(input.rewardSum) || input.rewardSum < 0 || input.rewardSum > input.pulls) throw new ContextualBanditError("INVALID_INPUT", "rewardSum is inconsistent with pulls");
  if (!Number.isFinite(input.rewardSquareSum) || input.rewardSquareSum < 0 || input.rewardSquareSum > input.pulls) throw new ContextualBanditError("INVALID_INPUT", "rewardSquareSum is inconsistent with pulls");
  const banditId = normalizeIdentifier(input.banditId, "banditId");
  const armId = normalizeIdentifier(input.armId, "armId");
  const contextKey = normalizeIdentifier(input.contextKey, "contextKey");
  const createdAt = canonicalUtc(input.createdAt);
  const updatedAt = canonicalUtc(input.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new ContextualBanditError("INVALID_INPUT", "updatedAt cannot precede createdAt");
  const core = { banditId, armId, contextKey, pulls: input.pulls, rewardSum: input.rewardSum, rewardSquareSum: input.rewardSquareSum, createdAt, updatedAt };
  return {
    [BSP.banditId]: banditId,
    [BSP.armId]: armId,
    [BSP.contextKey]: contextKey,
    [BSP.pulls]: input.pulls,
    [BSP.rewardSum]: input.rewardSum,
    [BSP.rewardSquareSum]: input.rewardSquareSum,
    [BSP.createdAt]: createdAt,
    [BSP.updatedAt]: updatedAt,
    [BSP.recordDigest]: hash("cbstaterecord", core),
  };
}

export function decisionPayload(input: {
  banditId: string;
  interactionId: string;
  armId: string;
  contextKey: string;
  contextDigest: string;
  policyDigest: string;
  guardrailContextDigest: string;
  issuedAt: string;
  status: BanditDecisionStatus;
  reward?: number;
  outcomeAt?: string;
}): Readonly<Record<string, PropertyValue>> {
  const banditId = normalizeIdentifier(input.banditId, "banditId");
  const interactionId = normalizeIdentifier(input.interactionId, "interactionId");
  const armId = normalizeIdentifier(input.armId, "armId");
  const contextKey = normalizeIdentifier(input.contextKey, "contextKey");
  const issuedAt = canonicalUtc(input.issuedAt);
  const contextDigest = normalizeIdentifier(input.contextDigest, "contextDigest");
  const policyDigest = normalizeIdentifier(input.policyDigest, "policyDigest");
  const guardrailContextDigest = normalizeIdentifier(input.guardrailContextDigest, "guardrailContextDigest");
  let reward: number | undefined;
  let outcomeAt: string | undefined;
  if (input.status === "REWARDED") {
    if (input.reward === undefined || input.outcomeAt === undefined) throw new ContextualBanditError("INVALID_INPUT", "rewarded decision requires reward and outcomeAt");
    assertReward(input.reward, "INVALID_INPUT");
    reward = input.reward;
    outcomeAt = canonicalUtc(input.outcomeAt);
    if (Date.parse(outcomeAt) < Date.parse(issuedAt)) throw new ContextualBanditError("INVALID_INPUT", "outcomeAt cannot precede issuedAt");
  } else if (input.reward !== undefined || input.outcomeAt !== undefined) {
    throw new ContextualBanditError("INVALID_INPUT", "pending decision cannot carry outcome data");
  }
  const core = { banditId, interactionId, armId, contextKey, contextDigest, policyDigest, guardrailContextDigest, issuedAt, status: input.status, ...(reward === undefined ? {} : { reward }), ...(outcomeAt === undefined ? {} : { outcomeAt }) };
  return {
    [BDP.banditId]: banditId,
    [BDP.interactionId]: interactionId,
    [BDP.armId]: armId,
    [BDP.contextKey]: contextKey,
    [BDP.contextDigest]: contextDigest,
    [BDP.policyDigest]: policyDigest,
    [BDP.guardrailContextDigest]: guardrailContextDigest,
    [BDP.issuedAt]: issuedAt,
    [BDP.status]: input.status,
    [BDP.reward]: reward ?? null,
    [BDP.outcomeAt]: outcomeAt ?? null,
    [BDP.recordDigest]: hash("cbdecisionrecord", core),
  };
}

export function projectBanditState(record: ObjectRecord): BanditStateRecord {
  if (record.typeId !== BANDIT_STATE_TYPE) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id} is not a contextual bandit state record`);
  const core = {
    banditId: stringProperty(record, BSP.banditId),
    armId: stringProperty(record, BSP.armId),
    contextKey: stringProperty(record, BSP.contextKey),
    pulls: numberProperty(record, BSP.pulls),
    rewardSum: numberProperty(record, BSP.rewardSum),
    rewardSquareSum: numberProperty(record, BSP.rewardSquareSum),
    createdAt: stringProperty(record, BSP.createdAt),
    updatedAt: stringProperty(record, BSP.updatedAt),
  };
  assertNonNegativeInteger(core.pulls, "stored pulls");
  canonicalUtc(core.createdAt);
  canonicalUtc(core.updatedAt);
  if (record.id !== banditStateId(core.banditId, core.armId, core.contextKey)) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit state identity mismatch");
  if (core.rewardSum < 0 || core.rewardSum > core.pulls || core.rewardSquareSum < 0 || core.rewardSquareSum > core.pulls) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit state reward aggregates are invalid");
  const digest = stringProperty(record, BSP.recordDigest);
  if (digest !== hash("cbstaterecord", core)) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit state digest mismatch");
  return { id: record.id, ...core, digest, revision: record.revision };
}

export function projectBanditDecision(record: ObjectRecord): BanditDecisionRecord {
  if (record.typeId !== BANDIT_DECISION_TYPE) throw new ContextualBanditError("INTEGRITY_FAILURE", `${record.id} is not a contextual bandit decision record`);
  const status = stringProperty(record, BDP.status) as BanditDecisionStatus;
  if (status !== "PENDING" && status !== "REWARDED") throw new ContextualBanditError("INTEGRITY_FAILURE", "unsupported bandit decision status");
  const reward = optionalNumberProperty(record, BDP.reward);
  const outcomeAt = optionalStringProperty(record, BDP.outcomeAt);
  const core = {
    banditId: stringProperty(record, BDP.banditId),
    interactionId: stringProperty(record, BDP.interactionId),
    armId: stringProperty(record, BDP.armId),
    contextKey: stringProperty(record, BDP.contextKey),
    contextDigest: stringProperty(record, BDP.contextDigest),
    policyDigest: stringProperty(record, BDP.policyDigest),
    guardrailContextDigest: stringProperty(record, BDP.guardrailContextDigest),
    issuedAt: stringProperty(record, BDP.issuedAt),
    status,
    ...(reward === undefined ? {} : { reward }),
    ...(outcomeAt === undefined ? {} : { outcomeAt }),
  };
  canonicalUtc(core.issuedAt);
  if (status === "PENDING" && (reward !== undefined || outcomeAt !== undefined)) throw new ContextualBanditError("INTEGRITY_FAILURE", "pending decision carries outcome data");
  if (status === "REWARDED") {
    if (reward === undefined || outcomeAt === undefined) throw new ContextualBanditError("INTEGRITY_FAILURE", "rewarded decision is missing outcome data");
    assertReward(reward, "INTEGRITY_FAILURE");
    canonicalUtc(outcomeAt);
    if (Date.parse(outcomeAt) < Date.parse(core.issuedAt)) throw new ContextualBanditError("INTEGRITY_FAILURE", "stored outcome precedes decision issuance");
  }
  if (record.id !== banditDecisionId(core.banditId, core.interactionId)) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit decision identity mismatch");
  const digest = stringProperty(record, BDP.recordDigest);
  if (digest !== hash("cbdecisionrecord", core)) throw new ContextualBanditError("INTEGRITY_FAILURE", `bandit decision digest mismatch: ${canonicalJson(core)}`);
  return { id: record.id, ...core, digest, revision: record.revision };
}
