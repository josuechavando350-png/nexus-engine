import { createHash } from "node:crypto";
import { calcAPCA, fontLookupAPCA } from "apca-w3";
import sharp from "sharp";
import type { Page } from "playwright";

export type ApcaUse = "BODY" | "FLUENT" | "SUBFLUENT" | "SPOT";

export interface ApcaTextObservation {
  textDigest: string;
  role?: string;
  use: ApcaUse;
  textColor: string;
  backgroundColor: string;
  backgroundSource: "RENDERED_PIXEL_SAMPLE";
  fontSizePx: number;
  fontWeight: number;
  lc: number;
  absoluteLc: number;
  requiredAbsLc: number | null;
  sampleCount: number;
  textShadow: boolean;
  digest: string;
}

export interface ApcaUnsupportedObservation {
  textDigest: string;
  role?: string;
  reason:
    | "MIX_BLEND_MODE"
    | "FILTER_EFFECT"
    | "GROUP_OPACITY"
    | "TEXT_STROKE"
    | "GRADIENT_TEXT"
    | "SVG_TEXT"
    | "TRANSLUCENT_TEXT"
    | "UNSUPPORTED_COLOR"
    | "NO_SAMPLE_POINTS";
}

export interface ApcaAuditReport {
  schemaVersion: 2;
  algorithm: "APCA";
  library: "apca-w3";
  libraryVersion: "0.1.9";
  observations: readonly ApcaTextObservation[];
  unsupported: readonly ApcaUnsupportedObservation[];
  unsupportedCount: number;
  coverage: number;
  digest: string;
}

export interface ApcaPolicy {
  minimumAbsLcByRole: Readonly<Record<string, number>>;
}

export interface ApcaPolicyResult {
  verdict: "PASS" | "FAIL" | "NOT_TESTED";
  failures: readonly { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[];
  digest: string;
}

export interface DynamicApcaPolicyResult {
  verdict: "PASS" | "FAIL" | "NOT_TESTED";
  failures: readonly { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[];
  unsupported: readonly ApcaUnsupportedObservation[];
  digest: string;
}

interface Candidate {
  marker: string;
  previousMarker: string | null;
  text: string;
  role?: string;
  use: ApcaUse;
  textColor: string;
  textRgb: readonly [number, number, number];
  fontSizePx: number;
  fontWeight: number;
  textShadow: boolean;
  rects: readonly { x: number; y: number; width: number; height: number }[];
  unsupported?: ApcaUnsupportedObservation["reason"];
}

const MAX_CANDIDATES = 512;
const MAX_RECTS_PER_TEXT = 32;
const MAX_SAMPLES_PER_TEXT = 96;
const MAX_SCREENSHOT_PIXELS = 100_000_000;

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("APCA canonical data must contain only finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("APCA canonical data must be plain objects");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      output[key] = canonical(item);
    }
    return output;
  }
  throw new Error(`unsupported APCA canonical type: ${typeof value}`);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text.trim()).digest("hex")}`;
}

function numericLc(value: number | string): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function apcaWeightBucket(weight: number): number {
  if (!Number.isFinite(weight)) return 400;
  return Math.max(100, Math.min(900, Math.floor(weight / 100) * 100));
}

function decodeFontLookup(value: number | string | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 600) return null;
  if (numeric >= 500) return numeric - 500;
  if (numeric >= 400) return numeric - 400;
  return numeric;
}

export function minimumApcaLc(fontSizePx: number, fontWeight: number, use: ApcaUse): number | null {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return null;
  const lookupIndex = apcaWeightBucket(fontWeight) / 100;
  let baseline: number | null = null;
  for (let lc = 30; lc <= 100; lc += 0.5) {
    const table = fontLookupAPCA(lc, 2);
    const minimumSize = decodeFontLookup(table[lookupIndex]);
    if (minimumSize !== null && fontSizePx >= minimumSize) {
      baseline = lc;
      break;
    }
  }
  if (baseline === null) return null;
  if (use === "BODY") return baseline < 75 ? Math.min(100, baseline + 15) : baseline;
  if (use === "SUBFLUENT") return Math.max(30, baseline - 15);
  if (use === "SPOT") return Math.max(30, baseline - 25);
  return baseline;
}

function samplePoints(rects: Candidate["rects"], imageWidth: number, imageHeight: number): readonly [number, number][] {
  const points: [number, number][] = [];
  for (const rect of rects.slice(0, MAX_RECTS_PER_TEXT)) {
    const columns = Math.max(2, Math.min(16, Math.ceil(rect.width / 40)));
    const rows = Math.max(2, Math.min(8, Math.ceil(rect.height / 18)));
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (points.length >= MAX_SAMPLES_PER_TEXT) return points;
        const x = Math.floor(rect.x + ((column + 0.5) * rect.width) / columns);
        const y = Math.floor(rect.y + ((row + 0.5) * rect.height) / rows);
        if (x >= 0 && y >= 0 && x < imageWidth && y < imageHeight) points.push([x, y]);
      }
    }
  }
  return points;
}

function useFromRole(role: string): ApcaUse {
  if (role === "BODY") return "BODY";
  if (role === "HEADING") return "FLUENT";
  if (role === "CONTROL" || role === "LABEL") return "SUBFLUENT";
  return "BODY";
}

export async function measureApca(page: Page): Promise<ApcaAuditReport> {
  await page.evaluate(async () => { await document.fonts?.ready; });
  const candidates = await page.evaluate((maximumCandidates) => {
    const colorTuple = (color: string): { rgb?: [number, number, number]; alpha: number } => {
      const values = color.match(/[\d.]+/g)?.map(Number) ?? [];
      if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) return { alpha: 0 };
      return { rgb: [values[0]!, values[1]!, values[2]!], alpha: values[3] ?? 1 };
    };
    const effectReason = (element: Element): string | undefined => {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (style.mixBlendMode !== "normal") return "MIX_BLEND_MODE";
        if (style.filter !== "none" || style.backdropFilter !== "none") return "FILTER_EFFECT";
        if (Number.parseFloat(style.opacity || "1") < 0.999) return "GROUP_OPACITY";
        if (current === document.body) break;
        current = current.parentElement;
      }
      return undefined;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const output: Array<Record<string, unknown>> = [];
    const markers = new Map<Element, { marker: string; previousMarker: string | null }>();
    let node: Node | null;
    let index = 0;
    const restoreMarkers = () => {
      for (const [element, state] of markers) {
        if (state.previousMarker === null) element.removeAttribute("data-nexus-apca-sample");
        else element.setAttribute("data-nexus-apca-sample", state.previousMarker);
      }
    };
    while ((node = walker.nextNode())) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      const element = node.parentElement;
      if (!text || !element) continue;
      const style = getComputedStyle(element);
      const elementRect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || elementRect.width <= 0 || elementRect.height <= 0) continue;
      if (output.length >= maximumCandidates) {
        restoreMarkers();
        throw new Error(`APCA candidate bound exceeded (${maximumCandidates})`);
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).slice(0, 32).map((rect) => ({
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      })).filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) continue;
      let markerState = markers.get(element);
      if (!markerState) {
        let marker = `nexus-apca-${index++}`;
        while (document.querySelector(`[data-nexus-apca-sample="${marker}"]`)) marker = `nexus-apca-${index++}`;
        markerState = { marker, previousMarker: element.getAttribute("data-nexus-apca-sample") };
        markers.set(element, markerState);
        element.setAttribute("data-nexus-apca-sample", marker);
      }
      const parsedColor = colorTuple(style.color);
      const role = element.getAttribute("data-nexus-contrast-role") ?? (element.closest("h1,h2,h3,h4,h5,h6") ? "HEADING" : element.closest("button,a,input,textarea,select") ? "CONTROL" : element.closest("label") ? "LABEL" : "BODY");
      const webkitTextStrokeWidth = Number.parseFloat(style.getPropertyValue("-webkit-text-stroke-width") || "0");
      const backgroundClip = `${style.backgroundClip} ${style.getPropertyValue("-webkit-background-clip")}`;
      let unsupported: string | undefined;
      if (element.closest("svg")) unsupported = "SVG_TEXT";
      else unsupported = effectReason(element);
      if (!unsupported && Number.isFinite(webkitTextStrokeWidth) && webkitTextStrokeWidth > 0.01) unsupported = "TEXT_STROKE";
      else if (!unsupported && /text/i.test(backgroundClip)) unsupported = "GRADIENT_TEXT";
      else if (!unsupported && !parsedColor.rgb) unsupported = "UNSUPPORTED_COLOR";
      else if (!unsupported && parsedColor.alpha < 0.999) unsupported = "TRANSLUCENT_TEXT";
      output.push({
        marker: markerState.marker,
        previousMarker: markerState.previousMarker,
        text,
        role,
        use: role === "BODY" ? "BODY" : role === "HEADING" ? "FLUENT" : role === "CONTROL" || role === "LABEL" ? "SUBFLUENT" : "BODY",
        textColor: style.color,
        textRgb: parsedColor.rgb ?? [0, 0, 0],
        fontSizePx: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight) || 400,
        textShadow: style.textShadow !== "none",
        rects,
        unsupported,
      });
    }
    return output;
  }, MAX_CANDIDATES) as unknown as Candidate[];

  const supported = candidates.filter((candidate) => !candidate.unsupported);
  const markerStates = [...new Map(candidates.map((candidate) => [candidate.marker, candidate.previousMarker])).entries()];
  let styleHandle: Awaited<ReturnType<Page["addStyleTag"]>> | undefined;
  let screenshot: Buffer;
  try {
    if (supported.length) {
      const selectors = [...new Set(supported.map((candidate) => candidate.marker))].map((marker) => `[data-nexus-apca-sample="${marker}"]`).join(",");
      styleHandle = await page.addStyleTag({ content: `${selectors}{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}` });
    }
    screenshot = await page.screenshot({ type: "png", fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
  } finally {
    if (styleHandle) await styleHandle.evaluate((node) => node.parentNode?.removeChild(node)).catch(() => undefined);
    await page.evaluate((states) => {
      for (const [marker, previousMarker] of states) {
        const element = document.querySelector(`[data-nexus-apca-sample="${marker}"]`);
        if (!element) continue;
        if (previousMarker === null) element.removeAttribute("data-nexus-apca-sample");
        else element.setAttribute("data-nexus-apca-sample", previousMarker);
      }
    }, markerStates).catch(() => undefined);
  }

  const decoded = await sharp(screenshot, { limitInputPixels: MAX_SCREENSHOT_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const observations: ApcaTextObservation[] = [];
  const unsupported: ApcaUnsupportedObservation[] = candidates.filter((candidate) => candidate.unsupported).map((candidate) => Object.freeze({
    textDigest: digestText(candidate.text), role: candidate.role, reason: candidate.unsupported!,
  }));

  for (const candidate of supported) {
    const points = samplePoints(candidate.rects, decoded.info.width, decoded.info.height);
    if (!points.length) {
      unsupported.push(Object.freeze({ textDigest: digestText(candidate.text), role: candidate.role, reason: "NO_SAMPLE_POINTS" }));
      continue;
    }
    let worstLc: number | undefined;
    let worstBackground = "";
    for (const [x, y] of points) {
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      const background: [number, number, number] = [decoded.data[offset]!, decoded.data[offset + 1]!, decoded.data[offset + 2]!];
      const lc = numericLc(calcAPCA(candidate.textRgb, background));
      if (lc === undefined) continue;
      if (worstLc === undefined || Math.abs(lc) < Math.abs(worstLc)) {
        worstLc = lc;
        worstBackground = `rgb(${background[0]}, ${background[1]}, ${background[2]})`;
      }
    }
    if (worstLc === undefined) {
      unsupported.push(Object.freeze({ textDigest: digestText(candidate.text), role: candidate.role, reason: "UNSUPPORTED_COLOR" }));
      continue;
    }
    const requiredAbsLc = minimumApcaLc(candidate.fontSizePx, candidate.fontWeight, candidate.use ?? useFromRole(candidate.role ?? "BODY"));
    const core = {
      textDigest: digestText(candidate.text), role: candidate.role, use: candidate.use,
      textColor: candidate.textColor, backgroundColor: worstBackground, backgroundSource: "RENDERED_PIXEL_SAMPLE" as const,
      fontSizePx: candidate.fontSizePx, fontWeight: candidate.fontWeight, lc: worstLc, absoluteLc: Math.abs(worstLc), requiredAbsLc,
      sampleCount: points.length, textShadow: candidate.textShadow,
    };
    observations.push(Object.freeze({ ...core, digest: digest(core) }));
  }

  const total = observations.length + unsupported.length;
  const core = {
    schemaVersion: 2 as const,
    algorithm: "APCA" as const,
    library: "apca-w3" as const,
    libraryVersion: "0.1.9" as const,
    observations: Object.freeze(observations),
    unsupported: Object.freeze(unsupported),
    unsupportedCount: unsupported.length,
    coverage: total ? observations.length / total : 0,
  };
  return Object.freeze({ ...core, digest: digest(core) });
}

export function evaluateApcaPolicy(report: ApcaAuditReport, policy: ApcaPolicy): ApcaPolicyResult {
  const entries = Object.entries(policy.minimumAbsLcByRole);
  if (!entries.length) {
    const core = { verdict: "NOT_TESTED" as const, failures: Object.freeze([]) };
    return Object.freeze({ ...core, digest: digest(core) });
  }
  for (const [role, minimum] of entries) {
    if (!role.trim() || !Number.isFinite(minimum) || minimum <= 0) throw new Error("APCA policy requires non-empty roles and positive finite thresholds");
  }
  const failures: { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[] = [];
  for (const [role, minimum] of entries) {
    const unsupportedForRole = report.unsupported.filter((observation) => observation.role === role);
    for (const item of unsupportedForRole) failures.push({ role, actualAbsLc: 0, minimumAbsLc: minimum, textDigest: `${item.reason}:${item.textDigest}` });
    const matching = report.observations.filter((observation) => observation.role === role);
    if (!matching.length && !unsupportedForRole.length) failures.push({ role, actualAbsLc: 0, minimumAbsLc: minimum, textDigest: "MISSING_ROLE_EVIDENCE" });
    for (const observation of matching) if (observation.absoluteLc < minimum) failures.push({ role, actualAbsLc: observation.absoluteLc, minimumAbsLc: minimum, textDigest: observation.textDigest });
  }
  const core = { verdict: (failures.length ? "FAIL" : "PASS") as "PASS" | "FAIL", failures: Object.freeze(failures) };
  return Object.freeze({ ...core, digest: digest(core) });
}

export function evaluateDynamicApcaPolicy(report: ApcaAuditReport, requiredRoles: readonly string[] = []): DynamicApcaPolicyResult {
  if (!report.observations.length && !report.unsupported.length) {
    const core = { verdict: "NOT_TESTED" as const, failures: Object.freeze([]), unsupported: report.unsupported };
    return Object.freeze({ ...core, digest: digest(core) });
  }
  const failures: { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[] = [];
  const roleSet = new Set(requiredRoles.map((role) => role.trim()).filter(Boolean));
  for (const role of roleSet) {
    const hasEvidence = report.observations.some((item) => item.role === role) || report.unsupported.some((item) => item.role === role);
    if (!hasEvidence) failures.push({ role, actualAbsLc: 0, minimumAbsLc: 0, textDigest: "MISSING_ROLE_EVIDENCE" });
  }
  for (const observation of report.observations) {
    if (observation.requiredAbsLc === null) {
      failures.push({ role: observation.role ?? "UNCLASSIFIED", actualAbsLc: observation.absoluteLc, minimumAbsLc: 100, textDigest: `NO_FONT_GUIDANCE:${observation.textDigest}` });
    } else if (observation.absoluteLc < observation.requiredAbsLc) {
      failures.push({ role: observation.role ?? "UNCLASSIFIED", actualAbsLc: observation.absoluteLc, minimumAbsLc: observation.requiredAbsLc, textDigest: observation.textDigest });
    }
  }
  const core = {
    verdict: (failures.length || report.unsupported.length ? "FAIL" : "PASS") as "PASS" | "FAIL",
    failures: Object.freeze(failures), unsupported: report.unsupported,
  };
  return Object.freeze({ ...core, digest: digest(core) });
}
