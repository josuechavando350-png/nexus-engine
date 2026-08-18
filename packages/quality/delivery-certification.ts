import type { VerdictState } from "@nexus/creative";
import type { RedTeamArenaReport } from "./red-team";
import type { QualityCycleResult } from "./quality-cycle";
import type { VisualJudgeResult } from "./visual-judge";

export type DeliveryGateId =
  | "CONTENT_READINESS"
  | "GENERATION"
  | "EMITTER"
  | "RENDER"
  | "CAPTURE"
  | "DESIGN_GENOME"
  | "VISUAL_JUDGE"
  | "RED_TEAM"
  | "REPAIR_REJUDGE"
  | "PROVENANCE";

export interface DeliveryGateEvidence {
  gateId: DeliveryGateId;
  verdict: VerdictState;
  detail: string;
  evidenceIds: readonly string[];
}

export interface DeliveryCertificationInput {
  projectId: string;
  sourceRevision: string;
  gates: readonly DeliveryGateEvidence[];
  visualJudge?: VisualJudgeResult;
  redTeam?: RedTeamArenaReport;
  qualityCycle?: QualityCycleResult;
}

export interface DeliveryCertificationReport {
  authority: "NEXUS_DELIVERY_CERTIFICATION_V1";
  projectId: string;
  sourceRevision: string;
  verdict: VerdictState;
  certified: boolean;
  gates: readonly DeliveryGateEvidence[];
  blockers: readonly string[];
  evidenceIds: readonly string[];
}

const REQUIRED_GATES: readonly DeliveryGateId[] = Object.freeze([
  "CONTENT_READINESS",
  "GENERATION",
  "EMITTER",
  "RENDER",
  "CAPTURE",
  "DESIGN_GENOME",
  "VISUAL_JUDGE",
  "RED_TEAM",
  "REPAIR_REJUDGE",
  "PROVENANCE",
]);

const VALID_VERDICTS = new Set<VerdictState>(["PASS", "FAIL", "WARNING", "NOT_TESTED"]);

function validateGate(gate: DeliveryGateEvidence): void {
  if (!REQUIRED_GATES.includes(gate.gateId)) throw new Error(`unknown delivery gate ${String(gate.gateId)}`);
  if (!VALID_VERDICTS.has(gate.verdict)) throw new Error(`invalid verdict for ${gate.gateId}`);
  if (!gate.detail.trim()) throw new Error(`${gate.gateId} requires detail`);
  if (gate.evidenceIds.some((id) => !id.trim())) throw new Error(`${gate.gateId} evidenceIds must be non-empty strings`);
  if (new Set(gate.evidenceIds).size !== gate.evidenceIds.length) throw new Error(`${gate.gateId} evidenceIds must be unique`);
  if (gate.verdict === "PASS" && gate.evidenceIds.length === 0) throw new Error(`${gate.gateId} cannot PASS without evidence`);
}

function aggregateVerdict(gates: readonly DeliveryGateEvidence[]): VerdictState {
  if (gates.some((gate) => gate.verdict === "FAIL")) return "FAIL";
  if (gates.some((gate) => gate.verdict === "NOT_TESTED")) return "NOT_TESTED";
  if (gates.some((gate) => gate.verdict === "WARNING")) return "WARNING";
  return "PASS";
}

export function certifyDelivery(input: DeliveryCertificationInput): DeliveryCertificationReport {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("delivery certification requires projectId");
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision)) throw new Error("delivery certification sourceRevision must be a full lowercase git SHA-1");

  const byId = new Map<DeliveryGateId, DeliveryGateEvidence>();
  for (const gate of input.gates) {
    validateGate(gate);
    if (byId.has(gate.gateId)) throw new Error(`duplicate delivery gate ${gate.gateId}`);
    byId.set(gate.gateId, gate);
  }

  const normalized: DeliveryGateEvidence[] = [];
  for (const gateId of REQUIRED_GATES) {
    const supplied = byId.get(gateId);
    normalized.push(supplied ?? Object.freeze({
      gateId,
      verdict: "NOT_TESTED" as const,
      detail: `${gateId} evidence was not supplied`,
      evidenceIds: Object.freeze([]),
    }));
  }

  const blockers: string[] = [];
  const visualGate = normalized.find((gate) => gate.gateId === "VISUAL_JUDGE")!;
  if (visualGate.verdict === "PASS") {
    if (!input.visualJudge || input.visualJudge.authority !== "NEXUS_VISUAL_JUDGE" || !input.visualJudge.approved || input.visualJudge.verdict !== "PASS") {
      blockers.push("VISUAL_JUDGE claimed PASS without an approved NEXUS Visual Judge report");
      visualGate.verdict = "FAIL";
    }
  }

  const redTeamGate = normalized.find((gate) => gate.gateId === "RED_TEAM")!;
  if (redTeamGate.verdict === "PASS") {
    if (!input.redTeam || input.redTeam.authority !== "NEXUS_RED_TEAM_ARENA" || !input.redTeam.approved || input.redTeam.verdict !== "PASS" || input.redTeam.attacks.some((attack) => attack.verdict !== "PASS")) {
      blockers.push("RED_TEAM claimed PASS without an all-attacks-PASS NEXUS Red Team report");
      redTeamGate.verdict = "FAIL";
    }
  }

  const repairGate = normalized.find((gate) => gate.gateId === "REPAIR_REJUDGE")!;
  if (repairGate.verdict === "PASS") {
    if (!input.qualityCycle || input.qualityCycle.authority !== "NEXUS_BOUNDED_REPAIR_LOOP" || input.qualityCycle.status !== "SHIPPABLE" || input.qualityCycle.finalEvaluation.verdict !== "PASS") {
      blockers.push("REPAIR_REJUDGE claimed PASS without a SHIPPABLE evidence-bound quality cycle");
      repairGate.verdict = "FAIL";
    }
  }

  for (const gate of normalized) {
    if (gate.verdict !== "PASS") blockers.push(`${gate.gateId}:${gate.verdict}:${gate.detail}`);
  }

  const verdict = aggregateVerdict(normalized);
  const evidenceIds = [...new Set(normalized.flatMap((gate) => gate.evidenceIds))].sort((a, b) => a.localeCompare(b, "en"));
  return Object.freeze({
    authority: "NEXUS_DELIVERY_CERTIFICATION_V1",
    projectId,
    sourceRevision: input.sourceRevision,
    verdict,
    certified: verdict === "PASS" && blockers.length === 0,
    gates: Object.freeze(normalized.map((gate) => Object.freeze({ ...gate, evidenceIds: Object.freeze([...gate.evidenceIds]) }))),
    blockers: Object.freeze(blockers),
    evidenceIds: Object.freeze(evidenceIds),
  });
}

export function requiredDeliveryGateIds(): readonly DeliveryGateId[] {
  return REQUIRED_GATES;
}
