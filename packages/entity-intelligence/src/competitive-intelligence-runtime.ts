import { analyzeCompetitiveIntelligence, capturePublicPage, validateCompetitiveScope, type CompetitiveIntelligenceReport, type CompetitiveScope } from "./competitive-intelligence";

const MAX_COMPETITORS = 20;
const MAX_ID = 200;
const MAX_LABEL = 500;
const MAX_URL = 4_096;

export interface CompetitiveRuntimeSubject {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface CompetitiveRuntimeRequest {
  readonly scope: CompetitiveScope;
  readonly observedAt: string;
  readonly target: CompetitiveRuntimeSubject;
  readonly competitors: readonly CompetitiveRuntimeSubject[];
  readonly timeoutMs?: number;
}

function cleanString(label: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be non-empty and <= ${max} characters`);
  return normalized;
}

function normalizeSubject(subject: CompetitiveRuntimeSubject, label: string): CompetitiveRuntimeSubject {
  if (!subject || typeof subject !== "object") throw new Error(`${label} must be an object`);
  return Object.freeze({
    id: cleanString(`${label}.id`, subject.id, MAX_ID),
    label: cleanString(`${label}.label`, subject.label, MAX_LABEL),
    url: cleanString(`${label}.url`, subject.url, MAX_URL),
  });
}

export async function runCompetitiveIntelligence(
  request: CompetitiveRuntimeRequest,
  signal?: AbortSignal,
): Promise<CompetitiveIntelligenceReport> {
  if (!request || typeof request !== "object") throw new Error("competitive runtime request must be an object");
  const scope = validateCompetitiveScope(request.scope);
  if (!Array.isArray(request.competitors) || request.competitors.length < 1 || request.competitors.length > MAX_COMPETITORS) {
    throw new Error(`competitors must contain 1 to ${MAX_COMPETITORS} subjects`);
  }
  const target = normalizeSubject(request.target, "target");
  const competitors = request.competitors.map((subject, index) => normalizeSubject(subject, `competitors[${index}]`));
  const ids = [target.id, ...competitors.map((subject) => subject.id)];
  if (new Set(ids).size !== ids.length) throw new Error("runtime subject ids must be unique");

  const targetObservation = await capturePublicPage(target.url, request.observedAt, { timeoutMs: request.timeoutMs, signal });
  const competitorObservations = [];
  for (const competitor of competitors) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("competitive intelligence cancelled");
    competitorObservations.push({
      id: competitor.id,
      label: competitor.label,
      observation: await capturePublicPage(competitor.url, request.observedAt, { timeoutMs: request.timeoutMs, signal }),
    });
  }

  return analyzeCompetitiveIntelligence(
    scope,
    { id: target.id, label: target.label, observation: targetObservation },
    competitorObservations,
  );
}
