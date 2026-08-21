import { createHash } from "node:crypto";

export type DecisionAuthority = "HUMAN_ART_DIRECTOR" | "PROJECT_DESIGN_DNA" | "ENGINE_RULE";

export type DecisionTraceEntry = Readonly<{
  elementId: string;
  property: string;
  value: string;
  authority: DecisionAuthority;
  authorityRef: string;
  rationale: string;
}>;

export type DecisionTrace = Readonly<{
  authority: "NEXUS_DECISION_TRACE_V1";
  entries: readonly DecisionTraceEntry[];
  traceHash: string;
}>;

function canonical(entries: readonly DecisionTraceEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({
    authority: entry.authority,
    authorityRef: entry.authorityRef,
    elementId: entry.elementId,
    property: entry.property,
    rationale: entry.rationale,
    value: entry.value,
  })));
}

export function createDecisionTrace(entries: readonly DecisionTraceEntry[]): DecisionTrace {
  const normalized = entries.map((entry) => {
    const next = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, value.trim()])) as unknown as DecisionTraceEntry;
    if (!next.elementId || !next.property || !next.value || !next.authorityRef || !next.rationale) throw new Error("decision trace fields must be non-empty");
    return Object.freeze(next);
  }).sort((a, b) => `${a.elementId}\0${a.property}`.localeCompare(`${b.elementId}\0${b.property}`, "en"));
  const keys = normalized.map((entry) => `${entry.elementId}\0${entry.property}`);
  if (new Set(keys).size !== keys.length) throw new Error("decision trace cannot contain duplicate element/property decisions");
  const traceHash = createHash("sha256").update(canonical(normalized)).digest("hex");
  return Object.freeze({ authority: "NEXUS_DECISION_TRACE_V1", entries: Object.freeze(normalized), traceHash });
}

export function verifyDecisionTrace(trace: DecisionTrace): boolean {
  return createHash("sha256").update(canonical(trace.entries)).digest("hex") === trace.traceHash;
}
