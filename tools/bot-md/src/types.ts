export type Viewport = { name: string; width: number; height: number };
export type Step = {
  action:
    | "click"
    | "hover"
    | "focus"
    | "fill"
    | "select"
    | "press"
    | "scroll"
    | "wait";
  selector?: string;
  value?: string;
  x?: number;
  y?: number;
  ms?: number;
};
export type Assertion = {
  selector: string;
  kind: "visible" | "hidden" | "text" | "attribute" | "value";
  value?: string;
  attribute?: string;
};
export type Scenario = {
  name: string;
  path?: string;
  steps: Step[];
  assertions?: Assertion[];
};
export type Config = {
  url: string;
  viewports: Viewport[];
  maxPages: number;
  maxStates: number;
  autoExplore: boolean;
  allowLocalhost: boolean;
  settleMs: number;
  navigationTimeoutMs: number;
  readySelector?: string;
  readySelectors?: Record<string, string>;
  maxElements: number;
  maxResourceBytes: number;
  maxTotalBytes: number;
  maxScrollSteps: number;
  scenarios: Scenario[];
  pixelThreshold: number;
  maxDiffRatio: number;
  geometryTolerance: number;
};
export type Resource = {
  url: string;
  status: number;
  mime: string;
  kind: string;
  sha256: string;
  bytes: number;
  file: string;
  localPath: string;
  variants: string[];
  responseHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
};
export type Issue = { code: string; detail: string; stateId?: string };
export type LayoutNode = {
  key: string;
  selector: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  style: Record<string, string>;
  visible: boolean;
  attrs: Record<string, string>;
  before: Record<string, string>;
  after: Record<string, string>;
};
export type Layout = {
  title: string;
  url: string;
  width: number;
  height: number;
  scrollX?: number;
  scrollY?: number;
  input?: {
    hover: boolean;
    pointerFine: boolean;
    reducedMotion: boolean;
    maxTouchPoints: number;
  };
  nodes: LayoutNode[];
  truncated: boolean;
  fonts: { family: string; status: string; weight: string; style: string }[];
  animations: unknown[];
  unsupported: {
    canvas: number;
    iframes: number;
    shadowHosts: number;
    videos: number;
  };
};
export type State = {
  id: string;
  name: string;
  url: string;
  viewport: Viewport;
  steps: Step[];
  assertions: Assertion[];
  assertionResults: boolean[];
  capturedAt: string;
  screenshot: string;
  repeatScreenshot: string;
  layout: string;
  domSnapshot?: string;
  platformFonts?: string;
  renderedHtml: string;
  markdown: string;
  hash: string;
};
export type Manifest = {
  schemaVersion: 1;
  version: string;
  createdAt: string;
  browserVersion: string;
  config: Config;
  origin: string;
  pages: string[];
  resources: Record<string, Resource>;
  states: State[];
  issues: Issue[];
  files: Record<string, string>;
  enrichment?: { parentDigest: string; createdAt: string; addedURLs: string[] };
  rawResponseRefresh?: {
    url: string;
    previousHash: string;
    currentHash: string;
    fetchedAt: string;
  }[];
};
export type RouteRecord = {
  file: string;
  mime: string;
  status: number;
  sourceUrl: string;
  sha256: string;
  responseHeaders?: Record<string, string>;
};
export type Build = {
  schemaVersion: 1;
  sourceDigest: string;
  origin: string;
  routes: Record<string, RouteRecord>;
  missing: string[];
  patches: { selector: string; styles: Record<string, string> }[];
};
export type StateResult = {
  id: string;
  name: string;
  viewport: Viewport;
  status: "pass" | "fail" | "unstable" | "error";
  diffRatio?: number;
  diffPixels?: number;
  baselineNoiseRatio?: number;
  dimensionsMatch?: boolean;
  geometryErrors?: { selector: string; delta: number }[];
  assertions: boolean[];
  missingRequests: string[];
  consoleErrors: string[];
  environmentErrors?: string[];
  assertionErrors?: string[];
  cancelledPrefetches?: string[];
  screenshot?: string;
  diff?: string;
  error?: string;
};
export type Verification = {
  selection?: string[];
  schemaVersion: 1;
  createdAt: string;
  sourceDigest: string;
  baselineIntegrity: boolean;
  scope: string;
  captureCoverage: {
    capturedStates: number;
    failedStates: number;
    failedPageLoads: number;
    truncatedStates: number;
    exhaustive: false;
  };
  environment: { browser: string; platform: string; legacyCDPReplay?: boolean };
  results: StateResult[];
  totals: { pass: number; fail: number; unstable: number; error: number };
  limitations: string[];
};
