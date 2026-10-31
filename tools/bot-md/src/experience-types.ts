import type { Viewport } from "./types.js";

export type MotionStep = { name: string; progress: number };
export type MotionConfig = {
  route: string;
  viewports: (Viewport & { touch?: boolean })[];
  svgSelector: string;
  steps: MotionStep[];
  sampleMs: number[];
  readySelector?: string;
  timeoutMs: number;
  initialWaitMs: number;
  maxPaths: number;
  pointSamples: number;
  allowLocalhost: boolean;
};
export type MotionPath = {
  key: string;
  tag: string;
  route: string | null;
  d: string | null;
  length: number;
  points: { x: number; y: number }[];
  style: Record<string, string>;
};
export type MotionFrame = {
  viewport: string;
  step: number;
  sampleMs: number;
  elapsedMs: number;
  scrollY: number;
  scrollHeight: number;
  overflowX: number;
  input: { reduced: boolean; touchPoints: number; hover: boolean };
  paths: MotionPath[];
  truncated: boolean;
};
export type MotionTrace = {
  schemaVersion: 1;
  createdAt: string;
  source: string;
  browser: string;
  profileHash: string;
  config: MotionConfig;
  frames: MotionFrame[];
  observedRequests?: {
    url: string;
    status: number;
    mime: string;
    requestHeaders: Record<string, string>;
  }[];
  issues: string[];
  limitations: string[];
};
export type ContentBinding = {
  id: string;
  route: string;
  selector: string;
  kind: "text" | "attribute";
  textIndex?: number;
  attribute?: string;
  expected: string;
  value: string;
};
export type ContentMap = {
  schemaVersion: 1;
  readySelector?: string;
  readySelectors?: Record<string, string>;
  timeoutMs: number;
  bindings: ContentBinding[];
};
