import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const REPOSITORY_PREFIX = `${REPOSITORY_ROOT}${sep}`;
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

function confinedRealPath(path) {
  const real = realpathSync(path);
  if (real !== REPOSITORY_ROOT && !real.startsWith(REPOSITORY_PREFIX)) {
    throw new Error(`TypeScript source runtime refused path outside repository: ${real}`);
  }
  return real;
}

function relativeSourceCandidates(specifier) {
  const extension = extname(specifier);
  if (!extension) return [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`];
  if (extension === ".js") return [`${specifier.slice(0, -3)}.ts`, `${specifier.slice(0, -3)}.tsx`];
  if (extension === ".jsx") return [`${specifier.slice(0, -4)}.tsx`, `${specifier.slice(0, -4)}.ts`];
  if (extension === ".mjs") return [`${specifier.slice(0, -4)}.mts`, `${specifier.slice(0, -4)}.ts`];
  return [];
}

function resolveRepositoryCandidate(specifier, parentURL) {
  if (!parentURL?.startsWith("file:") || (!specifier.startsWith("./") && !specifier.startsWith("../"))) return null;
  for (const candidate of relativeSourceCandidates(specifier)) {
    const candidateURL = new URL(candidate, parentURL);
    if (candidateURL.protocol !== "file:") continue;
    const candidatePath = fileURLToPath(candidateURL);
    if (!existsSync(candidatePath)) continue;
    confinedRealPath(candidatePath);
    return candidateURL.href;
  }
  return null;
}

export function installRepositoryTypeScriptRuntime() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
        const resolved = resolveRepositoryCandidate(specifier, context.parentURL);
        if (!resolved) throw error;
        return { url: resolved, shortCircuit: true };
      }
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:")) return nextLoad(url, context);
      const path = fileURLToPath(url);
      if (!TYPESCRIPT_EXTENSIONS.has(extname(path))) return nextLoad(url, context);
      const real = confinedRealPath(path);
      const source = readFileSync(real, "utf8");
      const output = ts.transpileModule(source, {
        fileName: real,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          isolatedModules: true,
          sourceMap: false,
          inlineSourceMap: false,
        },
        reportDiagnostics: false,
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    },
  });
}
