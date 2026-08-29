import {
  clipBounds,
  leafPrimitives,
  primitiveCenter,
  rectangleUnionArea,
  unionBounds,
  validateBounds,
} from "./primitives.js";
import type { Bounds, GeometricMetrics, GeometricPrimitive } from "./types.js";

const EPSILON = 1e-12;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Metric calculation produced a non-finite value");
  }
  return Math.min(1, Math.max(0, value));
}

function canvasDiagonal(canvas: Bounds): number {
  return Math.hypot(canvas.width, canvas.height);
}

function effectiveCanvas(primitives: readonly GeometricPrimitive[], canvas?: Bounds): Bounds {
  if (canvas) {
    validateBounds(canvas, "canvasBounds");
    if (canvas.width <= 0 || canvas.height <= 0) {
      throw new Error("canvasBounds must have positive width and height");
    }
    return canvas;
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

export function gridRegularity(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  const leaves = leafPrimitives(primitives);
  if (leaves.length <= 1) return 1;

  const canvas = effectiveCanvas(primitives, canvasBounds);
  const tolerance = Math.max(1e-9, Math.min(canvas.width, canvas.height) * 0.01);
  const xAnchors = leaves.map((primitive) => [
    primitive.bounds.x,
    primitive.bounds.x + primitive.bounds.width / 2,
    primitive.bounds.x + primitive.bounds.width,
  ] as const);
  const yAnchors = leaves.map((primitive) => [
    primitive.bounds.y,
    primitive.bounds.y + primitive.bounds.height / 2,
    primitive.bounds.y + primitive.bounds.height,
  ] as const);

  const axisScore = (anchors: readonly (readonly number[])[]): number => {
    let aligned = 0;
    let total = 0;

    for (let i = 0; i < anchors.length; i += 1) {
      for (const anchor of anchors[i]!) {
        total += 1;
        let hasPeer = false;

        for (let j = 0; j < anchors.length && !hasPeer; j += 1) {
          if (i === j) continue;
          hasPeer = anchors[j]!.some((peer) => Math.abs(peer - anchor) <= tolerance);
        }

        if (hasPeer) aligned += 1;
      }
    }

    return total === 0 ? 1 : aligned / total;
  };

  return clamp01((axisScore(xAnchors) + axisScore(yAnchors)) / 2);
}

function symmetryAxisScore(
  primitives: readonly Exclude<GeometricPrimitive, { kind: "container" }>[],
  canvas: Bounds,
  axis: "vertical" | "horizontal",
): number {
  if (primitives.length === 0) return 1;

  const diagonal = Math.max(EPSILON, canvasDiagonal(canvas));
  const axisCoordinate = axis === "vertical"
    ? canvas.x + canvas.width / 2
    : canvas.y + canvas.height / 2;

  let totalCost = 0;

  for (const primitive of primitives) {
    const center = primitiveCenter(primitive);
    const reflected = axis === "vertical"
      ? { x: 2 * axisCoordinate - center.x, y: center.y }
      : { x: center.x, y: 2 * axisCoordinate - center.y };

    let bestCost = 1;

    for (const candidate of primitives) {
      if (candidate.kind !== primitive.kind) continue;
      const candidateCenter = primitiveCenter(candidate);
      const centerCost = Math.hypot(
        reflected.x - candidateCenter.x,
        reflected.y - candidateCenter.y,
      ) / diagonal;
      const sizeCost = (
        Math.abs(primitive.bounds.width - candidate.bounds.width) / Math.max(canvas.width, EPSILON)
        + Math.abs(primitive.bounds.height - candidate.bounds.height) / Math.max(canvas.height, EPSILON)
      ) / 2;
      bestCost = Math.min(bestCost, clamp01(0.8 * centerCost + 0.2 * sizeCost));
    }

    totalCost += bestCost;
  }

  return clamp01(1 - totalCost / primitives.length);
}

export function axialSymmetry(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  const leaves = leafPrimitives(primitives);
  const canvas = effectiveCanvas(primitives, canvasBounds);
  return Math.max(
    symmetryAxisScore(leaves, canvas, "vertical"),
    symmetryAxisScore(leaves, canvas, "horizontal"),
  );
}

function clippedLeafBounds(primitives: readonly GeometricPrimitive[], canvas: Bounds): readonly Bounds[] {
  return leafPrimitives(primitives)
    .map((primitive) => clipBounds(primitive.bounds, canvas))
    .filter((bounds): bounds is Bounds => bounds !== null);
}

export function whitespace(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  const canvas = effectiveCanvas(primitives, canvasBounds);
  const canvasArea = canvas.width * canvas.height;
  const occupied = rectangleUnionArea(clippedLeafBounds(primitives, canvas));
  return clamp01(1 - occupied / canvasArea);
}

export function overlap(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  const canvas = effectiveCanvas(primitives, canvasBounds);
  const bounds = clippedLeafBounds(primitives, canvas);
  const summedArea = bounds.reduce((sum, item) => sum + item.width * item.height, 0);
  if (summedArea <= EPSILON) return 0;
  return clamp01(1 - rectangleUnionArea(bounds) / summedArea);
}

export function packingDensity(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  void canvasBounds;
  const leaves = leafPrimitives(primitives).filter(
    (primitive) => primitive.bounds.width > 0 && primitive.bounds.height > 0,
  );
  if (leaves.length === 0) return 0;

  const tight = unionBounds(leaves.map((primitive) => primitive.bounds));
  const tightArea = tight.width * tight.height;
  if (tightArea <= EPSILON) return 0;

  const occupied = rectangleUnionArea(leaves.map((primitive) => primitive.bounds));
  return clamp01(occupied / tightArea);
}

export function continuity(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  const leaves = leafPrimitives(primitives);
  if (leaves.length <= 1) return 1;

  const canvas = effectiveCanvas(primitives, canvasBounds);
  const diagonal = Math.max(EPSILON, canvasDiagonal(canvas));
  let score = 0;

  for (let i = 0; i < leaves.length; i += 1) {
    const sourceCenter = primitiveCenter(leaves[i]!);
    let nearestDistance = Number.POSITIVE_INFINITY;
    let bestAlignment = 0;

    for (let j = 0; j < leaves.length; j += 1) {
      if (i === j) continue;
      const targetCenter = primitiveCenter(leaves[j]!);
      const distance = Math.hypot(sourceCenter.x - targetCenter.x, sourceCenter.y - targetCenter.y);
      nearestDistance = Math.min(nearestDistance, distance);

      const xAlignment = 1 - Math.min(
        1,
        Math.abs(sourceCenter.x - targetCenter.x) / Math.max(canvas.width, EPSILON),
      );
      const yAlignment = 1 - Math.min(
        1,
        Math.abs(sourceCenter.y - targetCenter.y) / Math.max(canvas.height, EPSILON),
      );
      bestAlignment = Math.max(bestAlignment, xAlignment, yAlignment);
    }

    const proximity = clamp01(1 - nearestDistance / diagonal);
    score += 0.6 * proximity + 0.4 * bestAlignment;
  }

  return clamp01(score / leaves.length);
}

function entropy(values: readonly string[]): number {
  if (values.length <= 1) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let h = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    h -= probability * Math.log2(probability);
  }

  const maxH = Math.log2(values.length);
  return maxH <= EPSILON ? 0 : clamp01(h / maxH);
}

export function structuralEntropy(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  void canvasBounds;
  const leaves = leafPrimitives(primitives);
  if (leaves.length <= 1) return 0;

  const areas = leaves.map((primitive) => primitive.bounds.width * primitive.bounds.height);
  const sorted = [...areas].sort((a, b) => a - b);
  const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)] ?? 0;
  const q2 = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0;
  const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)] ?? 0;

  const signatures = leaves.map((primitive, index) => {
    const area = areas[index]!;
    const areaBucket = area <= q1 ? "xs" : area <= q2 ? "s" : area <= q3 ? "m" : "l";
    const ratio = primitive.bounds.height <= EPSILON
      ? Number.POSITIVE_INFINITY
      : primitive.bounds.width / primitive.bounds.height;
    const ratioBucket = ratio < 0.75 ? "portrait" : ratio > 1.33 ? "landscape" : "square";
    return `${primitive.kind}:${areaBucket}:${ratioBucket}`;
  });

  return entropy(signatures);
}

export function aspectConsistency(primitives: readonly GeometricPrimitive[], canvasBounds?: Bounds): number {
  void canvasBounds;
  const ratios = leafPrimitives(primitives)
    .filter((primitive) => primitive.bounds.width > EPSILON && primitive.bounds.height > EPSILON)
    .map((primitive) => Math.log(primitive.bounds.width / primitive.bounds.height));

  if (ratios.length <= 1) return 1;

  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const variance = ratios.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ratios.length;
  return clamp01(1 / (1 + Math.sqrt(variance)));
}

export function computeGeometricMetrics(
  primitives: readonly GeometricPrimitive[],
  canvasBounds?: Bounds,
): GeometricMetrics {
  return Object.freeze({
    gridRegularity: gridRegularity(primitives, canvasBounds),
    axialSymmetry: axialSymmetry(primitives, canvasBounds),
    whitespace: whitespace(primitives, canvasBounds),
    continuity: continuity(primitives, canvasBounds),
    overlap: overlap(primitives, canvasBounds),
    structuralEntropy: structuralEntropy(primitives, canvasBounds),
    aspectConsistency: aspectConsistency(primitives, canvasBounds),
    packingDensity: packingDensity(primitives, canvasBounds),
  });
}
