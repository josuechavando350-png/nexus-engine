import { createHash } from "node:crypto";
import { readGitState } from "../packages/mcp-server/src/git.ts";
import { buildTarget, validateBuildManifest } from "../packages/mcp-server/src/build.ts";
import { captureProjectEvidence } from "../packages/mcp-server/src/capture.ts";
import { runQualityCycle } from "../packages/quality/quality-cycle.ts";
import { loadCommittedVisualReview, evaluateDigestBoundVisualReview } from "./nexus-client-visual-review.mjs";

const DEFAULT_CAPABILITIES = Object.freeze(["SCREENSHOT", "ACCESSIBILITY", "DESIGN_GENOME", "CONTRAST", "PERFORMANCE"]);

class RepairAuthorityUnavailableError extends Error {
  constructor() {
    super("quality cycle found non-passing evidence but no governed source repair authority is implemented");
    this.name = "RepairAuthorityUnavailableError";
  }
}

function gate(verdict, detail, evidenceIds = []) {
  return Object.freeze({ gate: Object.freeze({ gateId: "REPAIR_REJUDGE", verdict, detail, evidenceIds: Object.freeze([...new Set(evidenceIds)]) }) });
}

function prefixedSha256(value) {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function digestObject(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("quality cycle clock must produce a canonical UTC timestamp");
  return value;
}

function assertMatrix(artifacts, capability, browsers, viewports) {
  const observed = new Set(artifacts
    .filter((artifact) => artifact.capability === capability)
    .map((artifact) => `${artifact.metadata?.browser ?? ""}::${artifact.metadata?.viewport ?? ""}`));
  const missing = browsers.flatMap((browser) => viewports.map((viewport) => `${browser}::${viewport.name}`)).filter((key) => !observed.has(key));
  if (missing.length) throw new Error(`${capability} quality-cycle evidence matrix is incomplete: ${missing.join(", ")}`);
}

export function createProductionQualityCycleAdapter(context, dependencies = {}) {
  const { root, project, spec, browsers, viewports, prepareCapture } = context;
  const gitReader = dependencies.git ?? readGitState;
  const buildRunner = dependencies.build ?? buildTarget;
  const buildValidator = dependencies.buildValidator ?? validateBuildManifest;
  const captureRunner = dependencies.capture ?? captureProjectEvidence;
  const cycleRunner = dependencies.runQualityCycle ?? runQualityCycle;
  const clock = dependencies.clock ?? (() => new Date());
  const visualJudgeEvaluator = dependencies.visualJudge;
  const readOnly = dependencies.readOnly;
  const reviewReader = dependencies.readReviewFile;

  return async function qualityCycleAdapter({ generation }) {
    if (!spec.runtime?.visualReviewFile) return gate("NOT_TESTED", "quality cycle requires a configured digest-bound visual review file");
    const captureByRevision = new Map();
    try {
      const initialGit = await gitReader(root);
      if (initialGit.headSha !== spec.sourceRevision) return gate("FAIL", `quality cycle source revision moved to ${initialGit.headSha}; expected ${spec.sourceRevision}`);
      if (!initialGit.clean) return gate("FAIL", "quality cycle requires a clean exact-SHA checkout");

      const executor = {
        currentRevision: async () => {
          const git = await gitReader(root);
          if (!git.clean) throw new Error("quality cycle requires a clean checkout at every revision boundary");
          return git.headSha;
        },
        build: async (revision) => {
          if (revision !== spec.sourceRevision) throw new Error("quality cycle cannot certify a repaired revision until the full pipeline is restarted on that new sourceRevision");
          const requestId = `client-cycle-build-${project.slug}-${revision.slice(0, 12)}`;
          const execution = await buildRunner(root, project, revision, requestId);
          if (!execution.manifest) throw new Error(execution.unavailableReason ?? `quality cycle build exited ${execution.exitCode ?? "without manifest"}`);
          if (!(await buildValidator(root, project, revision, execution.manifest))) throw new Error("quality cycle build manifest failed exact-SHA integrity validation");
          return Object.freeze({
            evidenceId: `build:${prefixedSha256(execution.manifest.manifestSha256)}`,
            stage: "BUILD",
            subjectRevision: revision,
            producedAt: canonicalTimestamp(clock().toISOString()),
          });
        },
        capture: async (revision) => {
          if (revision !== spec.sourceRevision) throw new Error("quality cycle recapture refused a revision different from the active pipeline sourceRevision");
          await prepareCapture();
          const requestId = `client-quality-${project.slug}-${revision.slice(0, 12)}-${generation.generationDigest.replace(/^sha256:/, "").slice(0, 12)}`;
          const evidence = await captureRunner(root, project, revision, requestId, undefined, { capabilities: DEFAULT_CAPABILITIES, browsers, viewports });
          assertMatrix(evidence.artifacts, "SCREENSHOT", browsers, viewports);
          assertMatrix(evidence.artifacts, "DESIGN_GENOME", browsers, viewports);
          const artifactIdentity = evidence.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, digest: artifact.digest })).sort((a, b) => a.artifactId.localeCompare(b.artifactId, "en"));
          const evidenceId = `capture:${digestObject({ revision, artifactIdentity })}`;
          captureByRevision.set(revision, evidence);
          return Object.freeze({ evidenceId, stage: "CAPTURE", subjectRevision: revision, producedAt: canonicalTimestamp(clock().toISOString()) });
        },
        judge: async (revision, freshEvidence) => {
          const captureEvidence = captureByRevision.get(revision);
          if (!captureEvidence) throw new Error(`quality cycle has no fresh capture evidence for ${revision}`);
          const committed = await loadCommittedVisualReview({
            root,
            relativePath: spec.runtime.visualReviewFile,
            projectId: spec.projectId,
            sourceRevision: revision,
            ...(readOnly ? { readOnly } : {}),
            ...(reviewReader ? { reader: reviewReader } : {}),
          });
          const evaluated = await evaluateDigestBoundVisualReview({
            committed,
            artifacts: captureEvidence.artifacts,
            ...(visualJudgeEvaluator ? { evaluator: visualJudgeEvaluator } : {}),
          });
          const report = evaluated.report;
          const evidenceId = `judge:${digestObject({ revision, review: committed.rawDigest, evidenceIds: evaluated.evidenceIds, verdict: report.verdict })}`;
          return Object.freeze({
            evaluation: Object.freeze({
              verdict: report.verdict,
              findings: Object.freeze([...report.findings]),
              evidenceIds: Object.freeze([...freshEvidence.map((item) => item.evidenceId), evidenceId, ...evaluated.evidenceIds]),
            }),
            evidence: Object.freeze({ evidenceId, stage: "JUDGE", subjectRevision: revision, producedAt: canonicalTimestamp(clock().toISOString()) }),
            rubricVersion: committed.envelope.review.rubricVersion,
            rubricDigest: committed.envelope.review.rubricDigest.replace(/^sha256:/, ""),
          });
        },
        repair: async () => {
          throw new RepairAuthorityUnavailableError();
        },
      };

      const report = await cycleRunner(executor, { maxAttempts: 1 });
      const finalSnapshot = report.snapshots.at(-1);
      if (!finalSnapshot || finalSnapshot.revision !== spec.sourceRevision) return gate("FAIL", "quality cycle did not finish on the exact active sourceRevision");
      if (report.status !== "SHIPPABLE" || report.finalEvaluation.verdict !== "PASS") return gate("NOT_TESTED", report.reason ?? `quality cycle ended ${report.status}`);
      if (report.iterations.length || report.repairLineage.length) return gate("FAIL", "quality cycle produced a repair lineage without a governed source repair authority");
      const evidenceIds = report.snapshots.flatMap((snapshot) => [
        ...snapshot.evidence.map((item) => item.evidenceId),
        ...snapshot.evaluation.evidenceIds,
      ]);
      return Object.freeze({
        ...gate("PASS", "fresh exact-SHA rebuild, recapture and digest-bound rejudge passed; no source repair was required", evidenceIds),
        report,
      });
    } catch (error) {
      if (error instanceof RepairAuthorityUnavailableError) return gate("NOT_TESTED", error.message);
      return gate("FAIL", `production quality cycle failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
