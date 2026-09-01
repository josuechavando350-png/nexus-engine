import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { NexusCreativeCritic } from "../packages/creative/critic/index.ts";
import { validateGalleryEntry } from "../packages/creative/gallery/index.ts";
import { runBrowserMutationSuite } from "../packages/capture/mutation-runner.ts";
import { runRemovalExperiments } from "../packages/capture/removal-experiment.ts";
import { validateStyleFingerprintV2 } from "../packages/experience/originality.ts";
import { readGitState } from "../packages/mcp-server/src/git.ts";
import { withProjectServer } from "../packages/mcp-server/src/project-server.ts";
import { runReadOnly } from "../packages/mcp-server/src/process.ts";
import { createEvidenceBackedExcessCandidate, evaluateExcessRemoval } from "../packages/quality/excess-removal.ts";
import { evaluateBrowserMutationEvidence } from "../packages/quality/mutation-evaluator.ts";
import { runRedTeamArena } from "../packages/quality/red-team.ts";
import { evaluateStructuralFingerprints } from "../packages/quality/structural-fingerprint.ts";

function gate(verdict, detail, evidenceIds = []) {
  return Object.freeze({ gate: Object.freeze({ gateId: "RED_TEAM", verdict, detail, evidenceIds: Object.freeze([...new Set(evidenceIds)]) }) });
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function repositoryPath(root, candidate, label) {
  const absolute = resolve(root, candidate);
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(normalizedRoot)) throw new Error(`${label} must stay inside repository root`);
  return { absolute, relative: absolute.slice(normalizedRoot.length).split(sep).join("/") };
}

async function defaultCommittedFileReader(root, relativePath, sourceRevision, readOnly = runReadOnly) {
  const file = repositoryPath(root, relativePath, "red-team evidence file");
  const dirty = (await readOnly("git", ["status", "--porcelain", "--", file.relative], root)).trim();
  if (dirty) throw new Error("red-team evidence file must be committed and clean");
  const committedBlob = (await readOnly("git", ["rev-parse", `${sourceRevision}:${file.relative}`], root)).trim();
  const workingBlob = (await readOnly("git", ["hash-object", "--", file.relative], root)).trim();
  if (!/^[a-f0-9]{40}$/.test(committedBlob) || committedBlob !== workingBlob) throw new Error("red-team evidence bytes are not identical to the declared sourceRevision blob");
  const bytes = await readFile(file.absolute);
  return Object.freeze({ raw: bytes.toString("utf8"), digest: sha256(bytes), relativePath: file.relative, blobSha: committedBlob });
}

function validateEnvelope(value, spec) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("red-team evidence envelope must be an object");
  if (value.schemaVersion !== 1) throw new Error("red-team evidence schemaVersion must be 1");
  if (value.projectId !== spec.projectId) throw new Error(`red-team evidence projectId ${value.projectId ?? "missing"} does not match ${spec.projectId}`);
  if (value.sourceRevision !== spec.sourceRevision) throw new Error(`red-team evidence sourceRevision ${value.sourceRevision ?? "missing"} does not match ${spec.sourceRevision}`);
  if (!value.creativeContract || typeof value.creativeContract !== "object") throw new Error("red-team evidence creativeContract is required");
  if (value.creativeContract.projectId !== spec.projectId) throw new Error("creativeContract projectId must match the active project");
  if (!Array.isArray(value.galleryReferences)) throw new Error("red-team evidence galleryReferences must be an array");
  if (!Array.isArray(value.priorFingerprints)) throw new Error("red-team evidence priorFingerprints must be an array");
  if (!value.mutations || typeof value.mutations !== "object") throw new Error("red-team evidence mutations are required");
  if (!value.mutations.brandSwap || typeof value.mutations.brandSwap !== "object") throw new Error("red-team evidence brandSwap mutation is required");
  if (!Array.isArray(value.mutations.industryTransplant) || value.mutations.industryTransplant.length === 0) throw new Error("red-team evidence industryTransplant replacements are required");
  if (value.mutationVisualReviews !== undefined && !Array.isArray(value.mutationVisualReviews)) throw new Error("mutationVisualReviews must be an array when supplied");
  if (value.excessRemoval !== undefined) {
    if (!value.excessRemoval || typeof value.excessRemoval !== "object" || Array.isArray(value.excessRemoval)) throw new Error("excessRemoval must be an object when supplied");
    if (!Array.isArray(value.excessRemoval.candidates) || value.excessRemoval.candidates.length === 0) throw new Error("excessRemoval candidates must be a non-empty array");
    if (value.excessRemoval.reviews !== undefined && !Array.isArray(value.excessRemoval.reviews)) throw new Error("excessRemoval reviews must be an array when supplied");
  }
  return value;
}

function validateReplacement(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} replacement must be an object`);
  if (typeof value.from !== "string" || !value.from.trim() || typeof value.to !== "string" || !value.to.trim()) throw new Error(`${label} replacement requires non-empty from/to`);
  if (value.from === value.to) throw new Error(`${label} replacement must change rendered text`);
  return Object.freeze({ from: value.from, to: value.to });
}

function validateRemovalCandidate(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`excessRemoval.candidates[${index}] must be an object`);
  if (typeof value.elementId !== "string" || !value.elementId.trim()) throw new Error(`excessRemoval.candidates[${index}].elementId is required`);
  if (typeof value.selector !== "string" || !value.selector.trim()) throw new Error(`excessRemoval.candidates[${index}].selector is required`);
  if (!Array.isArray(value.purposes)) throw new Error(`excessRemoval.candidates[${index}].purposes must be an array`);
  if (typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error(`excessRemoval.candidates[${index}].rationale is required`);
  return Object.freeze({ elementId: value.elementId.trim(), selector: value.selector.trim(), purposes: Object.freeze([...value.purposes]), rationale: value.rationale.trim() });
}

function validateRemovalConfiguration(excessRemoval, browsers, viewports) {
  if (!excessRemoval) return undefined;
  const candidates = Object.freeze(excessRemoval.candidates.map(validateRemovalCandidate));
  if (new Set(candidates.map((candidate) => candidate.elementId)).size !== candidates.length) throw new Error("excessRemoval candidate elementId values must be unique");
  if (new Set(candidates.map((candidate) => candidate.selector)).size !== candidates.length) throw new Error("excessRemoval candidate selectors must be unique");
  const reviews = Object.freeze([...(excessRemoval.reviews ?? [])]);
  if (new Set(reviews.map((review) => review?.elementId)).size !== reviews.length) throw new Error("excessRemoval review elementId values must be unique");
  const candidateIds = new Set(candidates.map((candidate) => candidate.elementId));
  const orphanReviews = reviews.filter((review) => !review || typeof review !== "object" || !candidateIds.has(review.elementId));
  if (orphanReviews.length) throw new Error("excessRemoval reviews must reference configured candidate elementIds");
  const browser = excessRemoval.browser ?? browsers[0];
  if (!browser || !browsers.includes(browser) || !["chromium", "webkit"].includes(browser)) throw new Error(`excessRemoval browser ${browser ?? "missing"} is outside the required runtime browser matrix`);
  const viewportName = excessRemoval.viewport ?? viewports[0]?.name;
  const viewport = viewports.find((candidate) => candidate.name === viewportName);
  if (!viewport) throw new Error(`excessRemoval viewport ${viewportName ?? "missing"} is outside the required runtime viewport matrix`);
  return Object.freeze({ candidates, reviews, browser, viewport });
}

async function readVerifiedGenomeArtifacts(artifacts, fileReader = readFile) {
  const genomeArtifacts = artifacts.filter((artifact) => artifact.capability === "DESIGN_GENOME");
  if (!genomeArtifacts.length) throw new Error("red-team structural analysis requires DESIGN_GENOME artifacts from the current capture run");
  const genomes = [];
  for (const artifact of genomeArtifacts) {
    if (!artifact.uri) throw new Error(`DESIGN_GENOME artifact ${artifact.artifactId} has no URI`);
    const bytes = await fileReader(artifact.uri);
    const observedDigest = sha256(bytes);
    if (observedDigest !== artifact.digest) throw new Error(`DESIGN_GENOME artifact ${artifact.artifactId} digest mismatch`);
    genomes.push(JSON.parse(bytes.toString("utf8")));
  }
  return Object.freeze(genomes);
}

function aggregateGateVerdict(redTeam, excessRemoval) {
  if (redTeam.verdict === "FAIL" || excessRemoval.verdict === "FAIL") return "FAIL";
  if (redTeam.verdict === "NOT_TESTED" || excessRemoval.verdict === "NOT_TESTED") return "NOT_TESTED";
  if (redTeam.verdict === "WARNING" || excessRemoval.verdict === "WARNING") return "WARNING";
  return "PASS";
}

function evidenceFromMutationSuite(suite) {
  return suite.artifacts.flatMap((artifact) => [artifact.screenshotDigest, artifact.diagnosticsDigest]);
}

function evidenceFromRemovalExperiments(experiments) {
  return experiments?.artifacts?.flatMap((artifact) => [artifact.beforeScreenshotDigest, artifact.afterScreenshotDigest, artifact.diagnosticsDigest]) ?? [];
}

export function createProductionRedTeamAdapter(context, dependencies = {}) {
  const { root, project, spec, browsers, viewports } = context;
  const gitReader = dependencies.git ?? readGitState;
  const readOnly = dependencies.readOnly ?? runReadOnly;
  const committedFileReader = dependencies.committedFileReader ?? ((repoRoot, path, sourceSha) => defaultCommittedFileReader(repoRoot, path, sourceSha, readOnly));
  const genomeFileReader = dependencies.genomeFileReader ?? readFile;
  const serverRunner = dependencies.withProjectServer ?? withProjectServer;
  const mutationRunner = dependencies.runBrowserMutationSuite ?? runBrowserMutationSuite;
  const removalRunner = dependencies.runRemovalExperiments ?? runRemovalExperiments;
  const mutationEvaluator = dependencies.evaluateBrowserMutationEvidence ?? evaluateBrowserMutationEvidence;
  const structuralEvaluator = dependencies.evaluateStructuralFingerprints ?? evaluateStructuralFingerprints;
  const redTeamRunner = dependencies.runRedTeamArena ?? runRedTeamArena;
  const excessCandidateFactory = dependencies.createEvidenceBackedExcessCandidate ?? createEvidenceBackedExcessCandidate;
  const excessEvaluator = dependencies.evaluateExcessRemoval ?? evaluateExcessRemoval;
  const critic = dependencies.creativeCritic ?? new NexusCreativeCritic();

  return async function redTeamAdapter({ capture, visualJudge }) {
    if (visualJudge?.gate?.verdict !== "PASS") return gate("NOT_TESTED", "production Red Team requires a passing exact-evidence Visual Judge");
    const captureEvidence = capture?.evidence;
    if (!captureEvidence?.artifacts?.length) return gate("NOT_TESTED", "production Red Team requires persisted browser capture evidence");
    try {
      const git = await gitReader(root);
      if (git.headSha !== spec.sourceRevision) return gate("FAIL", `repository HEAD moved to ${git.headSha}; expected ${spec.sourceRevision}`);
      if (!git.clean) return gate("FAIL", "production Red Team requires a clean exact-SHA checkout");

      const committed = await committedFileReader(root, spec.runtime.redTeamEvidenceFile, spec.sourceRevision);
      const envelope = validateEnvelope(JSON.parse(committed.raw), spec);
      const fingerprint = validateStyleFingerprintV2(envelope.fingerprint);
      if (fingerprint.subject !== spec.projectId) throw new Error(`current fingerprint subject ${fingerprint.subject} does not match ${spec.projectId}`);
      const priorFingerprints = Object.freeze(envelope.priorFingerprints.map((item) => validateStyleFingerprintV2(item)));
      if (priorFingerprints.some((item) => item.subject === fingerprint.subject)) throw new Error("prior fingerprint corpus cannot contain the active project fingerprint");
      if (new Set(priorFingerprints.map((item) => item.subject)).size !== priorFingerprints.length) throw new Error("prior fingerprint corpus subjects must be unique");
      const references = Object.freeze(envelope.galleryReferences.map((entry) => validateGalleryEntry(entry)));
      const brandSwap = validateReplacement(envelope.mutations.brandSwap, "brandSwap");
      const industryTransplant = Object.freeze(envelope.mutations.industryTransplant.map((item, index) => validateReplacement(item, `industryTransplant[${index}]`)));
      const removalConfig = validateRemovalConfiguration(envelope.excessRemoval, browsers, viewports);
      const genomes = await readVerifiedGenomeArtifacts(captureEvidence.artifacts, genomeFileReader);

      const outputDir = join(tmpdir(), "nexus-client-red-team", project.slug, spec.sourceRevision, committed.digest.replace(/^sha256:/, ""));
      await mkdir(outputDir, { recursive: true });
      const execution = await serverRunner(root, project, async (targetUrl) => {
        const mutationSuite = await mutationRunner({
          targetUrl,
          outputDir: join(outputDir, "mutations"),
          browser: envelope.mutations.browser ?? "chromium",
          brandSwap,
          industryTransplant,
        });
        const removalExperiments = removalConfig ? await removalRunner({
          targetUrl,
          outputDir: join(outputDir, "removal-experiments"),
          browser: removalConfig.browser,
          viewport: { width: removalConfig.viewport.width, height: removalConfig.viewport.height },
          candidates: removalConfig.candidates.map((candidate) => ({ elementId: candidate.elementId, selector: candidate.selector })),
        }) : undefined;
        return Object.freeze({ mutationSuite, removalExperiments });
      });
      const suite = execution.mutationSuite;
      const removalExperiments = execution.removalExperiments;
      if (suite.authority !== "NEXUS_BROWSER_MUTATION_RUNNER") throw new Error("browser mutation runner returned an invalid authority");
      if (removalConfig && removalExperiments?.authority !== "NEXUS_REMOVAL_EXPERIMENT_RUNNER") throw new Error("removal experiment runner returned an invalid authority");
      if (removalConfig && removalExperiments.artifacts.length !== removalConfig.candidates.length) throw new Error("removal experiment runner did not return one artifact per configured candidate");

      const mutationEvaluation = mutationEvaluator(suite.artifacts, envelope.mutationPolicy, envelope.mutationVisualReviews ?? []);
      if (mutationEvaluation.authority !== "NEXUS_MUTATION_EVIDENCE_EVALUATOR") throw new Error("mutation evaluator returned an invalid authority");

      const brandVerdict = mutationEvaluation.verdicts.BRAND_SWAP === "PASS"
        ? "PASS"
        : mutationEvaluation.verdicts.BRAND_SWAP === "NOT_TESTED"
          ? "NOT_TESTED"
          : "FAIL";
      const industryReasons = mutationEvaluation.verdicts.INDUSTRY_TRANSPLANT === "PASS"
        ? []
        : mutationEvaluation.findings.filter((finding) => finding.startsWith("INDUSTRY_TRANSPLANT:"));
      const creativeContract = Object.freeze({
        ...envelope.creativeContract,
        adversarial: Object.freeze({
          ...envelope.creativeContract.adversarial,
          brandSwapVerdict: brandVerdict,
          crossIndustryReuseReasons: Object.freeze(industryReasons),
        }),
      });
      const creativeReport = critic.evaluate(creativeContract, references);
      const structuralFingerprint = structuralEvaluator({
        fingerprint,
        priorFingerprints,
        genomes,
        ...(envelope.structuralFingerprintPolicy ? { policy: envelope.structuralFingerprintPolicy } : {}),
      });
      const browserEvidencePolicy = Object.freeze({ browsers: Object.freeze([...browsers]), viewports: Object.freeze(viewports.map((viewport) => viewport.name)) });
      const report = redTeamRunner({
        experienceId: spec.projectId,
        creativeReport,
        fingerprint,
        corpus: priorFingerprints,
        artifacts: captureEvidence.artifacts,
        mutationVerdicts: mutationEvaluation.verdicts,
        mutationEvidence: mutationEvaluation.evidence,
        structuralFingerprint,
        ...(envelope.originalityPolicy ? { originalityPolicy: envelope.originalityPolicy } : {}),
        browserEvidencePolicy,
      });

      let excessCandidates = [];
      if (removalConfig) {
        const artifactByElementId = new Map(removalExperiments.artifacts.map((artifact) => [artifact.elementId, artifact]));
        if (artifactByElementId.size !== removalExperiments.artifacts.length) throw new Error("removal experiment artifacts require unique elementId values");
        const reviewByElementId = new Map(removalConfig.reviews.map((review) => [review.elementId, review]));
        excessCandidates = removalConfig.candidates.map((candidate) => {
          const artifact = artifactByElementId.get(candidate.elementId);
          if (!artifact) throw new Error(`removal experiment evidence missing for ${candidate.elementId}`);
          return excessCandidateFactory({
            ...candidate,
            artifact,
            ...(reviewByElementId.has(candidate.elementId) ? { review: reviewByElementId.get(candidate.elementId) } : {}),
          });
        });
      }
      const excessRemoval = excessEvaluator(excessCandidates);
      const verdict = aggregateGateVerdict(report, excessRemoval);
      const evidenceIds = [
        committed.digest,
        ...captureEvidence.artifacts.map((artifact) => artifact.digest),
        ...evidenceFromMutationSuite(suite),
        ...evidenceFromRemovalExperiments(removalExperiments),
        ...report.attacks.flatMap((attack) => attack.evidence),
        ...excessRemoval.findings.flatMap((finding) => finding.evidenceIds),
      ];
      const detail = verdict === "PASS"
        ? "production Red Team and evidence-backed Excess Removal passed"
        : excessRemoval.verdict === "NOT_TESTED"
          ? removalExperiments
            ? `Red Team arena=${report.verdict}; Excess Removal executed real before/after experiments but still requires evidence-bound human review for non-objective loss`
            : `Red Team arena=${report.verdict}; Excess Removal remains NOT_TESTED because no removal candidates were configured`
          : `Red Team arena=${report.verdict}; Excess Removal=${excessRemoval.verdict}`;
      return Object.freeze({
        ...gate(verdict, detail, evidenceIds),
        report,
        excessRemoval,
        mutationEvaluation,
        mutationSuite: suite,
        removalExperiments,
        structuralFingerprint,
        creativeReport,
      });
    } catch (error) {
      return gate("FAIL", `production Red Team failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
