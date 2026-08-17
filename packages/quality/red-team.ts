import type { CaptureArtifact } from "@nexus/capture";
import type { CreativeCriticReport, VerdictState } from "@nexus/creative";
import {
  compareFingerprints,
  type OriginalityPolicy,
  type SimilarityReport,
  type StyleFingerprintV2,
} from "@nexus/experience";

export type MutationAttackId =
  | "BRAND_SWAP"
  | "INDUSTRY_TRANSPLANT"
  | "CONTENT_STRESS"
  | "ASSET_DEGRADATION"
  | "VIEWPORT_TORTURE"
  | "MOTION_REMOVAL"
  | "GRAYSCALE";

export type RedTeamAttackId =
  | "CREATIVE_CRITIC"
  | "CORPUS_ORIGINALITY"
  | "BROWSER_COVERAGE"
  | "ACCESSIBILITY_EVIDENCE"
  | MutationAttackId;

export interface RedTeamAttackResult {
  attackId: RedTeamAttackId;
  verdict: VerdictState;
  detail: string;
  evidence: readonly string[];
}

export interface BrowserEvidencePolicy {
  browsers: readonly string[];
  viewports: readonly string[];
}

export interface RedTeamArenaInput {
  experienceId: string;
  creativeReport: CreativeCriticReport;
  fingerprint: StyleFingerprintV2;
  corpus: readonly StyleFingerprintV2[];
  artifacts: readonly CaptureArtifact[];
  mutationVerdicts: Readonly<Record<MutationAttackId, VerdictState>>;
  originalityPolicy?: OriginalityPolicy;
  browserEvidencePolicy?: BrowserEvidencePolicy;
}

export interface RedTeamArenaReport {
  authority: "NEXUS_RED_TEAM_ARENA";
  experienceId: string;
  verdict: VerdictState;
  approved: boolean;
  attacks: readonly RedTeamAttackResult[];
  similarityReports: readonly SimilarityReport[];
}

const DEFAULT_BROWSER_POLICY: BrowserEvidencePolicy = Object.freeze({
  browsers: Object.freeze(["chromium", "webkit"]),
  viewports: Object.freeze(["mobile-390", "tablet-768", "desktop-1440"]),
});

function attack(
  attackId: RedTeamAttackId,
  verdict: VerdictState,
  detail: string,
  evidence: readonly string[] = [],
): RedTeamAttackResult {
  return Object.freeze({ attackId, verdict, detail, evidence: Object.freeze([...evidence]) });
}

function matrixKey(browser: string, viewport: string): string {
  return `${browser.trim().toLowerCase()}::${viewport.trim().toLowerCase()}`;
}

function artifactMatrix(artifacts: readonly CaptureArtifact[], capability: CaptureArtifact["capability"]): Set<string> {
  const matrix = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.capability !== capability) continue;
    const browser = artifact.metadata?.browser;
    const viewport = artifact.metadata?.viewport;
    if (browser && viewport && artifact.uri && artifact.digest.startsWith("sha256:") && artifact.byteLength > 0) {
      matrix.add(matrixKey(browser, viewport));
    }
  }
  return matrix;
}

function coverageAttack(
  attackId: "BROWSER_COVERAGE" | "ACCESSIBILITY_EVIDENCE",
  artifacts: readonly CaptureArtifact[],
  capability: "SCREENSHOT" | "ACCESSIBILITY",
  policy: BrowserEvidencePolicy,
): RedTeamAttackResult {
  const observed = artifactMatrix(artifacts, capability);
  const required = policy.browsers.flatMap((browser) => policy.viewports.map((viewport) => matrixKey(browser, viewport)));
  const missing = required.filter((key) => !observed.has(key));
  if (missing.length) {
    return attack(
      attackId,
      "FAIL",
      `${capability.toLowerCase()} evidence is incomplete for the required browser/viewport matrix`,
      missing.map((key) => `missing:${key}`),
    );
  }
  return attack(
    attackId,
    "PASS",
    `${capability.toLowerCase()} evidence covers every required browser/viewport pair`,
    required.map((key) => `observed:${key}`),
  );
}

function originalityAttack(
  fingerprint: StyleFingerprintV2,
  corpus: readonly StyleFingerprintV2[],
  policy?: OriginalityPolicy,
): { result: RedTeamAttackResult; reports: SimilarityReport[] } {
  if (!corpus.length) {
    return {
      result: attack("CORPUS_ORIGINALITY", "NOT_TESTED", "no comparison corpus was supplied"),
      reports: [],
    };
  }

  const reports = corpus.map((candidate) => compareFingerprints(fingerprint, candidate, { policy }));
  const exactDuplicates = reports.filter((report) => report.warnings.some((warning) => warning.startsWith("exact structural duplication")));
  if (exactDuplicates.length) {
    return {
      result: attack(
        "CORPUS_ORIGINALITY",
        "FAIL",
        "exact structural duplication was detected against the corpus",
        exactDuplicates.map((report) => `duplicate:${report.right}`),
      ),
      reports,
    };
  }

  const policyWarnings = reports.flatMap((report) => report.warnings.map((warning) => `${report.right}:${warning}`));
  if (policyWarnings.length) {
    return {
      result: attack("CORPUS_ORIGINALITY", "WARNING", "evidence-backed originality policy produced warnings", policyWarnings),
      reports,
    };
  }

  return {
    result: attack("CORPUS_ORIGINALITY", "PASS", "no exact structural duplication or configured originality warning was detected"),
    reports,
  };
}

function aggregateVerdict(attacks: readonly RedTeamAttackResult[]): VerdictState {
  if (attacks.some((item) => item.verdict === "FAIL")) return "FAIL";
  if (attacks.some((item) => item.verdict === "NOT_TESTED")) return "NOT_TESTED";
  if (attacks.some((item) => item.verdict === "WARNING")) return "WARNING";
  return "PASS";
}

export function runRedTeamArena(input: RedTeamArenaInput): RedTeamArenaReport {
  if (!input.experienceId.trim()) throw new Error("experienceId is required");
  const browserPolicy = input.browserEvidencePolicy ?? DEFAULT_BROWSER_POLICY;
  if (!browserPolicy.browsers.length || !browserPolicy.viewports.length) throw new Error("browser evidence policy cannot be empty");

  const attacks: RedTeamAttackResult[] = [];
  attacks.push(attack(
    "CREATIVE_CRITIC",
    input.creativeReport.verdict,
    input.creativeReport.approved ? "creative critic approved the execution contract" : "creative critic did not approve the execution contract",
    input.creativeReport.findings.map((finding) => `${finding.code}:${finding.detail}`),
  ));

  const originality = originalityAttack(input.fingerprint, input.corpus, input.originalityPolicy);
  attacks.push(originality.result);
  attacks.push(coverageAttack("BROWSER_COVERAGE", input.artifacts, "SCREENSHOT", browserPolicy));
  attacks.push(coverageAttack("ACCESSIBILITY_EVIDENCE", input.artifacts, "ACCESSIBILITY", browserPolicy));

  const requiredMutationAttacks: readonly MutationAttackId[] = [
    "BRAND_SWAP",
    "INDUSTRY_TRANSPLANT",
    "CONTENT_STRESS",
    "ASSET_DEGRADATION",
    "VIEWPORT_TORTURE",
    "MOTION_REMOVAL",
    "GRAYSCALE",
  ];
  for (const attackId of requiredMutationAttacks) {
    const verdict = input.mutationVerdicts[attackId];
    attacks.push(attack(
      attackId,
      verdict,
      verdict === "PASS"
        ? `${attackId.toLowerCase()} attack passed`
        : verdict === "FAIL"
          ? `${attackId.toLowerCase()} attack exposed a shipping blocker`
          : verdict === "WARNING"
            ? `${attackId.toLowerCase()} attack produced a non-blocking warning`
            : `${attackId.toLowerCase()} attack has not been executed`,
    ));
  }

  const verdict = aggregateVerdict(attacks);
  return Object.freeze({
    authority: "NEXUS_RED_TEAM_ARENA",
    experienceId: input.experienceId,
    verdict,
    approved: verdict === "PASS",
    attacks: Object.freeze(attacks),
    similarityReports: Object.freeze(originality.reports),
  });
}
