import type {
  Bounds,
  ContainerPrimitive,
  GeometricPrimitive,
  Point,
  PrimitiveInput,
} from "./types.js";

const EPSILON = 1e-12;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

export function validateBounds(bounds: Bounds, label = "bounds"): void {
  assertFinite(bounds.x, `${label}.x`);
  assertFinite(bounds.y, `${label}.y`);
  assertFinite(bounds.width, `${label}.width`);
  assertFinite(bounds.height, `${label}.height`);

  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error(`${label} width/height cannot be negative`);
  }
}

export function boundsFromPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) throw new Error("At least one point is required");

  for (const [index, point] of points.entries()) {
    assertFinite(point.x, `points[${index}].x`);
    assertFinite(point.y, `points[${index}].y`);
  }

  let minX = points[0]!.x;
  let maxX = points[0]!.x;
  let minY = points[0]!.y;
  let maxY = points[0]!.y;

  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

export function unionBounds(boundsList: readonly Bounds[]): Bounds {
  if (boundsList.length === 0) return Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
  for (const bounds of boundsList) validateBounds(bounds);

  const minX = Math.min(...boundsList.map((bounds) => bounds.x));
  const minY = Math.min(...boundsList.map((bounds) => bounds.y));
  const maxX = Math.max(...boundsList.map((bounds) => bounds.x + bounds.width));
  const maxY = Math.max(...boundsList.map((bounds) => bounds.y + bounds.height));

  return Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

export function definePrimitive(input: PrimitiveInput | GeometricPrimitive): GeometricPrimitive {
  if (input.id.trim() === "") throw new Error("Primitive id cannot be empty");

  switch (input.kind) {
    case "rectangle":
    case "ellipse":
    case "text":
    case "image": {
      validateBounds(input.bounds, `${input.id}.bounds`);
      return Object.freeze({
        id: input.id,
        kind: input.kind,
        bounds: Object.freeze({ ...input.bounds }),
        ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
      });
    }

    case "line": {
      const bounds = boundsFromPoints([input.start, input.end]);
      return Object.freeze({
        id: input.id,
        kind: "line",
        start: Object.freeze({ ...input.start }),
        end: Object.freeze({ ...input.end }),
        bounds,
        ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
      });
    }

    case "polygon": {
      if (input.points.length < 3) throw new Error(`Polygon ${input.id} requires at least three points`);
      const points = Object.freeze(input.points.map((point) => Object.freeze({ ...point })));
      return Object.freeze({
        id: input.id,
        kind: "polygon",
        points,
        bounds: boundsFromPoints(points),
        ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
      });
    }

    case "container": {
      const children = Object.freeze(input.children.map((child) => definePrimitive(child)));
      assertUniquePrimitiveIds(children);
      if (flattenPrimitives(children).some((child) => child.id === input.id)) {
        throw new Error(`Duplicate primitive id: ${input.id}`);
      }
      const inferred = unionBounds(children.map((child) => child.bounds));
      const bounds = input.bounds ? Object.freeze({ ...input.bounds }) : inferred;
      validateBounds(bounds, `${input.id}.bounds`);

      return Object.freeze({
        id: input.id,
        kind: "container",
        bounds,
        children,
        ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
      });
    }
  }
}

export function validatePrimitive(primitive: GeometricPrimitive): void {
  definePrimitive(primitive);
}

export function assertUniquePrimitiveIds(primitives: readonly GeometricPrimitive[]): void {
  const ids = new Set<string>();
  for (const primitive of flattenPrimitives(primitives)) {
    if (ids.has(primitive.id)) throw new Error(`Duplicate primitive id: ${primitive.id}`);
    ids.add(primitive.id);
  }
}

export function primitiveCenter(primitive: GeometricPrimitive): Point {
  return Object.freeze({
    x: primitive.bounds.x + primitive.bounds.width / 2,
    y: primitive.bounds.y + primitive.bounds.height / 2,
  });
}

export function primitiveArea(primitive: GeometricPrimitive): number {
  switch (primitive.kind) {
    case "rectangle":
    case "text":
    case "image":
      return primitive.bounds.width * primitive.bounds.height;

    case "ellipse":
      return Math.PI * (primitive.bounds.width / 2) * (primitive.bounds.height / 2);

    case "line":
      return 0;

    case "polygon": {
      let twiceArea = 0;
      for (let index = 0; index < primitive.points.length; index += 1) {
        const current = primitive.points[index]!;
        const next = primitive.points[(index + 1) % primitive.points.length]!;
        twiceArea += current.x * next.y - next.x * current.y;
      }
      return Math.abs(twiceArea) / 2;
    }

    case "container":
      // Containers are structural envelopes; counting them would double-count descendants.
      return 0;
  }
}

export function intersectionBounds(left: Bounds, right: Bounds): Bounds | null {
  validateBounds(left, "left");
  validateBounds(right, "right");

  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  const width = maxX - x;
  const height = maxY - y;

  if (width <= EPSILON || height <= EPSILON) return null;
  return Object.freeze({ x, y, width, height });
}

function asBounds(value: GeometricPrimitive | Bounds): Bounds {
  return "bounds" in value ? value.bounds : value;
}

export function intersectionArea(left: GeometricPrimitive | Bounds, right: GeometricPrimitive | Bounds): number {
  const intersection = intersectionBounds(asBounds(left), asBounds(right));
  return intersection ? intersection.width * intersection.height : 0;
}

export function overlapRatio(left: GeometricPrimitive | Bounds, right: GeometricPrimitive | Bounds): number {
  const leftBounds = asBounds(left);
  const rightBounds = asBounds(right);
  const intersection = intersectionArea(leftBounds, rightBounds);
  const smallerArea = Math.min(
    leftBounds.width * leftBounds.height,
    rightBounds.width * rightBounds.height,
  );

  if (smallerArea <= EPSILON) return 0;
  return Math.min(1, intersection / smallerArea);
}

export function flattenPrimitives(primitives: readonly GeometricPrimitive[]): readonly GeometricPrimitive[] {
  const output: GeometricPrimitive[] = [];

  const visit = (primitive: GeometricPrimitive): void => {
    output.push(primitive);
    if (primitive.kind === "container") {
      for (const child of primitive.children) visit(child);
    }
  };

  for (const primitive of primitives) visit(primitive);
  return Object.freeze(output);
}

export function leafPrimitives(
  primitives: readonly GeometricPrimitive[],
): readonly Exclude<GeometricPrimitive, ContainerPrimitive>[] {
  const output: Exclude<GeometricPrimitive, ContainerPrimitive>[] = [];

  const visit = (primitive: GeometricPrimitive): void => {
    if (primitive.kind === "container") {
      for (const child of primitive.children) visit(child);
    } else {
      output.push(primitive);
    }
  };

  for (const primitive of primitives) visit(primitive);
  return Object.freeze(output);
}

export function clipBounds(bounds: Bounds, canvas: Bounds): Bounds | null {
  return intersectionBounds(bounds, canvas);
}

/** Exact union area for axis-aligned layout bounds using a deterministic X sweep. */
export function rectangleUnionArea(boundsList: readonly Bounds[]): number {
  const rectangles = boundsList.filter((bounds) => bounds.width > 0 && bounds.height > 0);
  if (rectangles.length === 0) return 0;
  for (const bounds of rectangles) validateBounds(bounds);

  const xs = [
    ...new Set(rectangles.flatMap((rectangle) => [rectangle.x, rectangle.x + rectangle.width])),
  ].sort((a, b) => a - b);

  let area = 0;

  for (let index = 0; index < xs.length - 1; index += 1) {
    const x0 = xs[index]!;
    const x1 = xs[index + 1]!;
    const width = x1 - x0;
    if (width <= EPSILON) continue;

    const intervals = rectangles
      .filter((rectangle) => rectangle.x < x1 && rectangle.x + rectangle.width > x0)
      .map((rectangle) => [rectangle.y, rectangle.y + rectangle.height] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    if (intervals.length === 0) continue;

    let coveredY = 0;
    let start = intervals[0]![0];
    let end = intervals[0]![1];

    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        coveredY += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }

    coveredY += end - start;
    area += width * coveredY;
  }

  return area;
}
