import StyleDictionary from "style-dictionary";
import { formats, transformGroups } from "style-dictionary/enums";
import type { ExperienceDNA } from "@nexus/experience/dna";

export type OklchAccent = Readonly<{
  lightness: number;
  chroma: number;
  hue: number;
}>;

export type EmitterInput = Readonly<{
  dna: ExperienceDNA;
  accent: OklchAccent;
}>;

export type EmitterOutput = Readonly<{
  css: string;
  tokenManifest: Readonly<Record<string, string>>;
}>;

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const mix = (min: number, max: number, t: number): number => min + (max - min) * clamp(t, 0, 1);

function assertAccent(accent: OklchAccent): void {
  if (!Number.isFinite(accent.lightness) || accent.lightness < 0 || accent.lightness > 1) throw new Error("accent.lightness must be in [0,1]");
  if (!Number.isFinite(accent.chroma) || accent.chroma < 0 || accent.chroma > 0.4) throw new Error("accent.chroma must be in [0,0.4]");
  if (!Number.isFinite(accent.hue) || accent.hue < 0 || accent.hue >= 360) throw new Error("accent.hue must be in [0,360)");
}

function oklch(lightness: number, chroma: number, hue: number): string {
  return `oklch(${round(clamp(lightness, 0, 1) * 100, 2)}% ${round(Math.max(0, chroma), 4)} ${round(hue, 2)})`;
}

function deriveManifest({ dna, accent }: EmitterInput): Record<string, string> {
  assertAccent(accent);

  const typeRatio = mix(1.2, 1.5, dna.typography.scaleContrast.value);
  const spacingRatio = mix(1.18, 1.42, (dna.density.whitespace.value + (1 - dna.density.compression.value)) / 2);
  const radiusBase = mix(18, 2, dna.geometry.angularity.value);
  const motionBaseMs = Math.round(mix(520, 180, dna.motion.intensity.value));
  const motionLongMs = Math.round(motionBaseMs * mix(1.35, 2.15, dna.motion.continuity.value));
  const containerNarrow = Math.round(mix(560, 720, dna.composition.gridDiscipline.value));
  const containerWide = Math.round(mix(1120, 1480, dna.media.dominance.value));

  const manifest: Record<string, string> = {};
  const put = (name: string, value: string) => { manifest[name] = value; };

  let type = 1;
  for (let i = 0; i < 6; i += 1) {
    put(`type-step-${i}`, `${round(type, 4)}rem`);
    type *= typeRatio;
  }

  let space = 0.25;
  for (let i = 0; i < 8; i += 1) {
    put(`space-${i}`, `${round(space, 4)}rem`);
    space *= spacingRatio;
  }

  put("radius-sm", `${round(radiusBase * 0.5, 2)}px`);
  put("radius-md", `${round(radiusBase, 2)}px`);
  put("radius-lg", `${round(radiusBase * 1.8, 2)}px`);
  put("motion-fast", `${Math.max(90, Math.round(motionBaseMs * 0.55))}ms`);
  put("motion-base", `${motionBaseMs}ms`);
  put("motion-long", `${motionLongMs}ms`);
  put("motion-ease-standard", `cubic-bezier(${round(mix(0.2, 0.12, dna.motion.continuity.value), 3)}, 0, ${round(mix(0.2, 0.05, dna.motion.intensity.value), 3)}, 1)`);
  put("container-narrow", `${containerNarrow}px`);
  put("container-wide", `${containerWide}px`);
  put("breakpoint-mobile", "390px");
  put("breakpoint-tablet", "768px");
  put("breakpoint-desktop", "1440px");

  const lightnessOffsets = [-0.42, -0.30, -0.18, -0.08, 0, 0.08, 0.16, 0.24, 0.32] as const;
  lightnessOffsets.forEach((offset, index) => {
    const distance = Math.abs(index - 4) / 4;
    put(`accent-${index + 1}00`, oklch(accent.lightness + offset, accent.chroma * (1 - distance * 0.38), accent.hue));
  });

  put("surface-0", oklch(mix(0.08, 0.98, 1 - dna.cinematicity.value), accent.chroma * 0.025, accent.hue));
  put("surface-1", oklch(mix(0.12, 0.94, 1 - dna.cinematicity.value), accent.chroma * 0.035, accent.hue));
  put("text-strong", oklch(dna.cinematicity.value > 0.5 ? 0.97 : 0.13, 0.01, accent.hue));
  put("text-muted", oklch(dna.cinematicity.value > 0.5 ? 0.74 : 0.42, 0.015, accent.hue));

  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, "en")));
}

function toStyleDictionaryTokens(manifest: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(manifest).map(([name, value]) => [name, { value }]));
}

export async function emitExperienceCss(input: EmitterInput): Promise<EmitterOutput> {
  const tokenManifest = deriveManifest(input);
  const sd = new StyleDictionary({
    tokens: { nexus: toStyleDictionaryTokens(tokenManifest) },
    platforms: {
      css: {
        transformGroup: transformGroups.css,
        prefix: "nexus",
        options: { showFileHeader: false },
        files: [{ format: formats.cssVariables }],
      },
    },
  });

  const outputs = await sd.formatPlatform("css");
  const output = outputs[0]?.output;
  if (typeof output !== "string") throw new Error("Style Dictionary did not produce CSS text");

  return Object.freeze({ css: output.replace(/\r\n/g, "\n"), tokenManifest: Object.freeze(tokenManifest) });
}

export const deriveExperienceTokenManifest = (input: EmitterInput): Readonly<Record<string, string>> => Object.freeze(deriveManifest(input));
