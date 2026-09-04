import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { defineExperienceBrief } from "../packages/experience/brief.ts";
import { synthesizeAutonomousExperience, autonomousExperienceDigest } from "../packages/experience/autonomy.ts";
import { evaluateContentReadiness } from "../packages/experience/content-readiness.ts";
import { synthesizeGroundedCopy } from "../packages/experience/grounded-copy.ts";
import { assignMediaRoles } from "../packages/experience/media-assignment.ts";
import { ingestProjectFiles } from "../packages/experience/project-ingestion.ts";
import { deriveVisualSceneModel, assertSceneHasNoSilentOverlap } from "../packages/experience/visual-scene-model.ts";
import { deriveConstrainedEmitterInput } from "../packages/emitter/color-constraints.ts";
import { augmentExperienceFeatures } from "../packages/emitter/experience-features.ts";
import { emitExperienceCss } from "../packages/emitter/index.ts";
import { emitMultipageNextApp } from "../packages/emitter/multipage.ts";
import { certifyQualityGatesForDelivery } from "../packages/quality/quality-gate-certification.ts";

const PIPELINE = Object.freeze([
  "BRIEF", "EVIDENCE", "EXPERIENCE_DNA", "CONTENT_CONSTRAINTS", "CONTENT_READINESS",
  "VISUAL_SCENE_MODEL", "GENERATION", "EMITTER", "RENDER", "CAPTURE", "DESIGN_GENOME", "VISUAL_JUDGE",
  "RED_TEAM", "REPAIR_RECAPTURE_REJUDGE", "DELIVERY_CERTIFICATION",
]);

const notTested = (gateId, detail) => Object.freeze({ gateId, verdict: "NOT_TESTED", detail, evidenceIds: Object.freeze([]) });
const passed = (gateId, detail, evidenceIds) => Object.freeze({ gateId, verdict: "PASS", detail, evidenceIds: Object.freeze([...evidenceIds]) });

function decodedPipelineError(error) {
  const value = error && typeof error === "object" ? error : {};
  const decode = (output) => Buffer.isBuffer(output) ? output.toString("utf8") : typeof output === "string" ? output : "";
  return Object.freeze({
    name: typeof value.name === "string" ? value.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null ? { exitCode: value.exitCode } : {}),
    stdout: decode(value.stdout),
    stderr: decode(value.stderr),
  });
}

function safeOutput(root, relativePath) {
  const target = resolve(root, relativePath);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error(`generated path escapes output root: ${relativePath}`);
  return target;
}

async function writeGeneratedFiles(root, generation) {
  for (const file of generation.files) {
    const target = safeOutput(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

function normalizeQualityGate(result, gateId) {
  if (!result) return notTested(gateId, `${gateId} real adapter was not supplied`);
  if (result.gate?.gateId !== gateId) throw new Error(`${gateId} adapter returned mismatched gate identity`);
  return result.gate;
}

function assertGeneratedProvenance({ generatedMedia, generatedCopy, copyAssets, ingestion }) {
  const authorizedAssetDigests = new Set(ingestion.files.filter((file) => file.kind === "ASSET").map((file) => file.digest));
  for (const media of generatedMedia) {
    if (!authorizedAssetDigests.has(media.sourceDigest)) throw new Error(`generated media ${media.assetId} is not bound to an ingested authorized asset digest`);
  }
  const copySources = new Set(copyAssets.map((item) => item.source));
  for (const copy of generatedCopy) {
    if (!copySources.has(copy.sourceId)) throw new Error(`generated copy role ${copy.role} is not bound to a verified copy source`);
  }
}

function resolveContentInputs(spec, contentConstraints) {
  let copySynthesis;
  let generatedCopy = spec.generatedCopy ?? [];
  let copyAssets = spec.copyAssets ?? [];
  if (spec.groundedFacts) {
    copySynthesis = synthesizeGroundedCopy({ constraints: contentConstraints, facts: spec.groundedFacts, locale: spec.locale });
    generatedCopy = copySynthesis.items.map((item) => ({ role: item.role, text: item.text, sourceId: item.sourceId }));
    copyAssets = copySynthesis.copyAssets;
  }

  let mediaAssignment;
  let generatedMedia = spec.generatedMedia ?? [];
  let photos = spec.photos ?? [];
  if (spec.mediaCandidates) {
    mediaAssignment = assignMediaRoles({ requiredRoles: contentConstraints.requiredPhotoRoles, candidates: spec.mediaCandidates });
    generatedMedia = mediaAssignment.assignments.map((item) => ({ assetId: item.assetId, role: item.role, publicPath: item.publicPath, sourceDigest: item.sourceDigest, alt: item.observedContent }));
    photos = mediaAssignment.assignments.map((item) => ({ role: item.role, filePath: item.filePath, rights: item.rights, source: item.source }));
  }

  return { copySynthesis, generatedCopy, copyAssets, mediaAssignment, generatedMedia, photos };
}

export async function runNexusClientPipeline(spec, adapters = {}) {
  const stageLog = [];
  const record = (stage, detail, verdict = "PASS") => {
    if (!PIPELINE.includes(stage)) throw new Error(`unknown pipeline stage ${stage}`);
    stageLog.push(Object.freeze({ stage, detail, verdict }));
  };
  const abortAt = (stage, error) => {
    const decodedError = decodedPipelineError(error);
    record(stage, `stage aborted with ${decodedError.name}: ${decodedError.message}`, "FAIL");
    const abortedIndex = PIPELINE.indexOf(stage);
    for (const pending of PIPELINE.slice(abortedIndex + 1)) {
      record(pending, `${pending} was not executed because ${stage} aborted`, "NOT_TESTED");
    }
    return Object.freeze({
      authority: "NEXUS_CLIENT_PIPELINE_V1",
      status: "BLOCKED",
      stageLog: Object.freeze(stageLog),
      blocker: `${stage} aborted before returning a gate verdict`,
      error: decodedError,
      certification: undefined,
    });
  };

  const brief = defineExperienceBrief(spec.brief);
  record("BRIEF", "validated factual project brief", "PASS");

  const ingestion = await ingestProjectFiles(spec.projectFiles ?? []);
  record("EVIDENCE", "ingested source shell and authorized assets with exact digests", ingestion.verdict);
  if (ingestion.verdict !== "PASS") {
    return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, blocker: "project ingestion failed", certification: undefined });
  }

  const experience = synthesizeAutonomousExperience({ brief, businessProfile: spec.businessProfile });
  const experienceDigest = autonomousExperienceDigest(experience);
  record("EXPERIENCE_DNA", "synthesized ExperienceDNA from brief/reference/constraint evidence", "PASS");

  const contentConstraints = experience.contentConstraints;
  const contentInputs = resolveContentInputs(spec, contentConstraints);
  record("CONTENT_CONSTRAINTS", "derived copy/media constraints from ExperienceDNA and business specificity", "PASS");

  const readiness = await evaluateContentReadiness({ policy: experience.readinessPolicy, photos: contentInputs.photos, copy: contentInputs.copyAssets });
  record("CONTENT_READINESS", "checked NEXUS-assigned copy/media provenance and required roles", readiness.verdict);
  if (readiness.verdict !== "PASS") {
    return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, experience, experienceDigest, copySynthesis: contentInputs.copySynthesis, mediaAssignment: contentInputs.mediaAssignment, readiness, blocker: "content readiness did not PASS", certification: undefined });
  }
  assertGeneratedProvenance({ generatedMedia: contentInputs.generatedMedia, generatedCopy: contentInputs.generatedCopy, copyAssets: contentInputs.copyAssets, ingestion });

  const sceneStages = experience.plan.narrativeSequence.map((stage) => stage.stageId);
  const primaryStage = sceneStages[0];
  const evidenceStage = sceneStages[1] ?? primaryStage;
  if (!primaryStage || !evidenceStage) throw new Error("ExperiencePlan requires at least one narrative stage for scene derivation");
  const mediaCandidates = new Map((spec.mediaCandidates ?? []).map((candidate) => [candidate.assetId, candidate]));
  const sceneModel = deriveVisualSceneModel({
    projectId: spec.projectId,
    dna: experience.dna,
    plan: experience.plan,
    content: contentInputs.generatedCopy.map((copy, index) => ({ id: `${copy.role}:${index}`, stageId: primaryStage, kind: index === 0 ? "HEADING" : "BODY", text: copy.text })),
    assets: contentInputs.generatedMedia.map((media) => {
      const candidate = mediaCandidates.get(media.assetId);
      return { id: media.assetId, stageId: evidenceStage, sourceDigest: media.sourceDigest, width: candidate?.width ?? 1, height: candidate?.height ?? 1, available: true };
    }),
    environment: spec.sceneEnvironment ?? { viewportWidth: 1440, zoom: 1, reducedMotion: false }
  });
  assertSceneHasNoSilentOverlap(sceneModel);
  record("VISUAL_SCENE_MODEL", "derived intrinsic layout from ExperienceDNA, generated content and authorized assets", "PASS");

  const emitterInput = deriveConstrainedEmitterInput({ dna: experience.dna, constraints: brief.constraints, projectSeed: spec.projectId });

  const emitted = await emitExperienceCss(emitterInput);
  const baseGeneration = emitMultipageNextApp({
    projectId: spec.projectId,
    locale: spec.locale,
    brief,
    dna: experience.dna,
    plan: experience.plan,
    contentConstraints,
    tokenCss: emitted.css,
    copy: contentInputs.generatedCopy,
    media: contentInputs.generatedMedia,
    actions: spec.actions ?? [],
  });
  const generation = augmentExperienceFeatures({
    generation: baseGeneration,
    locale: spec.locale,
    constraints: brief.constraints,
    location: spec.location,
    reviews: spec.reviews ?? [],
    minimumReviewItems: spec.minimumReviewItems ?? 0,
  });
  if (spec.outputDir) await writeGeneratedFiles(spec.outputDir, generation);
  record("GENERATION", "generated multipage sources constrained by ExperienceDNA", "PASS");
  record("EMITTER", "emitted identity tokens/CSS from ExperienceDNA and explicit color constraints", "PASS");

  const readinessEvidence = [...readiness.copy.map((item) => item.source), ...readiness.photos.map((item) => item.digest)];
  const provenanceEvidence = [
    ingestion.provenanceDigest,
    ...(contentInputs.copySynthesis ? [contentInputs.copySynthesis.synthesisDigest] : []),
    ...(contentInputs.mediaAssignment ? [contentInputs.mediaAssignment.assignmentDigest] : []),
  ];
  const gates = [
    passed("CONTENT_READINESS", "content readiness passed against DNA-derived policy", readinessEvidence),
    passed("GENERATION", "NEXUS multipage generator emitted provenance-bound sources and an intrinsic scene model", [generation.generationDigest, sceneModel.provenance.inputDigest]),
    passed("EMITTER", "NEXUS emitter produced deterministic token CSS", [experienceDigest]),
    passed("PROVENANCE", "source shell, authorized assets, grounded copy, media assignments and project features are provenance-bound", [...provenanceEvidence, ...generation.provenanceIds]),
  ];

  let renderResult;
  let renderGate;
  try {
    if (adapters.render) {
      renderResult = await adapters.render({ spec, brief, experience, emitted, generation, ingestion });
    }
    renderGate = normalizeQualityGate(renderResult, "RENDER");
  } catch (error) {
    return abortAt("RENDER", error);
  }
  record("RENDER", renderResult ? "executed real render adapter" : "real render adapter unavailable", renderGate.verdict);
  gates.push(renderGate);

  let captureResult;
  let captureGate;
  try {
    if (adapters.capture && renderResult?.gate?.verdict === "PASS") {
      captureResult = await adapters.capture({ spec, generation, render: renderResult });
    }
    captureGate = normalizeQualityGate(captureResult, "CAPTURE");
  } catch (error) {
    return abortAt("CAPTURE", error);
  }
  record("CAPTURE", captureResult ? "executed real browser capture adapter" : "real capture adapter unavailable or render did not PASS", captureGate.verdict);
  gates.push(captureGate);

  let genomeResult;
  let genomeGate;
  try {
    if (adapters.designGenome && captureResult?.gate?.verdict === "PASS") {
      genomeResult = await adapters.designGenome({ spec, generation, capture: captureResult });
    }
    genomeGate = normalizeQualityGate(genomeResult, "DESIGN_GENOME");
  } catch (error) {
    return abortAt("DESIGN_GENOME", error);
  }
  record("DESIGN_GENOME", genomeResult ? "extracted measured design genome from rendered evidence" : "design genome adapter unavailable or capture did not PASS", genomeGate.verdict);
  gates.push(genomeGate);

  let visualResult;
  let visualGate;
  try {
    if (adapters.visualJudge && captureResult?.gate?.verdict === "PASS" && genomeResult?.gate?.verdict === "PASS") {
      visualResult = await adapters.visualJudge({ spec, brief, experience, generation, capture: captureResult, genome: genomeResult });
    }
    visualGate = normalizeQualityGate(visualResult, "VISUAL_JUDGE");
  } catch (error) {
    return abortAt("VISUAL_JUDGE", error);
  }
  record("VISUAL_JUDGE", visualResult ? "executed bound visual review over real evidence" : "real Visual Judge adapter unavailable or evidence prerequisites did not PASS", visualGate.verdict);
  gates.push(visualGate);

  let redTeamResult;
  let redTeamGate;
  try {
    if (adapters.redTeam && visualResult?.gate?.verdict === "PASS") {
      redTeamResult = await adapters.redTeam({ spec, brief, experience, generation, capture: captureResult, visualJudge: visualResult });
    }
    redTeamGate = normalizeQualityGate(redTeamResult, "RED_TEAM");
  } catch (error) {
    return abortAt("RED_TEAM", error);
  }
  record("RED_TEAM", redTeamResult ? "executed complete adversarial NEXUS attack arena including Excess Removal evidence" : "Red Team adapter unavailable or Visual Judge did not PASS", redTeamGate.verdict);
  gates.push(redTeamGate);

  let repairResult;
  let repairGate;
  try {
    if (adapters.repairRejudge && redTeamResult?.gate?.verdict === "PASS") {
      repairResult = await adapters.repairRejudge({ spec, brief, experience, generation, capture: captureResult, visualJudge: visualResult, redTeam: redTeamResult });
    }
    repairGate = normalizeQualityGate(repairResult, "REPAIR_REJUDGE");
  } catch (error) {
    return abortAt("REPAIR_RECAPTURE_REJUDGE", error);
  }
  record("REPAIR_RECAPTURE_REJUDGE", repairResult ? "executed bounded repair/recapture/rejudge cycle" : "repair/rejudge adapter unavailable or Red Team did not PASS", repairGate.verdict);
  gates.push(repairGate);

  const certification = certifyQualityGatesForDelivery({ projectId: spec.projectId, sourceRevision: spec.sourceRevision, gates, visualJudge: visualResult?.report, redTeam: redTeamResult?.report, excessRemoval: redTeamResult?.excessRemoval, qualityCycle: repairResult?.report });
  record("DELIVERY_CERTIFICATION", "evaluated fail-closed delivery certification", certification.verdict);

  return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: certification.certified ? "CERTIFIED" : "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, experience, experienceDigest, copySynthesis: contentInputs.copySynthesis, mediaAssignment: contentInputs.mediaAssignment, readiness, sceneModel, emitted, generation, certification });
}

export async function runNexusClientPipelineWithWorkspaceRuntime(spec, options = {}) {
  const runtimeTarget = spec?.runtime?.target;
  if (typeof runtimeTarget !== "string" || !runtimeTarget.trim()) {
    throw new Error("workspace runtime execution requires spec.runtime.target; use runNexusClientPipeline() only for explicit adapter-level tests or offline contract evaluation");
  }
  const runtimeFactory = options.runtimeFactory ?? (await import("./nexus-client-runtime.mjs")).createWorkspaceClientRuntimeAdapters;
  if (typeof runtimeFactory !== "function") throw new Error("workspace runtime factory is unavailable");
  const adapters = await runtimeFactory(spec, options.runtimeOptions ?? {});
  for (const requiredAdapter of ["render", "capture", "designGenome"]) {
    if (typeof adapters?.[requiredAdapter] !== "function") {
      throw new Error(`workspace runtime target ${runtimeTarget} did not assemble required production adapter ${requiredAdapter}`);
    }
  }
  return runNexusClientPipeline(spec, adapters);
}
