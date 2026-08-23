import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requiredRedTeamAttackIds } from "../packages/quality/quality-gate-certification.ts";
import { runNexusClientPipeline } from "../scripts/nexus-client-pipeline.mjs";

const dirs: string[] = [];
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const SOURCE_SHA = "b".repeat(40);

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixtureSpec() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-client-pipeline-"));
  dirs.push(dir);
  const shell = join(dir, "shell.zip");
  await writeFile(shell, "neutral-shell");
  const copyRoles = ["headline", "primary-cta", "proof", "qualification-and-contact", "value-proposition"];
  return {
    projectId: "pipeline-fixture",
    locale: "en-US",
    sourceRevision: SOURCE_SHA,
    outputDir: join(dir, "out"),
    projectFiles: [{ id: "shell", kind: "BASE_SHELL", filePath: shell, expectedDigest: sha256("neutral-shell"), source: "synthetic-test-fixture" }],
    brief: {
      version: 2,
      id: "pipeline-fixture",
      brand: { name: "Fixture Operations", industry: "software", positioning: "Technical systematic service for clear direct decisions.", personality: ["technical", "systematic", "precise"], audiences: ["operators"] },
      commercialGoal: "Make direct inquiry efficient.",
      priorities: ["structured information", "fast scanning", "clear direct contact"],
      requiredCapabilityIds: ["contact"],
      assets: [{ id: "copy", kind: "copy", status: "available", notes: "verified synthetic fixture copy" }],
      references: [{ id: "reference", sourceLabel: "synthetic-test-fixture", observations: { density: "dense structured information", hierarchy: "clear technical hierarchy", interaction: "direct efficient utility" }, adaptationRule: "inspire-not-copy" }],
      forbiddenPatterns: ["unverified claim"],
      forbiddenWords: [],
      constraints: [{ id: "neutral", statement: "Use neutral gray and white; avoid gold.", source: "synthetic-test-fixture", severity: "required" }],
    },
    businessProfile: { businessType: "operational service", goals: ["INQUIRE"], differentiators: [] },
    photos: [],
    copyAssets: copyRoles.map((role) => ({ role, text: `Verified factual ${role.replaceAll("-", " ")} content for the synthetic fixture.`, source: `copy:${role}` })),
    generatedCopy: copyRoles.map((role) => ({ role, text: role === "headline" ? "Fixture Operations" : `Verified factual ${role.replaceAll("-", " ")} content for the synthetic fixture.`, sourceId: `copy:${role}` })),
    generatedMedia: [],
    actions: [{ capabilityId: "contact", label: "Contact", href: "https://example.test/contact", sourceId: "action:contact", emphasis: "primary" }],
  };
}

const passGate = (gateId: string) => ({ gate: { gateId, verdict: "PASS", detail: `${gateId} synthetic adapter PASS`, evidenceIds: [`synthetic:${gateId}`] } });

function syntheticAdapters() {
  const visualReport = { authority: "NEXUS_VISUAL_JUDGE", verdict: "PASS", approved: true, integrityVerdict: "PASS", reviewVerdict: "PASS", findings: [], verifiedArtifactIds: ["synthetic:capture"] };
  const redReport = { authority: "NEXUS_RED_TEAM_ARENA", experienceId: "pipeline-fixture", verdict: "PASS", approved: true, attacks: requiredRedTeamAttackIds().map((attackId) => ({ attackId, verdict: "PASS", detail: "synthetic test", evidence: [`synthetic:${attackId}`] })), similarityReports: [] };
  const excessRemoval = {
    authority: "NEXUS_EXCESS_REMOVAL_GATE",
    verdict: "PASS",
    findings: [{ elementId: "synthetic-purposeful-element", verdict: "PASS", code: "PURPOSE_SUPPORTED", message: "synthetic removal showed meaningful loss", evidenceIds: ["synthetic:excess:element"] }],
  };
  const cycleReport = { authority: "NEXUS_BOUNDED_REPAIR_LOOP", status: "SHIPPABLE", finalEvaluation: { verdict: "PASS", findings: [], evidenceIds: ["synthetic:judge"] }, iterations: [], snapshots: [], repairLineage: [] };
  return {
    render: async () => passGate("RENDER"),
    capture: async () => passGate("CAPTURE"),
    designGenome: async () => passGate("DESIGN_GENOME"),
    visualJudge: async () => ({ ...passGate("VISUAL_JUDGE"), report: visualReport }),
    redTeam: async () => ({ ...passGate("RED_TEAM"), report: redReport, excessRemoval }),
    repairRejudge: async () => ({ ...passGate("REPAIR_REJUDGE"), report: cycleReport }),
  };
}

describe("NEXUS client pipeline", () => {
  it("executes through generation but blocks delivery when real quality adapters are unavailable", async () => {
    const result = await runNexusClientPipeline(await fixtureSpec());
    expect(result.generation.authority).toBe("NEXUS_MULTIPAGE_GENERATOR_V1");
    expect(result.sceneModel).toMatchObject({ authority: "NEXUS_VISUAL_SCENE_MODEL_V1", layoutPolicy: { blockSizing: "INTRINSIC", contentGrowth: "REFLOW", clipping: "FORBIDDEN" } });
    expect(result.generation.generationDigest).toMatch(/^sha256:/);
    expect(result.status).toBe("BLOCKED");
    expect(result.certification.verdict).toBe("NOT_TESTED");
    expect(result.certification.certified).toBe(false);
    expect(result.stageLog.some((stage: { stage: string; verdict: string }) => stage.stage === "VISUAL_JUDGE" && stage.verdict === "NOT_TESTED")).toBe(true);
  });

  it("can reach certification only when every injected quality adapter supplies bound PASS evidence", async () => {
    const result = await runNexusClientPipeline(await fixtureSpec(), syntheticAdapters());
    expect(result.status).toBe("CERTIFIED");
    expect(result.stageLog.some((stage: { stage: string }) => stage.stage === "VISUAL_SCENE_MODEL")).toBe(true);
    expect(result.certification.evidenceIds).toContain(result.sceneModel.provenance.inputDigest);
    expect(result.certification.verdict).toBe("PASS");
    expect(result.certification.certified).toBe(true);
  });
});
