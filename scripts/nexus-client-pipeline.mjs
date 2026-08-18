import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineExperienceBrief } from "../packages/experience/brief.ts";
import { synthesizeAutonomousExperience, autonomousExperienceDigest } from "../packages/experience/autonomy.ts";
import { evaluateContentReadiness } from "../packages/experience/content-readiness.ts";
import { synthesizeGroundedCopy } from "../packages/experience/grounded-copy.ts";
import { assignMediaRoles } from "../packages/experience/media-assignment.ts";
import { ingestProjectFiles } from "../packages/experience/project-ingestion.ts";
import { deriveConstrainedEmitterInput } from "../packages/emitter/color-constraints.ts";
import { emitExperienceCss } from "../packages/emitter/index.ts";
import { emitMultipageNextApp } from "../packages/emitter/multipage.ts";
import { certifyDelivery } from "../packages/quality/delivery-certification.ts";

const PIPELINE = Object.freeze([
  "BRIEF", "EVIDENCE", "EXPERIENCE_DNA", "CONTENT_CONSTRAINTS", "CONTENT_READINESS",
  "GENERATION", "EMITTER", "RENDER", "CAPTURE", "DESIGN_GENOME", "VISUAL_JUDGE",
  "RED_TEAM", "REPAIR_RECAPTURE_REJUDGE", "DELIVERY_CERTIFICATION",
]);

const notTested = (gateId, detail) => Object.freeze({ gateId, verdict: "NOT_TESTED", detail, evidenceIds: Object.freeze([]) });
const passed = (gateId, detail, evidenceIds) => Object.freeze({ gateId, verdict: "PASS", detail, evidenceIds: Object.freeze([...evidenceIds]) });

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

  record("BRIEF", "validating factual project brief");
  const brief = defineExperienceBrief(spec.brief);

  record("EVIDENCE", "ingesting source shell and authorized assets with exact digests");
  const ingestion = await ingestProjectFiles(spec.projectFiles ?? []);
  if (ingestion.verdict !== "PASS") {
    return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, blocker: "project ingestion failed", certification: undefined });
  }

  record("EXPERIENCE_DNA", "synthesizing ExperienceDNA from brief/reference/constraint evidence");
  const experience = synthesizeAutonomousExperience({ brief, businessProfile: spec.businessProfile });
  const experienceDigest = autonomousExperienceDigest(experience);

  record("CONTENT_CONSTRAINTS", "deriving copy/media constraints from ExperienceDNA and business specificity");
  const contentConstraints = experience.contentConstraints;
  const contentInputs = resolveContentInputs(spec, contentConstraints);

  record("CONTENT_READINESS", "checking NEXUS-assigned copy/media provenance and required roles");
  const readiness = await evaluateContentReadiness({ policy: experience.readinessPolicy, photos: contentInputs.photos, copy: contentInputs.copyAssets });
  if (readiness.verdict !== "PASS") {
    return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, experience, experienceDigest, copySynthesis: contentInputs.copySynthesis, mediaAssignment: contentInputs.mediaAssignment, readiness, blocker: "content readiness did not PASS", certification: undefined });
  }
  assertGeneratedProvenance({ generatedMedia: contentInputs.generatedMedia, generatedCopy: contentInputs.generatedCopy, copyAssets: contentInputs.copyAssets, ingestion });

  record("GENERATION", "generating multipage source constrained by ExperienceDNA");
  const emitterInput = deriveConstrainedEmitterInput({ dna: experience.dna, constraints: brief.constraints, projectSeed: spec.projectId });

  record("EMITTER", "emitting identity tokens/CSS from ExperienceDNA and explicit color constraints");
  const emitted = await emitExperienceCss(emitterInput);
  const generation = emitMultipageNextApp({
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
    location: spec.location,
    reviews: spec.reviews ?? [],
    minimumReviewItems: spec.minimumReviewItems ?? 0,
  });
  if (spec.outputDir) await writeGeneratedFiles(spec.outputDir, generation);

  const readinessEvidence = [...readiness.copy.map((item) => item.digest), ...readiness.photos.map((item) => item.digest)];
  const provenanceEvidence = [
    ingestion.provenanceDigest,
    ...(contentInputs.copySynthesis ? [contentInputs.copySynthesis.synthesisDigest] : []),
    ...(contentInputs.mediaAssignment ? [contentInputs.mediaAssignment.assignmentDigest] : []),
  ];
  const gates = [
    passed("CONTENT_READINESS", "content readiness passed against DNA-derived policy", readinessEvidence),
    passed("GENERATION", "NEXUS multipage generator emitted provenance-bound sources", [generation.generationDigest]),
    passed("EMITTER", "NEXUS emitter produced deterministic token CSS", [experienceDigest]),
    passed("PROVENANCE", "source shell, authorized assets, grounded copy and media assignments are provenance-bound", provenanceEvidence),
  ];

  let renderResult;
  if (adapters.render) {
    record("RENDER", "executing real render adapter");
    renderResult = await adapters.render({ spec, brief, experience, emitted, generation, ingestion });
  } else record("RENDER", "real render adapter unavailable", "NOT_TESTED");
  gates.push(normalizeQualityGate(renderResult, "RENDER"));

  let captureResult;
  if (adapters.capture && renderResult?.gate?.verdict === "PASS") {
    record("CAPTURE", "executing real browser capture adapter");
    captureResult = await adapters.capture({ spec, generation, render: renderResult });
  } else record("CAPTURE", "real capture adapter unavailable or render did not PASS", "NOT_TESTED");
  gates.push(normalizeQualityGate(captureResult, "CAPTURE"));

  let genomeResult;
  if (adapters.designGenome && captureResult?.gate?.verdict === "PASS") {
    record("DESIGN_GENOME", "extracting measured design genome from rendered evidence");
    genomeResult = await adapters.designGenome({ spec, generation, capture: captureResult });
  } else record("DESIGN_GENOME", "design genome adapter unavailable or capture did not PASS", "NOT_TESTED");
  gates.push(normalizeQualityGate(genomeResult, "DESIGN_GENOME"));

  let visualResult;
  if (adapters.visualJudge && captureResult?.gate?.verdict === "PASS" && genomeResult?.gate?.verdict === "PASS") {
    record("VISUAL_JUDGE", "executing bound visual review over real evidence");
    visualResult = await adapters.visualJudge({ spec, brief, experience, generation, capture: captureResult, genome: genomeResult });
  } else record("VISUAL_JUDGE", "real Visual Judge adapter unavailable or evidence prerequisites did not PASS", "NOT_TESTED");
  gates.push(normalizeQualityGate(visualResult, "VISUAL_JUDGE"));

  let redTeamResult;
  if (adapters.redTeam && visualResult?.gate?.verdict === "PASS") {
    record("RED_TEAM", "executing adversarial NEXUS attack arena");
    redTeamResult = await adapters.redTeam({ spec, brief, experience, generation, capture: captureResult, visualJudge: visualResult });
  } else record("RED_TEAM", "Red Team adapter unavailable or Visual Judge did not PASS", "NOT_TESTED");
  gates.push(normalizeQualityGate(redTeamResult, "RED_TEAM"));

  let repairResult;
  if (adapters.repairRejudge && redTeamResult?.gate?.verdict === "PASS") {
    record("REPAIR_RECAPTURE_REJUDGE", "executing bounded repair/recapture/rejudge cycle");
    repairResult = await adapters.repairRejudge({ spec, brief, experience, generation, capture: captureResult, visualJudge: visualResult, redTeam: redTeamResult });
  } else record("REPAIR_RECAPTURE_REJUDGE", "repair/rejudge adapter unavailable or Red Team did not PASS", "NOT_TESTED");
  gates.push(normalizeQualityGate(repairResult, "REPAIR_REJUDGE"));

  record("DELIVERY_CERTIFICATION", "evaluating fail-closed delivery certification");
  const certification = certifyDelivery({ projectId: spec.projectId, sourceRevision: spec.sourceRevision, gates, visualJudge: visualResult?.report, redTeam: redTeamResult?.report, qualityCycle: repairResult?.report });

  return Object.freeze({ authority: "NEXUS_CLIENT_PIPELINE_V1", status: certification.certified ? "CERTIFIED" : "BLOCKED", stageLog: Object.freeze(stageLog), ingestion, experience, experienceDigest, copySynthesis: contentInputs.copySynthesis, mediaAssignment: contentInputs.mediaAssignment, readiness, emitted, generation, certification });
}

async function main() {
  const args = process.argv.slice(2);
  const specIndex = args.indexOf("--spec");
  const outIndex = args.indexOf("--out");
  if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/nexus-client-pipeline.mjs --spec <json> [--out <dir>]");
  const specPath = resolve(args[specIndex + 1]);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (outIndex >= 0 && args[outIndex + 1]) spec.outputDir = resolve(args[outIndex + 1]);
  const result = await runNexusClientPipeline(spec);
  process.stdout.write(`${JSON.stringify({ authority: result.authority, status: result.status, certification: result.certification, blocker: result.blocker }, null, 2)}\n`);
  process.exitCode = result.status === "CERTIFIED" ? 0 : 2;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });
