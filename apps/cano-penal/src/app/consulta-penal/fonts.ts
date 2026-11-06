import localFont from "next/font/local";

/**
 * Newsreader (Production Type, SIL Open Font License, see ./fonts/OFL.txt), self-hosted so the
 * build stays hermetic. Each file is one static cut subset to Spanish Latin (about 24 KB each):
 * a Light display cut for the large headlines and Regular/Medium text cuts for reading and buttons.
 * Only the cuts the first screen needs are preloaded; the italics load when they scroll into use.
 */
const serifFallback = ["Georgia", "Times New Roman", "serif"];

const display = localFont({
  src: "./fonts/newsreader-display-light.woff2",
  weight: "300",
  style: "normal",
  variable: "--cp-lp-display",
  display: "swap",
  fallback: serifFallback,
});

const displayItalic = localFont({
  src: "./fonts/newsreader-display-light-italic.woff2",
  weight: "300",
  style: "italic",
  variable: "--cp-lp-display-italic",
  display: "swap",
  preload: false,
  fallback: serifFallback,
});

const text = localFont({
  src: [
    { path: "./fonts/newsreader-text-regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/newsreader-text-medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--cp-lp-text",
  display: "swap",
  fallback: serifFallback,
});

const textItalic = localFont({
  src: "./fonts/newsreader-text-italic.woff2",
  weight: "400",
  style: "italic",
  variable: "--cp-lp-text-italic",
  display: "swap",
  preload: false,
  fallback: serifFallback,
});

/** Class names that expose the four font families as CSS variables on the landing wrapper. */
export const CONSULTA_FONT_VARIABLES = [display, displayItalic, text, textItalic].map((font) => font.variable).join(" ");
