import { createHash } from "node:crypto";
import { computeGeometricMetrics } from "./metrics.js";
import {
  assertUniquePrimitiveIds,
  definePrimitive,
  leafPrimitives,
  unionBounds,
  validateBounds,
} from "./primitives.js";
import type {
  Bounds,
  ConstraintEvaluation,
  CreateTermInput,
  GeometricMetricName,
  GeometricPrimitive,
  MetricConstraint,
  NestInput,
  SequenceInput,
  VisualAlgebraTerm,
} from "./types.js";

const METRIC_NAMES: readonly GeometricMetricName[] = Object.freeze([
  "gridRegularity",
  "axialSymmetry",
  "whitespace",
  "continuity",
  "overlap",
  "structuralEntropy",
  "aspectConsistency",
  "packingDensity",
]);

function canonicalize(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Cannot canonicalize non-plain object at ${path}`);
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) throw new Error(`Cannot canonicalize undefined at ${path}.${key}`);
      output[key] = canonicalize(input[key], `${path}.${key}`);
    }
    return output;
  }

  throw new Error(`Cannot canonicalize ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("Value is not canonical JSON");
  return serialized;
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function resolveCanvas(primitives: readonly GeometricPrimitive[], requested?: Bounds): Bounds {
  if (requested) {
    validateBounds(requested, "canvasBounds");
    if (requested.width <= 0 || requested.height <= 0) {
      throw new Error("canvasBounds must have positive width and height");
    }
    return Object.freeze({ ...requested });
  }

  const leaves = leafPrimitives(primitives);
  if (leaves.length === 0) return Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

  const inferred = unionBounds(leaves.map((primitive) => primitive.bounds));
  return Object.freeze({
    x: inferred.x,
    y: inferred.y,
    width: inferred.width > 0 ? inferred.width : 1,
    height: inferred.height > 0 ? inferred.height : 1,
  });
}

function validateConstraintBound(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (value < 0 || value > 1) throw new Error(`${label} must be in [0,1]`);
}

export function validateConstraint(constraint: MetricConstraint): void {
  if (constraint.id.trim() === "") throw new Error("Constraint id cannot be empty");
  if (!METRIC_NAMES.includes(constraint.metric)) throw new Error(`Unknown metric: ${constraint.metric}`);
  if (constraint.min === undefined && constraint.max === undefined) {
    throw new Error(`Constraint ${constraint.id} requires min and/or max`);
  }

  validateConstraintBound(constraint.min, `Constraint ${constraint.id}.min`);
  validateConstraintBound(constraint.max, `Constraint ${constraint.id}.max`);

  if (constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max) {
    throw new Error(`Constraint ${constraint.id} min cannot exceed max`);
  }
}

export function evaluateConstraints(
  metrics: VisualAlgebraTerm["metrics"],
  constraints: readonly MetricConstraint[],
): readonly ConstraintEvaluation[] {
  return Object.freeze(constraints.map((constraint) => {
    validateConstraint(constraint);
    const actual = metrics[constraint.metric];
    const minPass = constraint.min === undefined || actual >= constraint.min;
    const maxPass = constraint.max === undefined || actual <= constraint.max;
    const pass = minPass && maxPass;
    const expected = Object.freeze({
      ...(constraint.min !== undefined ? { min: constraint.min } : {}),
      ...(constraint.max !== undefined ? { max: constraint.max } : {}),
    });

    const reason = pass
      ? `${constraint.metric}=${actual} satisfies the configured bounds`
      : `${constraint.metric}=${actual} violates ${!minPass ? `min=${constraint.min}` : `max=${constraint.max}`}`;

    return Object.freeze({ constraint, actual, expected, pass, reason });
  }));
}

function createResolvedTerm(input: {
  readonly subject: string;
  readonly operation: VisualAlgebraTerm["operation"];
  readonly primitives: readonly GeometricPrimitive[];
  readonly canvasBounds?: Bounds;
  readonly constraints?: readonly MetricConstraint[];
}): VisualAlgebraTerm {
  if (input.subject.trim() === "") throw new Error("Term subject cannot be empty");
  assertUniquePrimitiveIds(input.primitives);

  const canvasBounds = resolveCanvas(input.primitives, input.canvasBounds);
  const metrics = computeGeometricMetrics(input.primitives, canvasBounds);
  const constraints = Object.freeze([...(input.constraints ?? [])]);
  const evaluations = evaluateConstraints(metrics, constraints);
  const digestPayload = {
    authority: "NEXUS_VISUAL_ALGEBRA_TERM_V1",
    subject: input.subject,
    operation: input.operation,
    canvasBounds,
    primitives: input.primitives,
    metrics,
    constraints,
    evaluations,
  };

  return Object.freeze({
    subject: input.subject,
    operation: input.operation,
    canvasBounds,
    primitives: Object.freeze([...input.primitives]),
    metrics,
    constraints,
    evaluations,
    digest: digestValue(digestPayload),
  });
}

export function createTerm(input: CreateTermInput): VisualAlgebraTerm {
  const primitives = Object.freeze(input.primitives.map((primitive) => definePrimitive(primitive)));
  return createResolvedTerm({
    subject: input.subject,
    operation: "atomic",
    primitives,
    ...(input.canvasBounds ? { canvasBounds: input.canvasBounds } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
  });
}

export function sequence(input: SequenceInput): VisualAlgebraTerm {
  const primitives = Object.freeze(input.terms.flatMap((term) => term.primitives));
  return createResolvedTerm({
    subject: input.subject,
    operation: "sequence",
    primitives,
    ...(input.canvasBounds ? { canvasBounds: input.canvasBounds } : {}),
    constraints: input.constraints ?? input.terms.flatMap((term) => term.constraints),
  });
}

export function nest(input: NestInput): VisualAlgebraTerm {
  const container = definePrimitive(input.container);
  if (container.kind !== "container") throw new Error("nest() requires a container primitive");

  const nestedContainer = definePrimitive({
    id: container.id,
    kind: "container",
    bounds: container.bounds,
    children: Object.freeze([
      ...container.children,
      ...input.terms.flatMap((term) => term.primitives),
    ]),
    ...(container.metadata ? { metadata: container.metadata } : {}),
  });

  return createResolvedTerm({
    subject: input.subject,
    operation: "nest",
    primitives: [nestedContainer],
    ...(input.canvasBounds ? { canvasBounds: input.canvasBounds } : {}),
    constraints: input.constraints ?? input.terms.flatMap((term) => term.constraints),
  });
}

export function termSatisfiesConstraints(term: VisualAlgebraTerm): boolean {
  return term.evaluations.every((evaluation) => evaluation.pass);
}
