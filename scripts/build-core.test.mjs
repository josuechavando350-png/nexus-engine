import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestFiles, normalizedPath, restoreFromCache, storeInCache, targetBuildKey, walkFiles } from "./build-core.mjs";

const roots = [];
const previousEpoch = process.env.SOURCE_DATE_EPOCH;
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
  if (previousEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
  else process.env.SOURCE_DATE_EPOCH = previousEpoch;
});
function tempRoot() { const root = mkdtempSync(join(tmpdir(), "nexus-build-core-")); roots.push(root); return root; }

describe("deterministic build core", () => {
  it("hashes a file tree independently of creation order", () => {
    const a=tempRoot(),b=tempRoot(); mkdirSync(join(a,"x"));mkdirSync(join(b,"x"));writeFileSync(join(a,"x","b.txt"),"B");writeFileSync(join(a,"x","a.txt"),"A");writeFileSync(join(b,"x","a.txt"),"A");writeFileSync(join(b,"x","b.txt"),"B");
    expect(digestFiles(walkFiles(a),a)).toBe(digestFiles(walkFiles(b),b));
  });
  it("normalizes platform separators for manifests",()=>{expect(normalizedPath(["a","b","c"].join(sep))).toBe("a/b/c");});
  it("binds a build cache key to source bytes and the build command",()=>{
    process.env.SOURCE_DATE_EPOCH="1700000000"; const root=tempRoot(),targetDir=join(root,"packages","demo");mkdirSync(targetDir,{recursive:true});writeFileSync(join(root,"package.json"),`${JSON.stringify({packageManager:"pnpm@10.15.0"})}\n`);writeFileSync(join(root,"pnpm-lock.yaml"),"lockfileVersion: '9.0'\n");writeFileSync(join(targetDir,"package.json"),`${JSON.stringify({name:"@fixture/demo",scripts:{build:"echo build"}})}\n`);writeFileSync(join(targetDir,"source.ts"),"export const value = 1;\n");const base={dir:targetDir,relativeDir:"packages/demo",command:"echo build"};const original=targetBuildKey(base,root);expect(targetBuildKey({...base,command:"echo other"},root)).not.toBe(original);writeFileSync(join(targetDir,"source.ts"),"export const value = 2;\n");expect(targetBuildKey(base,root)).not.toBe(original);
  });
  it("round-trips output bytes through a verified content cache",()=>{
    const root=tempRoot(),targetDir=join(root,"packages","demo");mkdirSync(join(targetDir,"dist"),{recursive:true});writeFileSync(join(targetDir,"dist","index.js"),"export const x = 1;\n");const target={dir:targetDir,relativeDir:"packages/demo",command:"noop"};storeInCache(target,"abc123",root);rmSync(join(targetDir,"dist"),{recursive:true,force:true});expect(restoreFromCache(target,"abc123",root)).toBe(true);expect(readFileSync(join(targetDir,"dist","index.js"),"utf8")).toBe("export const x = 1;\n");
  });
  it("rejects and removes a corrupted cache entry",()=>{
    const root=tempRoot(),targetDir=join(root,"packages","demo");mkdirSync(join(targetDir,"dist"),{recursive:true});writeFileSync(join(targetDir,"dist","index.js"),"trusted\n");const target={dir:targetDir,relativeDir:"packages/demo",command:"noop"};storeInCache(target,"corrupt-me",root);const cached=join(root,".nexus-cache","builds","corrupt-me","packages__demo","dist","index.js");writeFileSync(cached,"tampered\n");rmSync(join(targetDir,"dist"),{recursive:true,force:true});expect(restoreFromCache(target,"corrupt-me",root)).toBe(false);expect(()=>readFileSync(join(targetDir,"dist","index.js"),"utf8")).toThrow();
  });
});
