import { describe, expect, test } from "vitest";
import { verifyWorkflowEvidenceClaims } from "../scripts/verify-workflow-evidence-claims.mjs";

describe("workflow evidence claim guard", () => {
  test("rejects a static PASS assertion", () => {
    const workflow = `jobs:\n  release:\n    runs-on: ubuntu-latest\n    env:\n      NEXUS_BUILD_PASSED: \"1\"\n    steps:\n      - run: pnpm build\n`;
    expect(verifyWorkflowEvidenceClaims(workflow, "bad.yml")).toEqual([
      "bad.yml:5 release.NEXUS_BUILD_PASSED statically asserts PASS without executed evidence",
    ]);
  });

  test("accepts a same-job executed step output written to GITHUB_OUTPUT", () => {
    const workflow = `jobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Build proof\n        id: build_proof\n        run: |\n          pnpm build\n          echo \"passed=1\" >> \"$GITHUB_OUTPUT\"\n      - name: Consume proof\n        env:\n          NEXUS_BUILD_PASSED: \${{ steps.build_proof.outputs.passed }}\n        run: node scripts/consume-proof.mjs\n`;
    expect(verifyWorkflowEvidenceClaims(workflow, "good.yml")).toEqual([]);
  });

  test("rejects outputs that are not produced by an earlier run step", () => {
    const workflow = `jobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - id: claimed\n        uses: example/action@deadbeef\n      - env:\n          NEXUS_BROWSER_PASSED: \${{ steps.claimed.outputs.passed }}\n        run: node scripts/consume-proof.mjs\n`;
    expect(verifyWorkflowEvidenceClaims(workflow, "unproven.yml")[0]).toContain("without an earlier run step writing that output to GITHUB_OUTPUT");
  });
});
