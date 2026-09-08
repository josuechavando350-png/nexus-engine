import { createHash } from "node:crypto";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;

export type PymeCapabilityId =
  | "semantic-search-term-intelligence"
  | "serverless-form-dlq"
  | "contextual-bandit-control-plane"
  | "ad-context-edge-personalization"
  | "enhanced-conversions-data-manager-privacy"
  | "webhook-relay-consent-registry"
  | "lifecycle-cwv-optimization";

export type PymeCapabilityMode = "ACTIVE" | "FALLBACK_ONLY" | "BLOCKED";

export interface PymeCapabilityDefinition {
  readonly technologyNumber: 15 | 20 | 21 | 27 | 30 | 31 | 33;
  readonly capabilityId: PymeCapabilityId;
  readonly implementationRef: string;
  readonly dependencies: readonly PymeCapabilityId[];
  readonly defaultMode: "ACTIVE" | "FALLBACK_ONLY" | "CONSENT_GATED" | "CERTIFIED_ACTIVE";
}

export interface PymeCapabilityEvidence {
  readonly installed: boolean;
  readonly runtimeReady: boolean;
  readonly controlReady: boolean;
  readonly policyDigest?: `sha256:${string}` | null;
  readonly consentRegistryReady?: boolean;
  readonly certificationDigest?: `sha256:${string}` | null;
  readonly sourceRevision?: string | null;
  readonly statisticalEvidenceReady?: boolean;
}

export interface PymeCapabilityGateResult {
  readonly technologyNumber: PymeCapabilityDefinition["technologyNumber"];
  readonly capabilityId: PymeCapabilityId;
  readonly implementationRef: string;
  readonly mode: PymeCapabilityMode;
  readonly reasons: readonly string[];
}

export interface PymeProfileResolution {
  readonly profileId: "NEXUS_CORTEX_PYME_V1";
  readonly ready: boolean;
  readonly capabilities: readonly PymeCapabilityGateResult[];
  readonly profileDigest: `sha256:${string}`;
}

export const PYME_CAPABILITIES: readonly PymeCapabilityDefinition[] = Object.freeze([
  Object.freeze({ technologyNumber: 15, capabilityId: "semantic-search-term-intelligence", implementationRef: "@nexus/ontology/cortex/semantic-search", dependencies: Object.freeze([]), defaultMode: "ACTIVE" }),
  Object.freeze({ technologyNumber: 20, capabilityId: "serverless-form-dlq", implementationRef: "@nexus/ontology/cortex/serverless-form-dlq", dependencies: Object.freeze([]), defaultMode: "ACTIVE" }),
  Object.freeze({ technologyNumber: 21, capabilityId: "contextual-bandit-control-plane", implementationRef: "@nexus/ontology/cortex/bandit-experimentation/control-plane-integration", dependencies: Object.freeze([]), defaultMode: "FALLBACK_ONLY" }),
  Object.freeze({ technologyNumber: 27, capabilityId: "ad-context-edge-personalization", implementationRef: "@nexus/core/cortex/ad-context-edge-personalization", dependencies: Object.freeze(["contextual-bandit-control-plane"] as const), defaultMode: "ACTIVE" }),
  Object.freeze({ technologyNumber: 30, capabilityId: "enhanced-conversions-data-manager-privacy", implementationRef: "@nexus/ontology/cortex/pyme/enhanced-conversions-privacy", dependencies: Object.freeze([]), defaultMode: "CONSENT_GATED" }),
  Object.freeze({ technologyNumber: 31, capabilityId: "webhook-relay-consent-registry", implementationRef: "@nexus/ontology/cortex/pyme/consent-aware-relay", dependencies: Object.freeze(["serverless-form-dlq"] as const), defaultMode: "CONSENT_GATED" }),
  Object.freeze({ technologyNumber: 33, capabilityId: "lifecycle-cwv-optimization", implementationRef: "@nexus/core/cortex/cwv-lifecycle-pipeline", dependencies: Object.freeze([]), defaultMode: "CERTIFIED_ACTIVE" }),
] as const);

const PYME_CAPABILITY_IDS = new Set<PymeCapabilityId>(PYME_CAPABILITIES.map((entry) => entry.capabilityId));

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function validDigest(value: unknown): boolean {
  return typeof value === "string" && SHA256.test(value);
}

function evidenceFor(input: Readonly<Record<string, PymeCapabilityEvidence>>, capabilityId: PymeCapabilityId): PymeCapabilityEvidence {
  const value = input[capabilityId];
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({ installed: false, runtimeReady: false, controlReady: false });
  return value;
}

export function resolvePymeProfile(
  evidenceInput: Readonly<Record<string, PymeCapabilityEvidence>>,
  requestedCapabilityIds: readonly string[] = PYME_CAPABILITIES.map((entry) => entry.capabilityId),
): PymeProfileResolution {
  if (!evidenceInput || typeof evidenceInput !== "object" || Array.isArray(evidenceInput)) throw new TypeError("PyME capability evidence must be a record");
  if (!Array.isArray(requestedCapabilityIds) || requestedCapabilityIds.length !== PYME_CAPABILITIES.length || new Set(requestedCapabilityIds).size !== requestedCapabilityIds.length) throw new TypeError("PyME profile must request exactly seven unique capabilities");
  const requested = new Set(requestedCapabilityIds);
  for (const capabilityId of requested) if (!PYME_CAPABILITY_IDS.has(capabilityId as PymeCapabilityId)) throw new TypeError(`capability ${capabilityId} is not part of the default PyME profile`);
  for (const capabilityId of PYME_CAPABILITY_IDS) if (!requested.has(capabilityId)) throw new TypeError(`required PyME capability ${capabilityId} is missing`);

  const preliminary = new Map<PymeCapabilityId, PymeCapabilityGateResult>();
  for (const definition of PYME_CAPABILITIES) {
    const evidence = evidenceFor(evidenceInput, definition.capabilityId);
    const reasons: string[] = [];
    if (evidence.installed !== true) reasons.push("IMPLEMENTATION_NOT_INSTALLED");
    if (evidence.runtimeReady !== true) reasons.push("RUNTIME_NOT_READY");
    if (evidence.controlReady !== true) reasons.push("CONTROL_NOT_READY");
    if ((definition.technologyNumber === 27 || definition.technologyNumber === 30 || definition.technologyNumber === 31 || definition.technologyNumber === 33) && !validDigest(evidence.policyDigest)) reasons.push("POLICY_NOT_CERTIFIED");
    if ((definition.technologyNumber === 30 || definition.technologyNumber === 31) && evidence.consentRegistryReady !== true) reasons.push("CONSENT_REGISTRY_NOT_READY");
    if (definition.technologyNumber === 33) {
      if (!validDigest(evidence.certificationDigest)) reasons.push("CWV_CERTIFICATION_MISSING");
      if (typeof evidence.sourceRevision !== "string" || !SOURCE_SHA.test(evidence.sourceRevision)) reasons.push("SOURCE_REVISION_MISSING");
    }

    let mode: PymeCapabilityMode = reasons.length ? "BLOCKED" : "ACTIVE";
    if (!reasons.length && definition.technologyNumber === 21 && evidence.statisticalEvidenceReady !== true) mode = "FALLBACK_ONLY";
    preliminary.set(definition.capabilityId, Object.freeze({
      technologyNumber: definition.technologyNumber,
      capabilityId: definition.capabilityId,
      implementationRef: definition.implementationRef,
      mode,
      reasons: Object.freeze(reasons),
    }));
  }

  const capabilities = PYME_CAPABILITIES.map((definition) => {
    const current = preliminary.get(definition.capabilityId)!;
    if (current.mode === "BLOCKED") return current;
    const blockedDependency = definition.dependencies.find((dependency) => preliminary.get(dependency)?.mode === "BLOCKED");
    if (!blockedDependency) return current;
    return Object.freeze({ ...current, mode: "BLOCKED" as const, reasons: Object.freeze([`DEPENDENCY_BLOCKED:${blockedDependency}`]) });
  });

  const core = Object.freeze({
    profileId: "NEXUS_CORTEX_PYME_V1" as const,
    ready: capabilities.every((entry) => entry.mode !== "BLOCKED"),
    capabilities: Object.freeze(capabilities),
  });
  return Object.freeze({ ...core, profileDigest: digest(core) });
}

export function pymeCapabilityByTechnology(technologyNumber: number): PymeCapabilityDefinition | undefined {
  return PYME_CAPABILITIES.find((entry) => entry.technologyNumber === technologyNumber);
}
