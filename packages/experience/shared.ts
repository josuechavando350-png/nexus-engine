/** Shared contracts for the NEXUS V2 Experience Engine. Pure TypeScript only. */

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type DecisionRationale = {
  /** Brand/problem-specific reason. Never "because NEXUS does it this way". */
  because: string;
  /** Optional evidence identifiers from brief/reference/user research. */
  evidence?: readonly string[];
};

export type IntentScale = {
  /** Normalized intent from 0..1. This is not a CSS value. */
  value: number;
  rationale: DecisionRationale;
};

export type DirectionDescriptor = {
  /** Open vocabulary. Describes intent; it never maps directly to a component. */
  label: string;
  rationale: DecisionRationale;
};

export type EngineConstraint = {
  id: string;
  statement: string;
  source: "brand" | "business" | "accessibility" | "security" | "performance" | "legal" | "technical";
  severity: "required" | "preferred";
};

const FORBIDDEN_UI_KEYS = new Set([
  "component",
  "components",
  "jsx",
  "className",
  "css",
  "styles",
  "style",
  "color",
  "backgroundColor",
  "borderRadius",
  "fontFamily",
  "buttonVariant",
  "cardVariant",
  "heroVariant"
]);

export function assertIntentScale(scale: IntentScale, label: string): void {
  if (!Number.isFinite(scale.value) || scale.value < 0 || scale.value > 1) {
    throw new Error(`${label} must be a finite value between 0 and 1.`);
  }
  assertRationale(scale.rationale, label);
}

export function assertRationale(rationale: DecisionRationale, label: string): void {
  if (!rationale.because.trim()) {
    throw new Error(`${label} requires a brand/problem-specific rationale.`);
  }
}

export function assertUiAgnostic(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertUiAgnostic(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_UI_KEYS.has(key)) {
      throw new Error(`UI-specific key "${key}" is forbidden in Experience Engine contracts (${path}.${key}).`);
    }
    assertUiAgnostic(child, `${path}.${key}`);
  }
}

export function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
