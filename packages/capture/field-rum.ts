export type FieldVitalMetric = "LCP" | "INP" | "CLS";
export type FieldVitalRating = "GOOD" | "NEEDS_IMPROVEMENT" | "POOR";

export type FieldVitalAttribution = Readonly<{
  navigationType?: string;
  loadState?: string;
  targetSelectorHash?: string;
  resourceUrlOrigin?: string;
}>;

export type FieldVitalSample = Readonly<{
  schemaVersion: 1;
  projectId: string;
  buildRevision: string;
  observedAt: string;
  metric: FieldVitalMetric;
  value: number;
  rating: FieldVitalRating;
  viewport: Readonly<{ width: number; height: number }>;
  attribution?: FieldVitalAttribution;
}>;

export type FieldVitalAggregate = Readonly<{
  metric: FieldVitalMetric;
  sampleCount: number;
  p75: number;
  goodRatio: number;
  needsImprovementRatio: number;
  poorRatio: number;
}>;

export type FieldRumEvidence = Readonly<{
  authority: "NEXUS_FIELD_RUM_V1";
  projectId: string;
  buildRevision: string;
  windowStart: string;
  windowEnd: string;
  status: "MEASURED" | "NOT_TESTED";
  aggregates: readonly FieldVitalAggregate[];
}>;

const SHA = /^[a-f0-9]{40}$/;
const allowedAttributionKeys = new Set(["navigationType", "loadState", "targetSelectorHash", "resourceUrlOrigin"]);

function validateSample(sample: FieldVitalSample): FieldVitalSample {
  if (sample.schemaVersion !== 1) throw new Error("unsupported field RUM schemaVersion");
  if (!sample.projectId.trim()) throw new Error("field RUM projectId is required");
  if (!SHA.test(sample.buildRevision)) throw new Error("field RUM buildRevision must be a full lowercase git SHA-1");
  if (!Number.isFinite(sample.value) || sample.value < 0) throw new Error("field RUM value must be non-negative and finite");
  if (!Number.isInteger(sample.viewport.width) || !Number.isInteger(sample.viewport.height) || sample.viewport.width <= 0 || sample.viewport.height <= 0) {
    throw new Error("field RUM viewport must contain positive integer dimensions");
  }
  const observedAt = new Date(sample.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("field RUM observedAt must be a valid timestamp");
  if (sample.attribution) {
    for (const [key, value] of Object.entries(sample.attribution)) {
      if (!allowedAttributionKeys.has(key)) throw new Error(`field RUM attribution key ${key} is not allowed`);
      if (value !== undefined && (!value.trim() || value.length > 256)) throw new Error(`field RUM attribution ${key} must be 1..256 characters`);
    }
  }
  return Object.freeze({ ...sample, projectId: sample.projectId.trim(), observedAt: observedAt.toISOString(), viewport: Object.freeze({ ...sample.viewport }), attribution: sample.attribution ? Object.freeze({ ...sample.attribution }) : undefined });
}

function percentile75(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot compute p75 from an empty sample set");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.75 * sorted.length) - 1;
  return Number((sorted[Math.max(0, rank)] ?? 0).toFixed(4));
}

export function aggregateFieldRum(input: Readonly<{
  projectId: string;
  buildRevision: string;
  windowStart: string;
  windowEnd: string;
  samples: readonly FieldVitalSample[];
}>): FieldRumEvidence {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("field RUM projectId is required");
  if (!SHA.test(input.buildRevision)) throw new Error("field RUM buildRevision must be a full lowercase git SHA-1");
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error("field RUM requires a valid increasing time window");

  const samples = input.samples.map(validateSample);
  for (const sample of samples) {
    if (sample.projectId !== projectId || sample.buildRevision !== input.buildRevision) throw new Error("field RUM sample scope does not match aggregate scope");
    const at = new Date(sample.observedAt);
    if (at < start || at > end) throw new Error("field RUM sample is outside aggregate time window");
  }

  const metrics = ["LCP", "INP", "CLS"] as const;
  const aggregates = metrics.flatMap((metric): FieldVitalAggregate[] => {
    const group = samples.filter((sample) => sample.metric === metric);
    if (!group.length) return [];
    const ratio = (rating: FieldVitalRating) => Number((group.filter((sample) => sample.rating === rating).length / group.length).toFixed(4));
    return [Object.freeze({ metric, sampleCount: group.length, p75: percentile75(group.map((sample) => sample.value)), goodRatio: ratio("GOOD"), needsImprovementRatio: ratio("NEEDS_IMPROVEMENT"), poorRatio: ratio("POOR") })];
  });

  return Object.freeze({ authority: "NEXUS_FIELD_RUM_V1", projectId, buildRevision: input.buildRevision, windowStart: start.toISOString(), windowEnd: end.toISOString(), status: samples.length ? "MEASURED" : "NOT_TESTED", aggregates: Object.freeze(aggregates) });
}
