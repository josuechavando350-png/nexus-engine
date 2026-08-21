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

const AUTHORITIES = new Set<DecisionAuthority>(["HUMAN_ART_DIRECTOR", "PROJECT_DESIGN_DNA", "ENGINE_RULE"]);
const SHA256 = /^[a-f0-9]{64}$/;

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

function normalizeEntry(entry: DecisionTraceEntry): DecisionTraceEntry {
  const values = Object.values(entry);
  if (values.some((value) => typeof value !== "string")) throw new Error("decision trace fields must be strings");
  const next = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, value.trim()])) as unknown as DecisionTraceEntry;
  if (!next.elementId || !next.property || !next.value || !next.authorityRef || !next.rationale) throw new Error("decision trace fields must be non-empty");
  if (!AUTHORITIES.has(next.authority)) throw new Error(`invalid decision authority: ${next.authority}`);
  return Object.freeze(next);
}

export function createDecisionTrace(entries: readonly DecisionTraceEntry[]): DecisionTrace {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("decision trace requires at least one entry");
  const normalized = entries
    .map(normalizeEntry)
    .sort((a, b) => `${a.elementId}\0${a.property}`.localeCompare(`${b.elementId}\0${b.property}`, "en"));
  const keys = normalized.map((entry) => `${entry.elementId}\0${entry.property}`);
  if (new Set(keys).size !== keys.length) throw new Error("decision trace cannot contain duplicate element/property decisions");
  const traceHash = createHash("sha256").update(canonical(normalized)).digest("hex");
  return Object.freeze({ authority: "NEXUS_DECISION_TRACE_V1", entries: Object.freeze(normalized), traceHash });
}

export function verifyDecisionTrace(trace: DecisionTrace): boolean {
  try {
    if (trace.authority !== "NEXUS_DECISION_TRACE_V1" || !SHA256.test(trace.traceHash) || !Array.isArray(trace.entries) || trace.entries.length === 0) return false;
    const rebuilt = createDecisionTrace(trace.entries);
    return rebuilt.traceHash === trace.traceHash && JSON.stringify(rebuilt.entries) === JSON.stringify(trace.entries);
  } catch {
    return false;
  }
}
