import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProductionRedTeamAdapter } from "../scripts/nexus-client-red-team-runtime.mjs";

const SHA = "a".repeat(40);
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const project = {
  slug: "client",
  path: "apps/client",
  packageName: "@nexus/client",
  workspaceMember: true,
  kind: "CLIENT",
  clientProject: true,
  evidence: { packageJsonPath: "apps/client/package.json", clientProjectDeclaration: true, classificationRule: "test" },
};

const fingerprint = {
  version: 2,
  subject: "client",
  observedAt: "2026-09-01T00:00:00.000Z",
  openingSignature: "asymmetric evidence-led legal opening",
  navigationSignature: "quiet persistent edge navigation",
  sectionSequence: ["opening", "evidence", "practice", "contact"],
  structure: { cardReliance: 0.1, gridRegularity: 0.2, symmetry: 0.25, overlap: 0.2, whitespace: 0.7, continuity: 0.8 },
  ctaGrammar: ["direct-consultation"],
  geometryGrammar: ["editorial-rule", "open-field"],
  mediaGrammar: ["documentary-room"],
  motionGrammar: ["quiet-reveal"],
  typographyHierarchy: ["serif-thesis", "sans-support"],
};

const priorFingerprint = {
  ...fingerprint,
  subject: "prior-client",
  openingSignature: "document-led opening",
  navigationSignature: "top utility navigation",
  sectionSequence: ["premise", "services", "proof", "contact"],
};

const reference = (entryId: string) => ({
  schemaVersion: 1,
  entryId,
  scope: { tenantId: "tenant-1", brandId: "client" },
  kind: "SITE",
  title: `Reference ${entryId}`,
  description: "Observed composition reference retained as evidence, not copied styling.",
  source: { sourceId: `source-${entryId}`, sourceType: "REFERENCE", sourceUri: `https://example.com/${entryId}`, capturedAt: "2026-09-01T00:00:00.000Z", licenseIds: [] },
  tags: ["editorial"],
  intents: ["clarity"],
  techniques: ["asymmetry"],
  relatedEntryIds: [],
  createdAt: "2026-09-01T00:00:00.000Z",
});

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectId: "client",
    sourceRevision: SHA,
    creativeContract: {
      schemaVersion: 1,
      projectId: "client",
      scope: { tenantId: "tenant-1", brandId: "client" },
      visualThesis: "The experience behaves like an evidence dossier that reveals confidence through restraint and precise hierarchy.",
      signatureMechanic: "A continuous evidence rule connects the opening premise to proof and consultation without decorative cards.",
      compositionGrammar: ["asymmetric opening", "evidence rule", "documentary media"],
      businessSpecificSignals: ["legal practice", "consultation", "case evidence"],
      referenceEntryIds: ["ref-a", "ref-b"],
      referencePrinciples: ["restraint before decoration", "proof before persuasion"],
      conventionalPatterns: ["NAV", "CONTACT_FOOTER"],
      genericPatternsRejected: ["feature card grid"],
      desktopArtDirection: "Desktop uses an asymmetric evidence field with restrained navigation and long editorial rhythm.",
      mobileArtDirection: "Mobile transforms the evidence rule into a vertical sequence while preserving the signature relationship between proof and action.",
      mobileTransformationSignals: ["vertical evidence rule", "persistent consultation access"],
      motionPurpose: ["reveal evidence sequence", "maintain spatial continuity"],
      signatureMechanicPlacements: ["opening", "proof"],
      adversarial: { brandSwapVerdict: "FAIL", crossIndustryReuseReasons: ["stale declared value that runtime must replace"] },
    },
    galleryReferences: [reference("ref-a"), reference("ref-b")],
    fingerprint,
    priorFingerprints: [priorFingerprint],
    mutations: {
      brandSwap: { from: "Client", to: "Other Brand" },
      industryTransplant: [{ from: "legal", to: "hospitality" }],
    },
    mutationVisualReviews: [],
    ...overrides,
  };
}

function designGenomeArtifact() {
  const genome = {
    schemaVersion: 1,
    viewport: { width: 390, height: 844 },
    visibleElementCount: 20,
    layout: { gridElementCount: 0, flexElementCount: 2, centeredElementRatio: 0.2, viewportOccupancyRatio: 0.6, horizontalOffsetMean: 0.3 },
    typography: { fontSizePx: [14, 18, 48], fontWeight: [400, 600], lineHeightRatio: [1.1, 1.5], familyCount: 2 },
    geometry: { borderRadiusPx: [0, 2, 8], aspectRatios: [1, 1.5] },
    media: { imageCount: 1, videoCount: 0, mediaAreaRatio: 0.3 },
    rhythm: { landmarkHeightsPx: [500, 700], landmarkGapPx: [80] },
    motion: { animatedElementCount: 0, transitionDurationMs: [], animationDurationMs: [] },
  };
  const bytes = Buffer.from(`${JSON.stringify(genome)}\n`);
  return {
    bytes,
    artifact: {
      artifactId: "genome-1",
      runId: "run-1",
      scope: { tenantId: "nexus-mcp", brandId: "client" },
      capability: "DESIGN_GENOME",
      mediaType: "application/vnd.nexus.design-genome+json",
      digest: digest(bytes),
      byteLength: bytes.byteLength,
      capturedAt: "2026-09-01T00:00:00.000Z",
      uri: "/tmp/genome.json",
      metadata: { browser: "chromium", viewport: "mobile-390" },
    },
  };
}

function context() {
  return {
    root: "/repo",
    project,
    spec: { projectId: "client", sourceRevision: SHA, runtime: { redTeamEvidenceFile: "evidence/client-red-team.json" } },
    browsers: ["chromium", "webkit"],
    viewports: [{ name: "mobile-390", width: 390, height: 844 }, { name: "tablet-768", width: 768, height: 1024 }, { name: "desktop-1440", width: 1440, height: 1000 }],
  };
}

describe("production client Red Team runtime", () => {
  it("executes real authorities, derives brand-swap critic input from mutation evidence, and refuses to fake Excess Removal", async () => {
    const { bytes, artifact } = designGenomeArtifact();
    const mutationEvaluation = {
      authority: "NEXUS_MUTATION_EVIDENCE_EVALUATOR",
      verdicts: { BRAND_SWAP: "PASS", INDUSTRY_TRANSPLANT: "PASS", CONTENT_STRESS: "PASS", ASSET_DEGRADATION: "PASS", VIEWPORT_TORTURE: "PASS", MOTION_REMOVAL: "PASS", GRAYSCALE: "PASS" },
      findings: [],
      evidence: { BRAND_SWAP: [`sha256:${"1".repeat(64)}`] },
    };
    const criticEvaluate = vi.fn(() => ({ authority: "NEXUS_CREATIVE_CRITIC", verdict: "PASS", approved: true, findings: [], referenceEntryIds: ["ref-a", "ref-b"] }));
    const runArena = vi.fn(() => ({ authority: "NEXUS_RED_TEAM_ARENA", experienceId: "client", verdict: "PASS", approved: true, attacks: [{ attackId: "BRAND_SWAP", verdict: "PASS", detail: "evidence-bound", evidence: [`sha256:${"2".repeat(64)}`] }], similarityReports: [] }));
    const runMutations = vi.fn(async () => ({ authority: "NEXUS_BROWSER_MUTATION_RUNNER", targetUrl: "http://127.0.0.1:3000", artifacts: [] }));
    const adapter = createProductionRedTeamAdapter(context(), {
      git: async () => ({ branch: "audit", headSha: SHA, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
      committedFileReader: async () => ({ raw: JSON.stringify(envelope()), digest: `sha256:${"3".repeat(64)}`, relativePath: "evidence/client-red-team.json", blobSha: "b".repeat(40) }),
      genomeFileReader: async () => bytes,
      withProjectServer: async (_root: string, _project: unknown, operation: (url: string) => Promise<unknown>) => await operation("http://127.0.0.1:3000"),
      runBrowserMutationSuite: runMutations,
      evaluateBrowserMutationEvidence: () => mutationEvaluation,
      evaluateStructuralFingerprints: () => ({ authority: "NEXUS_STRUCTURAL_FINGERPRINT", templateFingerprint: { verdict: "PASS", findings: [], evidence: ["history:compared"] }, aiFingerprint: { verdict: "PASS", findings: [], evidence: [artifact.digest] } }),
      runRedTeamArena: runArena,
      creativeCritic: { evaluate: criticEvaluate },
    });

    const result = await adapter({
      capture: { evidence: { artifacts: [artifact] } },
      visualJudge: { gate: { verdict: "PASS" } },
    });

    expect(runMutations).toHaveBeenCalledOnce();
    expect(criticEvaluate).toHaveBeenCalledOnce();
    expect(criticEvaluate.mock.calls[0]?.[0].adversarial.brandSwapVerdict).toBe("PASS");
    expect(runArena).toHaveBeenCalledOnce();
    expect(result.report.verdict).toBe("PASS");
    expect(result.excessRemoval.verdict).toBe("NOT_TESTED");
    expect(result.gate.verdict).toBe("NOT_TESTED");
    expect(result.gate.detail).toContain("dedicated removal experiment");
  });

  it("fails before executing mutations when the committed envelope is bound to another SHA", async () => {
    const runMutations = vi.fn();
    const adapter = createProductionRedTeamAdapter(context(), {
      git: async () => ({ branch: "audit", headSha: SHA, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
      committedFileReader: async () => ({ raw: JSON.stringify(envelope({ sourceRevision: "b".repeat(40) })), digest: `sha256:${"3".repeat(64)}`, relativePath: "evidence/client-red-team.json", blobSha: "b".repeat(40) }),
      runBrowserMutationSuite: runMutations,
    });
    const result = await adapter({ capture: { evidence: { artifacts: [{ capability: "DESIGN_GENOME" }] } }, visualJudge: { gate: { verdict: "PASS" } } });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("sourceRevision");
    expect(runMutations).not.toHaveBeenCalled();
  });

  it("fails closed on malformed fingerprint evidence instead of comparing arbitrary structure", async () => {
    const runMutations = vi.fn();
    const adapter = createProductionRedTeamAdapter(context(), {
      git: async () => ({ branch: "audit", headSha: SHA, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
      committedFileReader: async () => ({ raw: JSON.stringify(envelope({ fingerprint: { ...fingerprint, structure: { ...fingerprint.structure, overlap: 2 } } })), digest: `sha256:${"3".repeat(64)}`, relativePath: "evidence/client-red-team.json", blobSha: "b".repeat(40) }),
      runBrowserMutationSuite: runMutations,
    });
    const result = await adapter({ capture: { evidence: { artifacts: [{ capability: "DESIGN_GENOME" }] } }, visualJudge: { gate: { verdict: "PASS" } } });
    expect(result.gate.verdict).toBe("FAIL");
    expect(result.gate.detail).toContain("overlap");
    expect(runMutations).not.toHaveBeenCalled();
  });
});
