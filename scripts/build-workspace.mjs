import {
  buildTargets,
  restoreFromCache,
  runTargetBuild,
  storeInCache,
  targetBuildKey,
} from "./build-core.mjs";

const root = process.cwd();
const targets = buildTargets(root);
let hits = 0;
let misses = 0;

for (const target of targets) {
  const buildKey = targetBuildKey(target, root);
  if (restoreFromCache(target, buildKey, root)) {
    hits += 1;
    console.log(`\n=== Cache hit ${target.relativeDir} ${buildKey.slice(0, 12)} ===`);
    continue;
  }

  misses += 1;
  console.log(`\n=== Building ${target.relativeDir} ${buildKey.slice(0, 12)} ===`);
  runTargetBuild(target, root);
  storeInCache(target, buildKey, root);
}

console.log(`\nWorkspace build completed for ${targets.length} package(s): ${hits} verified cache hit(s), ${misses} rebuild(s).`);
