import type { Page } from "playwright";

export type GeometryViolationId = "TEXT_OVERLAP" | "SECTION_ESCAPE" | "VISUAL_OVER_TEXT" | "TEXT_CLIPPED" | "FORBIDDEN_TYPOGRAPHY_MIX" | "IDENTICAL_COLUMNS_FORBIDDEN" | "FOCUS_TREATMENT_MISSING";
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type GeometricDesignDna = Readonly<{ schemaVersion: 1; projectId: string; typography: Readonly<{ forbiddenFamilyMixes: readonly (readonly [string, string])[] }>; composition: Readonly<{ identicalColumnsAllowed: boolean }>; accessibility: Readonly<{ focusTreatment: string }> }>;
export type GeometryElement = Readonly<{ id: string; kind: "TEXT" | "VISUAL" | "SECTION"; rect: Rect; sectionId?: string; clipped?: boolean; fontFamily?: string; columnGroup?: string }>;
export type GeometrySnapshot = Readonly<{ elements: readonly GeometryElement[]; declaredFocusTreatment?: string }>;
export type GeometryViolation = Readonly<{ id: GeometryViolationId; elements: readonly string[]; detail: string }>;
export type GeometryReport = Readonly<{ authority: "NEXUS_GEOMETRIC_COMPARATOR_V1"; projectId: string; verdict: "PASS" | "FAIL"; violations: readonly GeometryViolation[] }>;

const intersectionArea = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const contains = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const normalizedFamily = (value: string): string => value.replace(/["']/g, "").split(",")[0]!.trim().toLowerCase();

export function compareGeometry(snapshot: GeometrySnapshot, dna: GeometricDesignDna): GeometryReport {
  if (dna.schemaVersion !== 1 || !dna.projectId.trim()) throw new Error("structured Design DNA is required");
  const violations: GeometryViolation[] = [];
  const sections = new Map(snapshot.elements.filter((item) => item.kind === "SECTION").map((item) => [item.id, item]));
  const text = snapshot.elements.filter((item) => item.kind === "TEXT");
  const visuals = snapshot.elements.filter((item) => item.kind === "VISUAL");
  for (let left = 0; left < text.length; left += 1) for (let right = left + 1; right < text.length; right += 1) if (intersectionArea(text[left]!.rect, text[right]!.rect) > 0) violations.push({ id: "TEXT_OVERLAP", elements: [text[left]!.id, text[right]!.id], detail: "text boxes intersect" });
  for (const element of [...text, ...visuals]) { const section = element.sectionId ? sections.get(element.sectionId) : undefined; if (section && !contains(section.rect, element.rect)) violations.push({ id: "SECTION_ESCAPE", elements: [element.id, section.id], detail: "element exceeds its declared section bounds" }); }
  for (const visual of visuals) for (const item of text) if (intersectionArea(visual.rect, item.rect) > 0) violations.push({ id: "VISUAL_OVER_TEXT", elements: [visual.id, item.id], detail: "visual intersects text" });
  for (const item of text) if (item.clipped) violations.push({ id: "TEXT_CLIPPED", elements: [item.id], detail: "text scroll dimensions exceed its clipped box" });
  const observedFamilies = new Set(text.map((item) => item.fontFamily).filter((value): value is string => Boolean(value)).map(normalizedFamily));
  for (const [first, second] of dna.typography.forbiddenFamilyMixes) if (observedFamilies.has(normalizedFamily(first)) && observedFamilies.has(normalizedFamily(second))) violations.push({ id: "FORBIDDEN_TYPOGRAPHY_MIX", elements: [], detail: `Design DNA forbids ${first} + ${second}` });
  if (!dna.composition.identicalColumnsAllowed) { const groups = new Map<string, GeometryElement[]>(); for (const element of snapshot.elements) if (element.columnGroup) groups.set(element.columnGroup, [...(groups.get(element.columnGroup) ?? []), element]); for (const [group, columns] of groups) if (columns.length > 1 && columns.every((item) => Math.abs(item.rect.width - columns[0]!.rect.width) < 0.5)) violations.push({ id: "IDENTICAL_COLUMNS_FORBIDDEN", elements: columns.map((item) => item.id), detail: `Design DNA forbids identical columns in ${group}` }); }
  if (snapshot.declaredFocusTreatment !== dna.accessibility.focusTreatment) violations.push({ id: "FOCUS_TREATMENT_MISSING", elements: [], detail: `expected declared focus treatment ${dna.accessibility.focusTreatment}` });
  return Object.freeze({ authority: "NEXUS_GEOMETRIC_COMPARATOR_V1", projectId: dna.projectId, verdict: violations.length ? "FAIL" : "PASS", violations: Object.freeze(violations) });
}

export async function captureGeometrySnapshot(page: Page): Promise<GeometrySnapshot> {
  return page.evaluate(() => ({
    elements: [...document.querySelectorAll<HTMLElement>("[data-nexus-geometry-id]")].map((element) => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); const kind = element.dataset.nexusGeometryKind as "TEXT" | "VISUAL" | "SECTION";
      const clips = ["hidden", "clip"].includes(style.overflow) || ["hidden", "clip"].includes(style.overflowX) || ["hidden", "clip"].includes(style.overflowY);
      return { id: element.dataset.nexusGeometryId!, kind, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, sectionId: element.dataset.nexusSection, clipped: kind === "TEXT" && clips && (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight), fontFamily: kind === "TEXT" ? style.fontFamily : undefined, columnGroup: element.dataset.nexusColumnGroup };
    }),
    declaredFocusTreatment: document.documentElement.dataset.nexusFocusTreatment,
  }));
}
