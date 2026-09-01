import { captureScene, type BrowserName, type CaptureArtifact, type Scene, type Viewport } from "./index.js";

const MAX_NAVIGATION_URL = 4_096;

function normalizeNavigationUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("navigationUrl must be a string");
  const raw = value.trim();
  if (!raw) throw new Error("navigationUrl must not be empty");
  if (raw.length > MAX_NAVIGATION_URL) throw new Error(`navigationUrl exceeds ${MAX_NAVIGATION_URL} characters`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("navigationUrl must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("navigationUrl must use HTTP(S)");
  if (parsed.username || parsed.password) throw new Error("navigationUrl must not contain URL userinfo");
  parsed.hash = "";
  return parsed.toString();
}

export interface NavigationSceneCaptureInput {
  scene: Scene;
  navigationUrl: string;
  browserName: BrowserName;
  viewport: Viewport;
  revision: string;
  buildDigest: string;
  outDir: string;
  navigationTimeoutMs?: number;
}

export type SceneCaptureExecutor = typeof captureScene;

export async function captureSceneAtNavigationUrl(
  input: NavigationSceneCaptureInput,
  executor: SceneCaptureExecutor = captureScene,
): Promise<CaptureArtifact> {
  const target = normalizeNavigationUrl(input.navigationUrl);
  const result = await executor({
    scene: input.scene,
    navigationUrl: target,
    browserName: input.browserName,
    viewport: input.viewport,
    revision: input.revision,
    buildDigest: input.buildDigest,
    outDir: input.outDir,
    ...(input.navigationTimeoutMs === undefined ? {} : { navigationTimeoutMs: input.navigationTimeoutMs }),
  });
  if (result.record.sceneDigest !== input.scene.digest) throw new Error("navigation capture changed the stable scene identity digest");
  return result;
}
