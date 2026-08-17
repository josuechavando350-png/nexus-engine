import { describe, expect, it, vi } from "vitest";
import { runOpeningTournament, type OpeningCandidate, type OpeningEvaluation } from "../opening-tournament";

const candidates: readonly OpeningCandidate[] = [
  { openingId: "ritual", concept: "The opening behaves like a customer ritual entering the space.", signatureMechanic: "A service object crosses layers and changes scale with intent.", openingSignature: "object-crossing-ritual", evidenceIds: ["brief-1", "ref-1"] },
  { openingId: "kinetic", concept: "The opening reveals the business through a controlled kinetic sequence.", signatureMechanic: "A spatial track exposes content only as the user progresses.", openingSignature: "kinetic-track-reveal", evidenceIds: ["brief-1", "ref-2"] },
  { openingId: "editorial", concept: "The opening uses an editorial interruption tied to the product cadence.", signatureMechanic: "A typographic interruption is anchored by a physical product trace.", openingSignature: "editorial-product-trace", evidenceIds: ["brief-1", "ref-3"] },
];

function evaluation(openingId: string, verdict: "PASS" | "FAIL" | "WARNING" | "NOT_TESTED" = "PASS"): OpeningEvaluation {
  return {
    openingId,
    creativeVerdict: verdict,
    visualVerdict: verdict,
    redTeamVerdict: verdict,
    businessSpecificityVerdict: verdict,
    findings: verdict === "PASS" ? [] : [`${openingId} did not clear ${verdict}`],
    evidenceIds: [`evaluation-${openingId}`],
  };
}

describe("NEXUS opening tournament", () => {
  it("evaluates all candidates and selects the only full PASS", async () => {
    const evaluate = vi.fn(async (candidate: OpeningCandidate) => candidate.openingId === "kinetic" ? evaluation(candidate.openingId) : evaluation(candidate.openingId, "FAIL"));
    const result = await runOpeningTournament({ candidates, evaluator: { evaluate } });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("SELECTED");
    expect(result.selectedOpeningId).toBe("kinetic");
  });

  it("regenerates when every opening has a blocker or untested dimension", async () => {
    const result = await runOpeningTournament({
      candidates,
      evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId, candidate.openingId === "ritual" ? "NOT_TESTED" : "FAIL") },
    });
    expect(result.status).toBe("REGENERATE");
    expect(result.selectedOpeningId).toBeUndefined();
  });

  it("uses explicit brief preference instead of an invented quality score when several openings pass", async () => {
    const result = await runOpeningTournament({
      candidates,
      evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId) },
      briefPreferenceOrder: ["editorial", "kinetic", "ritual"],
    });
    expect(result.status).toBe("SELECTED");
    expect(result.selectedOpeningId).toBe("editorial");
    expect(result.reason).toMatch(/brief preference/);
  });

  it("requires a decision when several openings pass and the brief does not resolve the tie", async () => {
    const result = await runOpeningTournament({ candidates, evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId) } });
    expect(result.status).toBe("NEEDS_DECISION");
    expect(result.eligibleOpeningIds).toEqual(["ritual", "kinetic", "editorial"]);
  });

  it("rejects duplicate structural signatures disguised as three candidates", async () => {
    const duplicated = candidates.map((candidate) => ({ ...candidate, openingSignature: "same-template-opening" }));
    await expect(runOpeningTournament({ duplicated, candidates: duplicated, evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId) } } as never)).rejects.toThrow(/distinct structural signatures/);
  });

  it("refuses fewer than three or more than five candidates", async () => {
    await expect(runOpeningTournament({ candidates: candidates.slice(0, 2), evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId) } })).rejects.toThrow(/3 to 5/);
    const six = [...candidates, ...candidates.map((candidate, index) => ({ ...candidate, openingId: `extra-${index}`, openingSignature: `extra-signature-${index}`, signatureMechanic: `${candidate.signatureMechanic} distinct ${index}` }))];
    await expect(runOpeningTournament({ candidates: six, evaluator: { evaluate: async (candidate) => evaluation(candidate.openingId) } })).rejects.toThrow(/3 to 5/);
  });
});
