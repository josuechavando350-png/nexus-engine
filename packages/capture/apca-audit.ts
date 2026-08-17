import { createHash } from "node:crypto";
import { calcAPCA } from "apca-w3";
import type { Page } from "playwright";

export interface ApcaTextObservation {
  textDigest: string;
  role?: string;
  textColor: string;
  backgroundColor: string;
  backgroundSource: "ELEMENT_OR_ANCESTOR" | "UA_CANVAS_DEFAULT";
  fontSizePx: number;
  fontWeight: number;
  lc: number;
}

export interface ApcaAuditReport {
  schemaVersion: 1;
  algorithm: "APCA";
  library: "apca-w3";
  libraryVersion: "0.1.9";
  observations: readonly ApcaTextObservation[];
  unsupportedCount: number;
}

export interface ApcaPolicy {
  minimumAbsLcByRole: Readonly<Record<string, number>>;
}

export interface ApcaPolicyResult {
  verdict: "PASS" | "FAIL" | "NOT_TESTED";
  failures: readonly { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[];
}

function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text.trim()).digest("hex")}`;
}

function numericLc(value: number | string): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function measureApca(page: Page): Promise<ApcaAuditReport> {
  const candidates = await page.evaluate(() => {
    function alpha(color: string): number {
      const match = color.match(/rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/i);
      if (!match) return 1;
      return match[1] === undefined ? 1 : Number.parseFloat(match[1]);
    }
    function backgroundFor(element: Element): { color: string; source: "ELEMENT_OR_ANCESTOR" | "UA_CANVAS_DEFAULT" } {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color && alpha(color) > 0.001) return { color, source: "ELEMENT_OR_ANCESTOR" };
        current = current.parentElement;
      }
      return { color: "rgb(255, 255, 255)", source: "UA_CANVAS_DEFAULT" };
    }
    return Array.from(document.querySelectorAll("body *")).flatMap((element) => {
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!ownText) return [];
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return [];
      const background = backgroundFor(element);
      const weight = Number.parseInt(style.fontWeight, 10);
      return [{
        text: ownText,
        role: element.getAttribute("data-nexus-contrast-role") ?? undefined,
        textColor: style.color,
        backgroundColor: background.color,
        backgroundSource: background.source,
        fontSizePx: Number.parseFloat(style.fontSize),
        fontWeight: Number.isFinite(weight) ? weight : 400,
      }];
    });
  });

  const observations: ApcaTextObservation[] = [];
  let unsupportedCount = 0;
  for (const candidate of candidates) {
    const lc = numericLc(calcAPCA(candidate.textColor, candidate.backgroundColor));
    if (lc === undefined) {
      unsupportedCount += 1;
      continue;
    }
    observations.push(Object.freeze({
      textDigest: digestText(candidate.text),
      role: candidate.role,
      textColor: candidate.textColor,
      backgroundColor: candidate.backgroundColor,
      backgroundSource: candidate.backgroundSource,
      fontSizePx: candidate.fontSizePx,
      fontWeight: candidate.fontWeight,
      lc,
    }));
  }

  return Object.freeze({
    schemaVersion: 1,
    algorithm: "APCA",
    library: "apca-w3",
    libraryVersion: "0.1.9",
    observations: Object.freeze(observations),
    unsupportedCount,
  });
}

export function evaluateApcaPolicy(report: ApcaAuditReport, policy: ApcaPolicy): ApcaPolicyResult {
  const entries = Object.entries(policy.minimumAbsLcByRole);
  if (!entries.length) return Object.freeze({ verdict: "NOT_TESTED", failures: Object.freeze([]) });
  for (const [role, minimum] of entries) {
    if (!role.trim() || !Number.isFinite(minimum) || minimum <= 0) throw new Error("APCA policy requires non-empty roles and positive finite thresholds");
  }

  const failures: { role: string; actualAbsLc: number; minimumAbsLc: number; textDigest: string }[] = [];
  for (const [role, minimum] of entries) {
    const matching = report.observations.filter((observation) => observation.role === role);
    if (!matching.length) {
      failures.push({ role, actualAbsLc: 0, minimumAbsLc: minimum, textDigest: "MISSING_ROLE_EVIDENCE" });
      continue;
    }
    for (const observation of matching) {
      const actualAbsLc = Math.abs(observation.lc);
      if (actualAbsLc < minimum) failures.push({ role, actualAbsLc, minimumAbsLc: minimum, textDigest: observation.textDigest });
    }
  }
  return Object.freeze({ verdict: failures.length ? "FAIL" : "PASS", failures: Object.freeze(failures) });
}
