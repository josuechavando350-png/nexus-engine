import { createHash } from "node:crypto";
import type { ExperienceDNA } from "./dna";
import type { ExperiencePlan } from "./compiler";

export type SceneContent = Readonly<{
  id: string;
  stageId: string;
  kind: "HEADING" | "BODY" | "ACTION";
  text: string;
}>;

export type SceneAsset = Readonly<{
  id: string;
  stageId: string;
  sourceDigest: `sha256:${string}`;
  width: number;
  height: number;
  available: boolean;
}>;

export type SceneEnvironment = Readonly<{
  viewportWidth: number;
  zoom: number;
  reducedMotion: boolean;
}>;

export type IntrinsicSceneNode = Readonly<{
  id: string;
  kind: SceneContent["kind"] | "MEDIA" | "MEDIA_FALLBACK";
  stageId: string;
  flowOrder: number;
  inlineSpan: number;
  minBlockSize: number;
  sizing: "INTRINSIC_CONTENT" | "INTRINSIC_ASPECT_RATIO" | "INTRINSIC_FALLBACK";
  sourceId: string;
}>;

export type VisualSceneStage = Readonly<{
  id: string;
  columns: number;
  gap: number;
  paddingBlock: number;
  blockStart: number;
  blockSize: number;
  nodes: readonly IntrinsicSceneNode[];
}>;

export type VisualSceneModel = Readonly<{
  schemaVersion: 1;
  authority: "NEXUS_VISUAL_SCENE_MODEL_V1";
  projectId: string;
  dnaSubject: string;
  planId: string;
  environment: SceneEnvironment;
  layoutPolicy: Readonly<{
    blockSizing: "INTRINSIC";
    contentGrowth: "REFLOW";
    clipping: "FORBIDDEN";
    semanticOrderPreserved: true;
  }>;
  motion: Readonly<{ mode: "DECLARED" | "REDUCED"; choreography: string }>;
  stages: readonly VisualSceneStage[];
  provenance: Readonly<{
    inputDigest: `sha256:${string}`;
    derivation: "NEXUS_INTRINSIC_SCENE_DERIVATION_V1";
    contentIds: readonly string[];
    assetDigests: readonly `sha256:${string}`[];
  }>;
}>;

const canonical = (value: unknown): string => JSON.stringify(value);
const digest = (value: unknown): `sha256:${string}` => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const positive = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
  return value;
};

function textBlockSize(content: SceneContent, availableWidth: number, zoom: number): number {
  const fontSize = content.kind === "HEADING" ? 40 : content.kind === "ACTION" ? 16 : 18;
  const lineHeight = fontSize * (content.kind === "HEADING" ? 1.15 : 1.55) * zoom;
  const averageGlyphWidth = fontSize * 0.56 * zoom;
  const charactersPerLine = Math.max(1, Math.floor(availableWidth / averageGlyphWidth));
  const explicitLines = content.text.split("\n");
  const lines = explicitLines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
  return Math.ceil(lines * lineHeight);
}

function stageColumns(dna: ExperienceDNA, viewportWidth: number): number {
  if (viewportWidth < 720) return 1;
  return dna.composition.gridDiscipline.value >= 0.65 ? 2 : 1;
}

export function deriveVisualSceneModel(input: {
  projectId: string;
  dna: ExperienceDNA;
  plan: ExperiencePlan;
  content: readonly SceneContent[];
  assets: readonly SceneAsset[];
  environment: SceneEnvironment;
}): VisualSceneModel {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("visual scene projectId is required");
  const viewportWidth = positive(input.environment.viewportWidth, "viewportWidth");
  const zoom = positive(input.environment.zoom, "zoom");
  const stageIds = new Set(input.plan.narrativeSequence.map((stage) => stage.stageId));
  const ids = new Set<string>();
  for (const item of input.content) {
    if (!item.id.trim() || ids.has(item.id)) throw new Error("scene content ids must be unique and non-empty");
    if (!stageIds.has(item.stageId)) throw new Error(`unknown content stage ${item.stageId}`);
    if (!item.text.trim()) throw new Error(`scene content ${item.id} is empty`);
    ids.add(item.id);
  }
  for (const asset of input.assets) {
    if (!asset.id.trim() || ids.has(asset.id)) throw new Error("scene source ids must be unique and non-empty");
    if (!stageIds.has(asset.stageId)) throw new Error(`unknown asset stage ${asset.stageId}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.sourceDigest)) throw new Error(`asset ${asset.id} requires canonical SHA-256 provenance`);
    positive(asset.width, `asset ${asset.id} width`);
    positive(asset.height, `asset ${asset.id} height`);
    ids.add(asset.id);
  }

  const stages: VisualSceneStage[] = [];
  let blockCursor = 0;
  for (const planStage of input.plan.narrativeSequence) {
    const columns = stageColumns(input.dna, viewportWidth);
    const gap = Math.ceil(24 * zoom);
    const paddingBlock = Math.ceil(40 * zoom);
    const inlineSize = Math.max(1, (viewportWidth - gap * (columns - 1)) / columns);
    const nodes: IntrinsicSceneNode[] = [];
    for (const item of input.content.filter((candidate) => candidate.stageId === planStage.stageId)) {
      nodes.push(Object.freeze({ id: `content:${item.id}`, kind: item.kind, stageId: item.stageId, flowOrder: nodes.length, inlineSpan: 1, minBlockSize: textBlockSize(item, inlineSize, zoom), sizing: "INTRINSIC_CONTENT", sourceId: item.id }));
    }
    for (const asset of input.assets.filter((candidate) => candidate.stageId === planStage.stageId)) {
      const size = asset.available ? Math.ceil(inlineSize * (asset.height / asset.width)) : Math.ceil(160 * zoom);
      nodes.push(Object.freeze({ id: `asset:${asset.id}`, kind: asset.available ? "MEDIA" : "MEDIA_FALLBACK", stageId: asset.stageId, flowOrder: nodes.length, inlineSpan: 1, minBlockSize: size, sizing: asset.available ? "INTRINSIC_ASPECT_RATIO" : "INTRINSIC_FALLBACK", sourceId: asset.id }));
    }
    const rows = Array.from({ length: Math.ceil(nodes.length / columns) }, (_, row) => Math.max(...nodes.slice(row * columns, (row + 1) * columns).map((node) => node.minBlockSize), 0));
    const blockSize = paddingBlock * 2 + rows.reduce((sum, row) => sum + row, 0) + Math.max(0, rows.length - 1) * gap;
    stages.push(Object.freeze({ id: planStage.stageId, columns, gap, paddingBlock, blockStart: blockCursor, blockSize, nodes: Object.freeze(nodes) }));
    blockCursor += blockSize;
  }

  const normalizedEnvironment = Object.freeze({ viewportWidth, zoom, reducedMotion: input.environment.reducedMotion });
  const contentIds = Object.freeze(input.content.map((item) => item.id));
  const assetDigests = Object.freeze(input.assets.map((asset) => asset.sourceDigest));
  return Object.freeze({
    schemaVersion: 1,
    authority: "NEXUS_VISUAL_SCENE_MODEL_V1",
    projectId,
    dnaSubject: input.dna.subject,
    planId: input.plan.id,
    environment: normalizedEnvironment,
    layoutPolicy: Object.freeze({ blockSizing: "INTRINSIC", contentGrowth: "REFLOW", clipping: "FORBIDDEN", semanticOrderPreserved: true }),
    motion: Object.freeze({ mode: input.environment.reducedMotion ? "REDUCED" : "DECLARED", choreography: input.environment.reducedMotion ? "none" : input.plan.motionStrategy.choreography }),
    stages: Object.freeze(stages),
    provenance: Object.freeze({ inputDigest: digest({ projectId, dna: input.dna, plan: input.plan, content: input.content, assets: input.assets, environment: normalizedEnvironment }), derivation: "NEXUS_INTRINSIC_SCENE_DERIVATION_V1", contentIds, assetDigests })
  });
}

export function assertSceneHasNoSilentOverlap(scene: VisualSceneModel): void {
  let expectedStart = 0;
  for (const stage of scene.stages) {
    if (stage.blockStart !== expectedStart || stage.blockSize < stage.paddingBlock * 2) throw new Error(`scene stage ${stage.id} violates intrinsic flow`);
    if (stage.nodes.some((node) => node.minBlockSize <= 0)) throw new Error(`scene stage ${stage.id} contains a collapsed node`);
    expectedStart += stage.blockSize;
  }
}
