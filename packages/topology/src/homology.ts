import { digestValue } from "@nexus/visual-algebra";
import { simplexId, validateCanonicalFiltrationComplex } from "./complex.js";
import type { FiltrationComplex, FilteredSimplex, PersistenceDiagram, PersistenceInterval } from "./types.js";

const EPSILON = 1e-12;

function compareSimplex(left: FilteredSimplex, right: FilteredSimplex): number {
  return left.filtration - right.filtration || left.dimension - right.dimension || left.id.localeCompare(right.id);
}

function boundaryIds(simplex: FilteredSimplex): readonly string[] {
  if (simplex.dimension === 0) return [];
  return simplex.vertices.map((_vertex, removed) => simplexId(simplex.vertices.filter((_candidate, index) => index !== removed)));
}

function xorSortedColumns(left: readonly number[], right: readonly number[]): number[] {
  const output: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    if (b === undefined || (a !== undefined && a < b)) {
      output.push(a!);
      i += 1;
      continue;
    }
    if (a === undefined || b < a) {
      output.push(b);
      j += 1;
      continue;
    }
    i += 1;
    j += 1;
  }
  return output;
}

export function validateFiltrationComplex(complex: FiltrationComplex): void {
  validateCanonicalFiltrationComplex(complex);
}

function boundaryColumn(simplex: FilteredSimplex, indexBySimplexId: ReadonlyMap<string, number>): number[] {
  const rows = boundaryIds(simplex).map((faceId) => {
    const index = indexBySimplexId.get(faceId);
    if (index === undefined) throw new Error(`Complex is missing simplex face ${faceId}`);
    return index;
  });
  rows.sort((a, b) => a - b);
  return rows;
}

function interval(birth: FilteredSimplex, death?: FilteredSimplex): PersistenceInterval | null {
  if (birth.dimension !== 0 && birth.dimension !== 1) return null;
  if (!death) {
    return Object.freeze({
      dimension: birth.dimension,
      birth: birth.filtration,
      death: null,
      birthSimplexId: birth.id,
      persistence: null,
    });
  }
  return Object.freeze({
    dimension: birth.dimension,
    birth: birth.filtration,
    death: death.filtration,
    birthSimplexId: birth.id,
    deathSimplexId: death.id,
    persistence: Math.max(0, death.filtration - birth.filtration),
  });
}

function compareIntervals(left: PersistenceInterval, right: PersistenceInterval): number {
  if (left.dimension !== right.dimension) return left.dimension - right.dimension;
  if (left.birth !== right.birth) return left.birth - right.birth;
  if (left.death === null && right.death !== null) return 1;
  if (left.death !== null && right.death === null) return -1;
  if (left.death !== null && right.death !== null && left.death !== right.death) return left.death - right.death;
  return left.birthSimplexId.localeCompare(right.birthSimplexId);
}

export function validatePersistenceDiagram(diagram: PersistenceDiagram): void {
  if (diagram.authority !== "NEXUS_PERSISTENCE_DIAGRAM_V1") throw new Error("Unsupported persistence diagram authority");
  if (diagram.maxDimension !== 0 && diagram.maxDimension !== 1) throw new Error("Persistence diagram maxDimension must be 0 or 1");
  if (!/^[a-f0-9]{64}$/.test(diagram.sourceComplexDigest)) throw new Error("Persistence diagram sourceComplexDigest must be SHA-256 hex");
  if (!Number.isFinite(diagram.filtrationLimit) || diagram.filtrationLimit < 0 || diagram.filtrationLimit > 1) {
    throw new Error("Persistence diagram filtrationLimit must be in [0,1]");
  }
  if (!Array.isArray(diagram.intervals)) throw new Error("Persistence diagram intervals must be an array");

  for (const item of diagram.intervals) {
    if ((item.dimension !== 0 && item.dimension !== 1) || item.dimension > diagram.maxDimension) {
      throw new Error("Persistence interval dimension exceeds diagram support");
    }
    if (!item.birthSimplexId || item.birthSimplexId !== item.birthSimplexId.trim()) {
      throw new Error("Persistence interval birth simplex id is invalid");
    }
    if (!Number.isFinite(item.birth) || item.birth < 0 || item.birth > diagram.filtrationLimit + EPSILON) {
      throw new Error("Persistence interval birth is invalid");
    }
    if (item.death !== null && (!Number.isFinite(item.death) || item.death < item.birth || item.death > diagram.filtrationLimit + EPSILON)) {
      throw new Error("Persistence interval death is invalid");
    }
    if (item.death === null && item.deathSimplexId !== undefined) {
      throw new Error("Essential persistence interval cannot have a death simplex id");
    }
    if (item.death !== null && (!item.deathSimplexId || item.deathSimplexId !== item.deathSimplexId.trim())) {
      throw new Error("Finite persistence interval requires a death simplex id");
    }

    const expectedPersistence = item.death === null ? null : Math.max(0, item.death - item.birth);
    if (
      expectedPersistence === null
        ? item.persistence !== null
        : item.persistence === null || Math.abs(item.persistence - expectedPersistence) > EPSILON
    ) {
      throw new Error("Persistence interval lifetime mismatch");
    }
  }

  const canonicalIntervals = [...diagram.intervals].sort(compareIntervals);
  if (digestValue(canonicalIntervals) !== digestValue(diagram.intervals)) {
    throw new Error("Persistence diagram intervals are not in canonical order");
  }

  const { digest, ...digestPayload } = diagram;
  if (!/^[a-f0-9]{64}$/.test(digest) || digestValue(digestPayload) !== digest) {
    throw new Error("Persistence diagram digest mismatch");
  }
}

export function computePersistentHomology(complex: FiltrationComplex): PersistenceDiagram {
  validateFiltrationComplex(complex);
  const simplices = [...complex.simplices].sort(compareSimplex);
  const indexBySimplexId = new Map<string, number>();
  simplices.forEach((simplex, index) => indexBySimplexId.set(simplex.id, index));

  const reducedColumns: number[][] = [];
  const lowToColumn = new Map<number, number>();
  const births = new Set<number>();
  const pairedBirths = new Set<number>();
  const intervals: PersistenceInterval[] = [];

  for (let columnIndex = 0; columnIndex < simplices.length; columnIndex += 1) {
    const simplex = simplices[columnIndex]!;
    let column = boundaryColumn(simplex, indexBySimplexId);
    while (column.length > 0) {
      const pivot = column[column.length - 1]!;
      const reducer = lowToColumn.get(pivot);
      if (reducer === undefined) break;
      column = xorSortedColumns(column, reducedColumns[reducer]!);
    }

    reducedColumns[columnIndex] = column;
    if (column.length === 0) {
      births.add(columnIndex);
      continue;
    }

    const pivot = column[column.length - 1]!;
    if (!births.has(pivot)) {
      throw new Error(`Invalid persistence pairing: simplex ${simplices[pivot]!.id} did not create a class`);
    }
    lowToColumn.set(pivot, columnIndex);
    pairedBirths.add(pivot);
    const birth = simplices[pivot]!;
    if (birth.dimension <= complex.maxHomologyDimension) {
      const item = interval(birth, simplex);
      if (item) intervals.push(item);
    }
  }

  for (const birthIndex of births) {
    if (pairedBirths.has(birthIndex)) continue;
    const birth = simplices[birthIndex]!;
    if (birth.dimension > complex.maxHomologyDimension) continue;
    const item = interval(birth);
    if (item) intervals.push(item);
  }

  intervals.sort(compareIntervals);
  const base = {
    authority: "NEXUS_PERSISTENCE_DIAGRAM_V1" as const,
    sourceComplexDigest: complex.digest,
    maxDimension: complex.maxHomologyDimension,
    filtrationLimit: complex.maxFiltration,
    intervals: Object.freeze(intervals),
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}
