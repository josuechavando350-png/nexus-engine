import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { readGitState } from "../packages/mcp-server/src/git.ts";
import { readProjects } from "../packages/mcp-server/src/projects.ts";
import { buildTarget, validateBuildManifest } from "../packages/mcp-server/src/build.ts";
import { captureProjectEvidence } from "../packages/mcp-server/src/capture.ts";
import { runProcess, runReadOnly } from "../packages/mcp-server/src/process.ts";
import { judgeVisualEvidence } from "../packages/quality/visual-judge.ts";
import { createProductionRedTeamAdapter } from "./nexus-client-red-team-runtime.mjs";
import { createProductionQualityCycleAdapter } from "./nexus-client-quality-cycle-runtime.mjs";
import { loadCommittedVisualReview, evaluateDigestBoundVisualReview } from "./nexus-client-visual-review.mjs";

const DEFAULT_CAPABILITIES = Object.freeze(["SCREENSHOT", "ACCESSIBILITY", "DESIGN_GENOME", "CONTRAST", "PERFORMANCE"]);
const DEFAULT_BROWSERS = Object.freeze(["chromium", "webkit"]);
const DEFAULT_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "mobile-390", width: 390, height: 844 }),
  Object.freeze({ name: "tablet-768", width: 768, height: 1024 }),
  Object.freeze({ name: "desktop-1440", width: 1440, height: 1000 }),
]);

function gate(gateId, verdict, detail, evidenceIds = []) {
  return Object.freeze({ gate: Object.freeze({ gateId, verdict, detail, evidenceIds: Object.freeze([...evidenceIds]) }) });
}

function prefixedSha256(value) {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function absoluteProjectPath(root, project) {
  return resolve(root, project.path);
}

function relativeTarget(root, absolute) {
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(normalizedRoot)) throw new Error("client runtime target must stay inside repository root");
  return absolute.slice(normalizedRoot.length).split(sep).join("/");
}

function assertMatrix(artifacts, capability, browsers, viewports) {
  const observed = new Set(artifacts
    .filter((artifact) => artifact.capability === capability)
    .map((artifact) => `${artifact.metadata?.browser ?? ""}::${artifact.metadata?.viewport ?? ""}`));
  const missing = browsers.flatMap((browser) => viewports.map((viewport) => `${browser}::${viewport.name}`)).filter((key) => !observed.has(key));
  if (missing.length) throw new Error(`${capability} evidence matrix is incomplete: ${missing.join(", ")}`);
}

export async function createWorkspaceClientRuntimeAdapters(spec, options = {}) {
  if (!spec.runtime?.target) return Object.freeze({});
  const root = resolve(options.root ?? process.cwd());
  const projectsReader = options.projects ?? readProjects;
  const gitReader = options.git ?? readGitState;
  const readOnly = options.readOnly ?? runReadOnly;
  const buildRunner = options.build ?? buildTarget;
  const buildValidator = options.buildValidator ?? validateBuildManifest;
  const captureRunner = options.capture ?? captureProjectEvidence;
  const visualJudgeEvaluator = options.visualJudge ?? judgeVisualEvidence;
  const reviewReader = options.readReviewFile ?? ((path) => readFile(path, "utf8"));
  const prepareCapture = options.prepareCapture ?? (async () => {
    await runProcess("pnpm", ["--filter", "@nexus/capture...", "build"], { cwd: root, timeoutMs: 15 * 60_000, maxOutputBytes: 8 * 1024 * 1024 });
  });

  const projects = await projectsReader(root);
  const project = projects.find((candidate) => candidate.slug === spec.runtime.target);
  if (!project) throw new Error(`client runtime target ${spec.runtime.target} is not a discovered workspace app`);
  if (!project.workspaceMember || project.kind !== "CLIENT" || !project.clientProject) throw new Error(`client runtime target ${project.slug} is not an admitted CLIENT project`);
  if (spec.projectId !== project.slug) throw new Error(`pipeline projectId ${spec.projectId} must match runtime target ${project.slug}`);
  if (!spec.outputDir) throw new Error("workspace client runtime requires outputDir");
  const outputDir = resolve(spec.outputDir);
  const projectDir = absoluteProjectPath(root, project);
  if (outputDir !== projectDir) throw new Error(`pipeline outputDir must be the admitted runtime project path ${project.path}`);
  if (relativeTarget(root, outputDir) !== project.path.split("\\").join("/")) throw new Error("pipeline outputDir/project path binding is inconsistent");

  const initialGit = await gitReader(root);
  if (initialGit.headSha !== spec.sourceRevision) throw new Error(`pipeline sourceRevision ${spec.sourceRevision} does not match repository HEAD ${initialGit.headSha}`);

  let captureEvidence;
  const browsers = Object.freeze([...(spec.runtime.browsers ?? DEFAULT_BROWSERS)]);
  const viewports = Object.freeze([...(spec.runtime.viewports ?? DEFAULT_VIEWPORTS)]);
  if (!browsers.length || !viewports.length) throw new Error("client runtime browser/viewport matrix cannot be empty");

  const adapters = {
    render: async ({ generation }) => {
      const current = await gitReader(root);
      if (current.headSha !== spec.sourceRevision) return gate("RENDER", "FAIL", `repository HEAD moved to ${current.headSha}; expected ${spec.sourceRevision}`, [generation.generationDigest]);
      const dirtyTarget = (await readOnly("git", ["status", "--porcelain", "--", project.path], root)).trim();
      if (dirtyTarget) return gate("RENDER", "FAIL", "regenerated client source differs from the committed sourceRevision; commit the generated bytes and rerun before build/capture", [generation.generationDigest]);
      const requestId = `client-pipeline-${project.slug}-${spec.sourceRevision.slice(0, 12)}`;
      const execution = await buildRunner(root, project, spec.sourceRevision, requestId);
      if (!execution.manifest) {
        return gate("RENDER", execution.unavailableReason ? "NOT_TESTED" : "FAIL", execution.unavailableReason ?? `build exited ${execution.exitCode ?? "without manifest"}`, [generation.generationDigest]);
      }
      const valid = await buildValidator(root, project, spec.sourceRevision, execution.manifest);
      if (!valid) return gate("RENDER", "FAIL", "SHA-bound build manifest failed integrity validation", [generation.generationDigest, prefixedSha256(execution.manifest.manifestSha256)]);
      return Object.freeze({
        ...gate("RENDER", "PASS", "committed generated client rebuilt successfully with a validated SHA-bound build manifest", [generation.generationDigest, prefixedSha256(execution.manifest.manifestSha256), prefixedSha256(execution.manifest.outputDigest)]),
        project,
        build: execution,
      });
    },

    capture: async ({ generation, render }) => {
      if (render?.gate?.verdict !== "PASS") return gate("CAPTURE", "NOT_TESTED", "capture requires a passing SHA-bound render/build");
      await prepareCapture();
      const requestId = `client-quality-${project.slug}-${spec.sourceRevision.slice(0, 12)}-${generation.generationDigest.replace(/^sha256:/, "").slice(0, 12)}`;
      captureEvidence = await captureRunner(root, project, spec.sourceRevision, requestId, undefined, { capabilities: DEFAULT_CAPABILITIES, browsers, viewports });
      assertMatrix(captureEvidence.artifacts, "SCREENSHOT", browsers, viewports);
      assertMatrix(captureEvidence.artifacts, "ACCESSIBILITY", browsers, viewports);
      const evidenceIds = captureEvidence.artifacts.filter((artifact) => artifact.capability !== "DESIGN_GENOME").map((artifact) => artifact.digest);
      if (!evidenceIds.length) return gate("CAPTURE", "FAIL", "browser run returned no non-genome capture evidence");
      return Object.freeze({
        ...gate("CAPTURE", "PASS", "real Playwright evidence captured from the exact committed client build across the required browser/viewport matrix", evidenceIds),
        evidence: captureEvidence,
      });
    },

    designGenome: async ({ capture }) => {
      const evidence = capture?.evidence ?? captureEvidence;
      if (!evidence) return gate("DESIGN_GENOME", "NOT_TESTED", "design genome requires a completed real browser capture");
      assertMatrix(evidence.artifacts, "DESIGN_GENOME", browsers, viewports);
      const genomes = evidence.artifacts.filter((artifact) => artifact.capability === "DESIGN_GENOME");
      if (!genomes.length) return gate("DESIGN_GENOME", "FAIL", "browser evidence contained no measured design genome artifacts");
      return Object.freeze({
        ...gate("DESIGN_GENOME", "PASS", "design genome was measured from the same exact-SHA browser run used for capture evidence", genomes.map((artifact) => artifact.digest)),
        artifacts: Object.freeze([...genomes]),
      });
    },
  };

  if (spec.runtime.visualReviewFile) {
    adapters.visualJudge = async ({ capture }) => {
      const evidence = capture?.evidence ?? captureEvidence;
      if (!evidence) return gate("VISUAL_JUDGE", "NOT_TESTED", "visual judge requires completed exact-SHA browser evidence");
      try {
        const committed = await loadCommittedVisualReview({
          root,
          relativePath: spec.runtime.visualReviewFile,
          projectId: spec.projectId,
          sourceRevision: spec.sourceRevision,
          readOnly,
          reader: reviewReader,
        });
        const evaluated = await evaluateDigestBoundVisualReview({ committed, artifacts: evidence.artifacts, evaluator: visualJudgeEvaluator });
        const report = evaluated.report;
        return Object.freeze({
          ...gate("VISUAL_JUDGE", report.approved && report.verdict === "PASS" ? "PASS" : report.verdict === "NOT_TESTED" ? "NOT_TESTED" : "FAIL", report.approved ? "committed visual review passed against exact artifact IDs and SHA-256 bytes" : report.findings.join("; ") || "visual review did not approve the evidence", evaluated.evidenceIds),
          report,
        });
      } catch (error) {
        return gate("VISUAL_JUDGE", "FAIL", `digest-bound visual review failed closed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  if (spec.runtime.redTeamEvidenceFile) {
    adapters.redTeam = createProductionRedTeamAdapter(
      { root, project, spec, browsers, viewports },
      { git: gitReader, readOnly, ...(options.redTeamDependencies ?? {}) },
    );
  }

  if (spec.runtime.visualReviewFile) {
    adapters.repairRejudge = createProductionQualityCycleAdapter(
      { root, project, spec, browsers, viewports, prepareCapture },
      {
        git: gitReader,
        readOnly,
        build: buildRunner,
        buildValidator,
        capture: captureRunner,
        visualJudge: visualJudgeEvaluator,
        readReviewFile: reviewReader,
        ...(options.qualityCycleDependencies ?? {}),
      },
    );
  }

  return Object.freeze(adapters);
}
