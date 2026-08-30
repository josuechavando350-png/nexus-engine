import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPolicy, optimizeImage } from "../packages/perceptual-images/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-perceptual-images.mjs --spec <image.json>");
const spec = JSON.parse(await readFile(resolve(args[specIndex + 1]), "utf8"));
const report = await optimizeImage({
  sourcePath: resolve(spec.sourcePath),
  outputDir: resolve(spec.outputDir),
  tools: spec.tools,
  ...(spec.policy ? { policy: createPolicy(spec.policy) } : {}),
});
process.stdout.write(`${JSON.stringify({ authority: "NEXUS_PERCEPTUAL_IMAGES_V1", report }, null, 2)}\n`);
process.exitCode = report.status === "READY" ? 0 : report.status === "UNAVAILABLE" ? 3 : 2;
