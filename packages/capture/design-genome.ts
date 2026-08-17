import type { Page } from "playwright";

export interface DesignGenomeObservation {
  schemaVersion: 1;
  viewport: Readonly<{ width: number; height: number }>;
  visibleElementCount: number;
  layout: Readonly<{
    gridElementCount: number;
    flexElementCount: number;
    centeredElementRatio: number;
    viewportOccupancyRatio: number;
    horizontalOffsetMean: number;
  }>;
  typography: Readonly<{
    fontSizePx: readonly number[];
    fontWeight: readonly number[];
    lineHeightRatio: readonly number[];
    familyCount: number;
  }>;
  geometry: Readonly<{
    borderRadiusPx: readonly number[];
    aspectRatios: readonly number[];
  }>;
  media: Readonly<{
    imageCount: number;
    videoCount: number;
    mediaAreaRatio: number;
  }>;
  rhythm: Readonly<{
    landmarkHeightsPx: readonly number[];
    landmarkGapPx: readonly number[];
  }>;
  motion: Readonly<{
    animatedElementCount: number;
    transitionDurationMs: readonly number[];
    animationDurationMs: readonly number[];
  }>;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

export async function extractDesignGenome(page: Page): Promise<DesignGenomeObservation> {
  return page.evaluate(() => {
    const roundBrowser = (value: number, digits = 4): number => Number(value.toFixed(digits));
    const parsePx = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const parseDurations = (value: string): number[] => value.split(",").map((part) => {
      const trimmed = part.trim();
      const parsed = Number.parseFloat(trimmed);
      if (!Number.isFinite(parsed)) return 0;
      return trimmed.endsWith("ms") ? parsed : parsed * 1000;
    });
    const quantized = (values: number[], limit = 12): number[] => {
      const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
      if (sorted.length <= limit) return sorted.map((value) => roundBrowser(value, 3));
      return Array.from({ length: limit }, (_, index) => {
        const position = index * (sorted.length - 1) / (limit - 1);
        return roundBrowser(sorted[Math.round(position)] ?? 0, 3);
      });
    };

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportArea = Math.max(1, viewportWidth * viewportHeight);
    const nodes = [...document.querySelectorAll<HTMLElement>("body *")];
    const visible = nodes.map((element) => ({ element, rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(({ rect, style }) => rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number.parseFloat(style.opacity || "1") > 0);

    let gridElementCount = 0;
    let flexElementCount = 0;
    let centeredCount = 0;
    let occupiedArea = 0;
    let horizontalOffsetTotal = 0;
    let mediaArea = 0;
    const fontSizes: number[] = [];
    const fontWeights: number[] = [];
    const lineRatios: number[] = [];
    const families = new Set<string>();
    const radii: number[] = [];
    const aspects: number[] = [];
    const transitionDurations: number[] = [];
    const animationDurations: number[] = [];
    let animatedElementCount = 0;
    let imageCount = 0;
    let videoCount = 0;

    for (const { element, rect, style } of visible) {
      if (style.display === "grid" || style.display === "inline-grid") gridElementCount += 1;
      if (style.display === "flex" || style.display === "inline-flex") flexElementCount += 1;
      const center = rect.left + rect.width / 2;
      const normalizedOffset = Math.abs(center - viewportWidth / 2) / Math.max(1, viewportWidth / 2);
      horizontalOffsetTotal += Math.min(1, normalizedOffset);
      if (normalizedOffset <= 0.08) centeredCount += 1;
      const clippedWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const clippedHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      occupiedArea += clippedWidth * clippedHeight;

      const fontSize = parsePx(style.fontSize);
      if (fontSize > 0 && (element.textContent?.trim().length ?? 0) > 0) {
        fontSizes.push(fontSize);
        const weight = Number.parseInt(style.fontWeight, 10);
        if (Number.isFinite(weight)) fontWeights.push(weight);
        const lineHeight = style.lineHeight === "normal" ? fontSize * 1.2 : parsePx(style.lineHeight);
        if (lineHeight > 0) lineRatios.push(lineHeight / fontSize);
        families.add(style.fontFamily.toLowerCase().replace(/\s+/g, " ").trim());
      }

      const radius = Math.max(parsePx(style.borderTopLeftRadius), parsePx(style.borderTopRightRadius), parsePx(style.borderBottomLeftRadius), parsePx(style.borderBottomRightRadius));
      if (radius > 0) radii.push(radius);
      if (rect.height > 0) aspects.push(rect.width / rect.height);

      const transition = parseDurations(style.transitionDuration);
      const animation = parseDurations(style.animationDuration);
      if (transition.some((duration) => duration > 0) || animation.some((duration) => duration > 0)) animatedElementCount += 1;
      transitionDurations.push(...transition.filter((duration) => duration > 0));
      animationDurations.push(...animation.filter((duration) => duration > 0));

      const tag = element.tagName.toLowerCase();
      if (tag === "img" || tag === "picture") {
        imageCount += 1;
        mediaArea += clippedWidth * clippedHeight;
      } else if (tag === "video") {
        videoCount += 1;
        mediaArea += clippedWidth * clippedHeight;
      }
    }

    const landmarks = [...document.querySelectorAll<HTMLElement>("main > section, main > article, body > header, body > main, body > footer")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.top - b.top);
    const landmarkHeights = landmarks.map((rect) => rect.height);
    const landmarkGaps = landmarks.slice(1).map((rect, index) => Math.max(0, rect.top - (landmarks[index]?.bottom ?? rect.top)));

    return {
      schemaVersion: 1 as const,
      viewport: { width: viewportWidth, height: viewportHeight },
      visibleElementCount: visible.length,
      layout: {
        gridElementCount,
        flexElementCount,
        centeredElementRatio: roundBrowser(centeredCount / Math.max(1, visible.length)),
        viewportOccupancyRatio: roundBrowser(Math.min(1, occupiedArea / viewportArea)),
        horizontalOffsetMean: roundBrowser(horizontalOffsetTotal / Math.max(1, visible.length)),
      },
      typography: {
        fontSizePx: quantized(fontSizes),
        fontWeight: quantized(fontWeights),
        lineHeightRatio: quantized(lineRatios),
        familyCount: families.size,
      },
      geometry: {
        borderRadiusPx: quantized(radii),
        aspectRatios: quantized(aspects),
      },
      media: {
        imageCount,
        videoCount,
        mediaAreaRatio: roundBrowser(Math.min(1, mediaArea / viewportArea)),
      },
      rhythm: {
        landmarkHeightsPx: quantized(landmarkHeights),
        landmarkGapPx: quantized(landmarkGaps),
      },
      motion: {
        animatedElementCount,
        transitionDurationMs: quantized(transitionDurations),
        animationDurationMs: quantized(animationDurations),
      },
    };
  }).then((observation) => ({
    ...observation,
    layout: { ...observation.layout, centeredElementRatio: round(observation.layout.centeredElementRatio), viewportOccupancyRatio: round(observation.layout.viewportOccupancyRatio), horizontalOffsetMean: round(observation.layout.horizontalOffsetMean) },
    media: { ...observation.media, mediaAreaRatio: round(observation.media.mediaAreaRatio) },
  }));
}
