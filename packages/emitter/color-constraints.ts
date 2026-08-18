import { createHash } from "node:crypto";
import type { EngineConstraint } from "@nexus/experience";
import type { ExperienceDNA } from "@nexus/experience/dna";
import type { EmitterInput, OklchAccent, SurfaceTone } from "./index";

export type ForbiddenHueRange = Readonly<{ name: string; min: number; max: number; evidence: string }>;

export type ColorConstraintResolution = Readonly<{
  authority: "NEXUS_COLOR_CONSTRAINT_RESOLVER_V1";
  accent: OklchAccent;
  surfaceTone: SurfaceTone;
  forbiddenHueRanges: readonly ForbiddenHueRange[];
  evidence: readonly string[];
}>;

const normalize = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const hueInRange = (hue: number, min: number, max: number): boolean => min <= max ? hue >= min && hue <= max : hue >= min || hue <= max;

const COLOR_HUES: Readonly<Record<string, number>> = Object.freeze({
  red: 28, rojo: 28,
  orange: 55, naranja: 55,
  gold: 85, golden: 85, dorado: 85,
  yellow: 100, amarillo: 100,
  green: 145, verde: 145,
  cyan: 195,
  blue: 250, azul: 250,
  purple: 305, morado: 305, violeta: 305,
  pink: 350, rosa: 350,
});

const FORBIDDEN_RANGES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  red: [5, 42], rojo: [5, 42],
  orange: [42, 70], naranja: [42, 70],
  gold: [60, 105], golden: [60, 105], dorado: [60, 105],
  yellow: [92, 122], amarillo: [92, 122],
  green: [120, 175], verde: [120, 175],
  cyan: [175, 220],
  blue: [220, 285], azul: [220, 285],
  purple: [285, 335], morado: [285, 335], violeta: [285, 335],
  pink: [335, 4], rosa: [335, 4],
});

function deterministicHue(seed: string): number {
  if (!seed.trim()) throw new Error("color constraint resolution requires a non-empty projectSeed");
  const digest = createHash("sha256").update(seed).digest();
  return Number((((digest.readUInt16BE(0) / 65535) * 360) % 360).toFixed(2));
}

function forbiddenRanges(statements: readonly string[]): readonly ForbiddenHueRange[] {
  const ranges: ForbiddenHueRange[] = [];
  for (const statement of statements) {
    const text = normalize(statement);
    const negative = /\b(no|not|without|avoid|forbid|forbidden|exclude|never|sin|evitar|prohibid[oa]|nunca)\b/.test(text);
    if (!negative) continue;
    for (const [name, [min, max]] of Object.entries(FORBIDDEN_RANGES)) {
      if (text.includes(name)) ranges.push(Object.freeze({ name, min, max, evidence: statement }));
    }
  }
  const byRange = new Map<string, ForbiddenHueRange>();
  for (const range of ranges) byRange.set(`${range.min}:${range.max}`, range);
  return Object.freeze([...byRange.values()]);
}

function requestedHue(statements: readonly string[]): number | undefined {
  for (const statement of statements) {
    const text = normalize(statement);
    if (/\b(no|not|without|avoid|forbid|forbidden|exclude|never|sin|evitar|prohibid[oa]|nunca)\b/.test(text)) continue;
    for (const [name, hue] of Object.entries(COLOR_HUES)) if (text.includes(name)) return hue;
  }
  return undefined;
}

function moveOutsideForbidden(hue: number, ranges: readonly ForbiddenHueRange[]): number {
  let resolved = hue;
  for (let attempts = 0; attempts < 12; attempts += 1) {
    const blocking = ranges.find((range) => hueInRange(resolved, range.min, range.max));
    if (!blocking) return Number(resolved.toFixed(2));
    resolved = (blocking.max + 37 + attempts * 17) % 360;
  }
  throw new Error("Unable to derive an accent hue outside explicit forbidden ranges.");
}

function explicitNeutral(statements: readonly string[]): boolean {
  return statements.some((statement) => /\b(gray|grey|gris|neutral|monochrome|monocrom)\w*\b/.test(normalize(statement)));
}

function resolveSurfaceTone(statements: readonly string[]): SurfaceTone {
  const normalized = statements.map(normalize);
  const light = normalized.some((statement) => /\b(white|blanco|light|claro|bright|luminos)\w*\b/.test(statement));
  const dark = normalized.some((statement) => /\b(black|negro|dark|oscuro)\w*\b/.test(statement));
  if (light && !dark) return "light";
  if (dark && !light) return "dark";
  return "dna";
}

export function resolveColorConstraints(input: {
  constraints: readonly (EngineConstraint | string)[];
  projectSeed: string;
}): ColorConstraintResolution {
  const statements = input.constraints.map((constraint) => typeof constraint === "string" ? constraint : constraint.statement).map((statement) => statement.trim()).filter(Boolean);
  if (!statements.length) throw new Error("color constraint resolution requires at least one explicit project constraint");
  const ranges = forbiddenRanges(statements);
  const neutral = explicitNeutral(statements);
  const requested = requestedHue(statements);
  const baseHue = requested ?? deterministicHue(input.projectSeed);
  const hue = moveOutsideForbidden(baseHue, ranges);
  const surfaceTone = resolveSurfaceTone(statements);
  const accent: OklchAccent = Object.freeze({
    lightness: neutral ? 0.56 : surfaceTone === "dark" ? 0.68 : 0.58,
    chroma: neutral ? 0.012 : 0.09,
    hue,
  });
  return Object.freeze({
    authority: "NEXUS_COLOR_CONSTRAINT_RESOLVER_V1",
    accent,
    surfaceTone,
    forbiddenHueRanges: ranges,
    evidence: Object.freeze(statements),
  });
}

export function deriveConstrainedEmitterInput(input: {
  dna: ExperienceDNA;
  constraints: readonly (EngineConstraint | string)[];
  projectSeed: string;
}): EmitterInput {
  const resolved = resolveColorConstraints({ constraints: input.constraints, projectSeed: input.projectSeed });
  return Object.freeze({ dna: input.dna, accent: resolved.accent, surfaceTone: resolved.surfaceTone });
}
