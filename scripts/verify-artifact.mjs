import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyStagedArtifact } from "./artifact-identity-core.mjs";

const valueAfter = (flag, fallback) => { const index = process.argv.indexOf(flag); return index === -1 ? fallback : process.argv[index + 1]; };
const artifactRoot = resolve(valueAfter("--artifact-root", ".artifacts/web-build"));
const manifestPath = resolve(valueAfter("--manifest", ".artifacts/web-build-identity.json"));
const expectedSourceRevision = valueAfter("--source-revision", process.env.NEXUS_VALIDATED_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
try {
  console.log(JSON.stringify(verifyStagedArtifact({ artifactRoot, manifestPath, expectedSourceRevision }), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
