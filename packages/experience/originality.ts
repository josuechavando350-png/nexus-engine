import { clamp01, uniq } from "./shared";

export type FingerprintDimension =
  | "opening"
  | "navigation"
  | "sequence"
  | "structure"
  | "ctaGrammar"
  | "geometryGrammar"
  | "mediaGrammar"
  | "motionGrammar"
  | "typographyHierarchy";

/** Color is intentionally absent. Originality must survive a grayscale test. */
export type StyleFingerprintV2 = {
  version: 2;
  subject: string;
  observedAt: string;
  openingSignature: string;
  navigationSignature: string;
  sectionSequence: readonly string[];
  structure: {
    cardReliance: number;
    gridRegularity: number;
    symmetry: number;
    overlap: number;
    whitespace: number;
    continuity: number;
  };
  ctaGrammar: readonly string[];
  geometryGrammar: readonly string[];
  mediaGrammar: readonly string[];
  motionGrammar: readonly string[];
  typographyHierarchy: readonly string[];
  notes?: string;
};

export type SimilarityDimensionResult = {
  dimension: FingerprintDimension;
  score: number;
  evidence: readonly string[];
  justified: boolean;
  justification?: string;
};

export type SimilarityReport = {
  left: string;
  right: string;
  overall: number;
  dimensions: readonly SimilarityDimensionResult[];
  warnings: readonly string[];
};

export type OriginalityPolicy = {
  /** Optional evidence-backed thresholds. V2 ships with none by default. */
  warnAbove?: Partial<Record<FingerprintDimension, number>>;
  overallWarnAbove?: number;
};

const STRUCTURE_KEYS = ["cardReliance", "gridRegularity", "symmetry", "overlap", "whitespace", "continuity"] as const satisfies readonly (keyof StyleFingerprintV2["structure"])[];
const GRAMMAR_LIST_KEYS = ["ctaGrammar", "geometryGrammar", "mediaGrammar", "motionGrammar", "typographyHierarchy"] as const satisfies readonly (keyof StyleFingerprintV2)[];

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > 2_048) throw new Error(`${field} exceeds 2048 characters`);
  return value;
}

function validateObservedAt(value: unknown): string {
  const observedAt = requireText(value, "fingerprint.observedAt");
  if (/^\d{4}-\d{2}-\d{2}$/.test(observedAt)) {
    const parsed = new Date(`${observedAt}T00:00:00.000Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === observedAt) return observedAt;
  }
  const parsed = new Date(observedAt);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === observedAt) return observedAt;
  throw new Error("fingerprint.observedAt must be YYYY-MM-DD or canonical ISO-8601 UTC");
}

function validateStringList(value: unknown, field: string, options: { unique?: boolean } = {}): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((item, index) => requireText(item, `${field}[${index}]`));
  if (options.unique) {
    const normalized = result.map((item) => item.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must be unique after normalization`);
  }
  return Object.freeze(result);
}

export function validateStyleFingerprintV2(value: unknown): StyleFingerprintV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fingerprint must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 2) throw new Error("fingerprint.version must be 2");
  const structureRaw = raw.structure;
  if (!structureRaw || typeof structureRaw !== "object" || Array.isArray(structureRaw)) throw new Error("fingerprint.structure must be an object");
  const structureRecord = structureRaw as Record<string, unknown>;
  const structure = {} as StyleFingerprintV2["structure"];
  for (const key of STRUCTURE_KEYS) {
    const numeric = structureRecord[key];
    if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new Error(`fingerprint.structure.${key} must be finite in [0,1]`);
    structure[key] = numeric;
  }

  const sectionSequence = validateStringList(raw.sectionSequence, "fingerprint.sectionSequence");
  const grammarLists = Object.fromEntries(GRAMMAR_LIST_KEYS.map((key) => [key, validateStringList(raw[key], `fingerprint.${String(key)}`, { unique: true })])) as Pick<StyleFingerprintV2, typeof GRAMMAR_LIST_KEYS[number]>;
  const notes = raw.notes === undefined ? undefined : requireText(raw.notes, "fingerprint.notes");
  return Object.freeze({
    version: 2,
    subject: requireText(raw.subject, "fingerprint.subject"),
    observedAt: validateObservedAt(raw.observedAt),
    openingSignature: requireText(raw.openingSignature, "fingerprint.openingSignature"),
    navigationSignature: requireText(raw.navigationSignature, "fingerprint.navigationSignature"),
    sectionSequence,
    structure: Object.freeze(structure),
    ctaGrammar: grammarLists.ctaGrammar,
    geometryGrammar: grammarLists.geometryGrammar,
    mediaGrammar: grammarLists.mediaGrammar,
    motionGrammar: grammarLists.motionGrammar,
    typographyHierarchy: grammarLists.typographyHierarchy,
    ...(notes ? { notes } : {}),
  });
}

function textSimilarity(a: string, b: string): number {
  return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
}

function setSimilarity(a: readonly string[], b: readonly string[]): number {
  const aa = new Set(a.map((v) => v.trim().toLowerCase()));
  const bb = new Set(b.map((v) => v.trim().toLowerCase()));
  const union = new Set([...aa, ...bb]);
  if (!union.size) return 1;
  const intersection = [...aa].filter((value) => bb.has(value)).length;
  return intersection / union.size;
}

function sequenceSimilarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      table[i][j] = a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase()
        ? (table[i - 1]?.[j - 1] ?? 0) + 1
        : Math.max(table[i - 1]?.[j] ?? 0, table[i]?.[j - 1] ?? 0);
    }
  }

  return (table[a.length]?.[b.length] ?? 0) / Math.max(a.length, b.length);
}

function structureSimilarity(a: StyleFingerprintV2["structure"], b: StyleFingerprintV2["structure"]): number {
  const keys = Object.keys(a) as Array<keyof StyleFingerprintV2["structure"]>;
  const scores = keys.map((key) => 1 - Math.abs(clamp01(a[key]) - clamp01(b[key])));
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

export function compareFingerprints(
  leftInput: StyleFingerprintV2,
  rightInput: StyleFingerprintV2,
  options: {
    policy?: OriginalityPolicy;
    justifications?: Partial<Record<FingerprintDimension, string>>;
  } = {}
): SimilarityReport {
  const left = validateStyleFingerprintV2(leftInput);
  const right = validateStyleFingerprintV2(rightInput);
  const raw: Array<[FingerprintDimension, number, string[]]> = [
    ["opening", textSimilarity(left.openingSignature, right.openingSignature), [left.openingSignature, right.openingSignature]],
    ["navigation", textSimilarity(left.navigationSignature, right.navigationSignature), [left.navigationSignature, right.navigationSignature]],
    ["sequence", sequenceSimilarity(left.sectionSequence, right.sectionSequence), [`left=${left.sectionSequence.join(" > ")}`, `right=${right.sectionSequence.join(" > ")}`]],
    ["structure", structureSimilarity(left.structure, right.structure), [JSON.stringify(left.structure), JSON.stringify(right.structure)]],
    ["ctaGrammar", setSimilarity(left.ctaGrammar, right.ctaGrammar), uniq([...left.ctaGrammar, ...right.ctaGrammar])],
    ["geometryGrammar", setSimilarity(left.geometryGrammar, right.geometryGrammar), uniq([...left.geometryGrammar, ...right.geometryGrammar])],
    ["mediaGrammar", setSimilarity(left.mediaGrammar, right.mediaGrammar), uniq([...left.mediaGrammar, ...right.mediaGrammar])],
    ["motionGrammar", setSimilarity(left.motionGrammar, right.motionGrammar), uniq([...left.motionGrammar, ...right.motionGrammar])],
    ["typographyHierarchy", setSimilarity(left.typographyHierarchy, right.typographyHierarchy), uniq([...left.typographyHierarchy, ...right.typographyHierarchy])]
  ];

  const dimensions = raw.map(([dimension, score, evidence]) => {
    const justification = options.justifications?.[dimension];
    return { dimension, score, evidence, justified: Boolean(justification), justification } satisfies SimilarityDimensionResult;
  });

  const overall = dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length;
  const warnings: string[] = [];

  for (const item of dimensions) {
    const threshold = options.policy?.warnAbove?.[item.dimension];
    if (threshold !== undefined && item.score >= threshold && !item.justified) {
      warnings.push(`${item.dimension} similarity ${item.score.toFixed(2)} >= policy ${threshold.toFixed(2)}`);
    }
  }

  if (options.policy?.overallWarnAbove !== undefined && overall >= options.policy.overallWarnAbove) {
    warnings.push(`overall similarity ${overall.toFixed(2)} >= policy ${options.policy.overallWarnAbove.toFixed(2)}`);
  }

  // Exact duplication is objective enough to warn without a subjective policy.
  const exactStructuralDuplicates = dimensions.filter(
    (item) => ["opening", "navigation", "sequence", "ctaGrammar"].includes(item.dimension) && item.score === 1 && !item.justified
  );
  if (exactStructuralDuplicates.length >= 3) {
    warnings.push(`exact structural duplication across ${exactStructuralDuplicates.map((item) => item.dimension).join(", ")}`);
  }

  return { left: left.subject, right: right.subject, overall, dimensions, warnings };
}
