import {
  buildTargets,
  restoreFromCache,
  runTargetBuild,
  storeInCache,
  targetContentHash,
} from "./build-core.mjs";

const root = process.cwd();
const targets = buildTargets(root);
let hits = 0;
let misses = 0;

for (const target of targets) {
  const contentHash = targetContentHash(target.dir, root);
  if (restoreFromCache(target, contentHash, root)) {
    hits += 1;
    console.log(`\n=== Cache hit ${target.relativeDir} ${contentHash.slice(0, 12)} ===`);
    continue;
  }

  misses += 1;
  console.log(`\n=== Building ${target.relativeDir} ${contentHash.slice(0, 12)} ===`);
  runTargetBuild(target, root);
  storeInCache(target, contentHash, root);
}

console.log(`\nWorkspace build completed for ${targets.length} package(s): ${hits} cache hit(s), ${misses} rebuild(s).`);
