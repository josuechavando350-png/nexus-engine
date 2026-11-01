// Add ONLY successful observed GET variants to a new sealed capture.
// node validation/daksh/complete-navigation.mjs CAPTURE OBSERVATIONS_JSON NEW_CAPTURE
import path from "node:path";
import { cp, readFile } from "node:fs/promises";
import { integrity } from "../../dist/src/build.js";
import { collectObservedResources } from "../../dist/src/observed-resources.js";
import { json, newDirectory, saveJson, hash } from "../../dist/src/common.js";
const args = process.argv.slice(2);
if (args.length !== 3)
  throw new Error("Provide capture, observations JSON, new capture.");
const [source, observations, out] = args.map((p) => path.resolve(p));
if (out === source || out.startsWith(source + path.sep))
  throw new Error("Use a separate output directory.");
const { manifest, digest } = await integrity(source),
  original = new Map(
    Object.values(manifest.resources).map((r) => [r.url, r.sha256]),
  );
await newDirectory(out);
await cp(source, out, { recursive: true });
const added = await collectObservedResources(
  manifest,
  await json(observations),
  out,
);
manifest.enrichment = {
  parentDigest: digest,
  createdAt: new Date().toISOString(),
  addedURLs: added,
};
await saveJson(path.join(out, "manifest.json"), manifest);
await saveJson(path.join(out, "seal.json"), {
  algorithm: "sha256",
  manifestHash: hash(await readFile(path.join(out, "manifest.json"))),
});
const receipt = {
  parentDigest: digest,
  derivedDigest: (await integrity(out)).digest,
  added,
  resources: Object.keys(manifest.resources).length,
  originalResourcesUnchanged: [...original].every(
    ([u, h]) => manifest.resources[u].sha256 === h,
  ),
};
await saveJson(path.join(out, "navigation-enrichment.json"), receipt);
console.log(JSON.stringify(receipt, null, 2));
