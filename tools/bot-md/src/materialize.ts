import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  parse as parseHTML,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap as Tree,
} from "parse5";
import { parse as parseJS } from "acorn";
import { ancestor } from "acorn-walk";
import { hash, inside, json, newDirectory, save, saveJson } from "./common.js";
import { rewriteFlight } from "./flight.js";
import { literalMatches } from "./content-audit.js";
import { addMediaAssets } from "./assets.js";
import type { Build } from "./types.js";
import {
  textFitRuntime,
  validateTextFit,
  type TextFitRule,
} from "./text-fit.js";

type Surface = "html" | "javascript" | "json" | "flight";
export type ReplacementPlan = {
  schemaVersion: 1;
  replacements: {
    id: string;
    from: string;
    to: string;
    surfaces?: Surface[];
  }[];
  forbiddenTerms?: string[];
  fitText?: TextFitRule[];
};
export function validateReplacements(plan: ReplacementPlan) {
  if (plan.fitText !== undefined) validateTextFit(plan.fitText);
  if (
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.replacements) ||
    plan.replacements.length > 10000
  )
    throw new Error("Plan de sustitución inválido");
  const ids = new Set<string>(),
    seen = new Set<string>();
  for (const r of plan.replacements) {
    if (
      !r ||
      typeof r.id !== "string" ||
      !r.id ||
      ids.has(r.id) ||
      typeof r.from !== "string" ||
      !r.from ||
      r.from.length > 100000 ||
      typeof r.to !== "string" ||
      r.to.length > 100000 ||
      r.to === r.from ||
      (r.surfaces &&
        (!Array.isArray(r.surfaces) ||
          !r.surfaces.length ||
          r.surfaces.some(
            (s) => !["html", "javascript", "json", "flight"].includes(s),
          )))
    )
      throw new Error("Regla inválida: " + r?.id);
    ids.add(r.id);
    for (const surface of r.surfaces ?? [
      "html",
      "javascript",
      "json",
      "flight",
    ]) {
      const key = surface + ":" + r.from;
      if (seen.has(key)) throw new Error("Sustitución ambigua: " + r.id);
      seen.add(key);
    }
  }
  if (
    plan.forbiddenTerms &&
    (!Array.isArray(plan.forbiddenTerms) ||
      plan.forbiddenTerms.length > 200 ||
      plan.forbiddenTerms.some(
        (t) => typeof t !== "string" || t.trim().length < 3 || t.length > 200,
      ))
  )
    throw new Error("Términos de auditoría inválidos");
  return plan;
}

const jsString = (s: string) =>
  JSON.stringify(s)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
type Replace = (value: string, surface: Surface) => string;
type Patch = { start: number; end: number; value: string };
function ast(source: string) {
  try {
    return parseJS(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
  } catch {
    return parseJS(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
  }
}
function patch(source: string, patches: Patch[]) {
  for (const p of patches.sort((a, b) => b.start - a.start))
    source = source.slice(0, p.start) + p.value + source.slice(p.end);
  return source;
}
function propertyName(node: any): string | undefined {
  return node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal"
      ? node.value
      : undefined;
}
function assertURL(attribute: string | undefined, value: string) {
  if (
    !["href", "src", "poster", "action", "formAction", "formaction"].includes(
      attribute ?? "",
    )
  )
    return;
  if (
    !value ||
    value.startsWith("#") ||
    /^data:image\/(png|jpeg|webp|gif);base64,/.test(value)
  )
    return;
  if (
    !/^(https?:|mailto:|tel:)$/.test(
      new URL(value, "https://bot-md.invalid").protocol,
    )
  )
    throw new Error("URL no permitida en sustitución: " + attribute);
}
function flightLiterals(source: string) {
  const found: { start: number; end: number; value: string }[] = [];
  ancestor(ast(source), {
    CallExpression(node) {
      if (
        node.callee.type !== "MemberExpression" ||
        propertyName(node.callee.property) !== "push"
      )
        return;
      const object = source
        .slice(node.callee.object.start, node.callee.object.end)
        .replace(/\s/g, "");
      if (
        !/^(?:self\.__next_f|\(self\.__next_f=self\.__next_f\|\|\[\]\))$/.test(
          object,
        )
      )
        return;
      const a = node.arguments[0];
      if (
        a?.type !== "ArrayExpression" ||
        a.elements[0]?.type !== "Literal" ||
        a.elements[0].value !== 1
      )
        return;
      const s = a.elements[1];
      if (s?.type !== "Literal" || typeof s.value !== "string")
        throw new Error("Flight inline dinámico no soportado");
      found.push({ start: s.start, end: s.end, value: s.value });
    },
  });
  return found;
}
export function materializeJS(
  source: string,
  replace: Replace,
  overrides: Map<number, string> = new Map(),
) {
  const patches: Patch[] = [];
  ancestor(ast(source), {
    Literal(node, _state, parents) {
      if (typeof node.value !== "string") return;
      if (overrides.has(node.start)) {
        patches.push({
          start: node.start,
          end: node.end,
          value: jsString(overrides.get(node.start)!),
        });
        return;
      }
      const parent: any = parents.at(-2);
      // Never rename property keys, directives, imports or member names.
      if (
        (["Property", "MethodDefinition", "PropertyDefinition"].includes(
          parent?.type,
        ) &&
          parent.key === node) ||
        parent?.type === "ImportDeclaration" ||
        parent?.type === "ImportExpression" ||
        parent?.type?.startsWith("Export") ||
        parent?.type === "MemberExpression" ||
        (parent?.type === "ExpressionStatement" && parent.directive)
      )
        return;
      const value = replace(node.value, "javascript");
      if (value !== node.value) {
        if (parent?.type === "Property")
          assertURL(propertyName(parent.key), value);
        patches.push({
          start: node.start,
          end: node.end,
          value: jsString(value),
        });
      }
    },
    TemplateLiteral(node, _state, parents) {
      if (
        node.expressions.length ||
        parents.at(-2)?.type === "TaggedTemplateExpression"
      )
        return;
      const original = node.quasis[0].value.cooked;
      if (original == null) return;
      const value = replace(original, "javascript");
      if (value !== original)
        patches.push({
          start: node.start,
          end: node.end,
          value: jsString(value),
        });
    },
  });
  return patch(source, patches);
}
function rewriteJSON(raw: string, replace: Replace) {
  // Whole-document rules cover JSON-LD also embedded as a Flight string.
  const document = replace(raw, "json");
  const original: unknown = JSON.parse(document);
  if (document !== raw)
    return JSON.stringify(original).replace(/</g, "\\u003c");
  function walk(v: unknown, key?: string): unknown {
    if (typeof v === "string") {
      const n = replace(v, "json");
      if (n !== v) assertURL(key, n);
      return n;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x, k)]),
      );
    return v;
  }
  const changed = walk(original);
  return JSON.stringify(changed) === JSON.stringify(original)
    ? raw
    : JSON.stringify(changed).replace(/</g, "\\u003c");
}
export function materializeHTML(raw: string, replace: Replace) {
  const document = parseHTML(raw);
  const scripts: {
    node: Tree["textNode"];
    source: string;
    chunks: ReturnType<typeof flightLiterals>;
  }[] = [];
  function collect(n: Tree["node"]) {
    if (
      "tagName" in n &&
      n.tagName === "script" &&
      !n.attrs.some((a) => a.name === "src") &&
      !n.attrs.some((a) => a.name === "type" && /json|importmap/.test(a.value))
    ) {
      for (const c of n.childNodes)
        if (c.nodeName === "#text" && "value" in c)
          scripts.push({
            node: c,
            source: c.value,
            chunks: flightLiterals(c.value),
          });
    }
    if ("childNodes" in n) for (const c of n.childNodes) collect(c);
    if ("content" in n) collect(n.content as Tree["documentFragment"]);
  }
  collect(document);
  const chunks = scripts.flatMap((s) => s.chunks),
    original = chunks.map((c) => c.value).join("");
  const changed = chunks.length
    ? rewriteFlight(original, (value) => replace(value, "flight"))
    : "";
  let cursor = 0,
    chunkIndex = 0;
  for (const script of scripts) {
    const overrides = new Map<number, string>();
    for (const chunk of script.chunks) {
      let end =
        ++chunkIndex === chunks.length
          ? changed.length
          : Math.min(changed.length, cursor + chunk.value.length);
      // Each Next inline push is UTF-8 encoded separately. Never split a surrogate pair.
      if (
        end < changed.length &&
        /[\ud800-\udbff]/.test(changed[end - 1] ?? "")
      )
        end--;
      overrides.set(chunk.start, changed.slice(cursor, end));
      cursor = end;
    }
    script.node.value = materializeJS(script.source, replace, overrides);
  }
  function visit(n: Tree["node"], parent?: Tree["element"]) {
    if (n.nodeName === "#comment" && "data" in n) return; // React markers are structural.
    if (
      n.nodeName === "#text" &&
      "value" in n &&
      !["script", "style"].includes(parent?.tagName ?? "")
    )
      n.value = replace(n.value, "html");
    if ("tagName" in n) {
      if (
        n.tagName === "noscript" &&
        n.childNodes.every((c) => c.nodeName === "#text")
      ) {
        const fragment = parseFragment(
          n.childNodes.map((c) => ("value" in c ? c.value : "")).join(""),
          { scriptingEnabled: false },
        );
        visit(fragment);
        if (n.childNodes[0] && "value" in n.childNodes[0]) {
          n.childNodes[0].value = serialize(fragment);
          n.childNodes = [n.childNodes[0]];
        }
        return;
      }
      const editable = new Set([
        "alt",
        "title",
        "aria-label",
        "placeholder",
        "href",
        "src",
        "poster",
        "srcset",
      ]);
      for (const a of n.attrs) {
        if (
          (editable.has(a.name) &&
            ![
              "script",
              "style",
              "base",
              "link",
              "iframe",
              "object",
              "embed",
            ].includes(n.tagName)) ||
          (n.tagName === "meta" &&
            a.name === "content" &&
            !n.attrs.some((v) => v.name === "http-equiv"))
        ) {
          const value = replace(a.value, "html");
          if (value !== a.value) assertURL(a.name, value);
          a.value = value;
        }
      }
      if (
        n.tagName === "script" &&
        n.attrs.some((a) => a.name === "type" && /json/.test(a.value))
      )
        for (const c of n.childNodes)
          if (c.nodeName === "#text" && "value" in c)
            c.value = rewriteJSON(c.value, replace);
    }
    if ("childNodes" in n)
      for (const c of n.childNodes) visit(c, "tagName" in n ? n : parent);
    if ("content" in n) visit(n.content as Tree["documentFragment"]);
  }
  visit(document);
  return serialize(document);
}

function localRuntime(index: Build) {
  const urls = Object.fromEntries(
    Object.entries(index.routes).flatMap(([local, r]) => {
      if (!r.sourceUrl.startsWith(index.origin + "/")) return [];
      const u = new URL(r.sourceUrl);
      return [[u.pathname + u.search, local]];
    }),
  );
  return (
    "(()=>{const urls=" +
    jsString(JSON.stringify(urls)) +
    ";const routes=JSON.parse(urls);const translate=u=>{try{const x=new URL(String(u),location.href);return x.origin===location.origin?(routes[x.pathname+x.search]||u):u}catch{return u}};const f=window.fetch;window.fetch=function(u,o){if(u instanceof Request){const t=translate(u.url);return f.call(this,t===u.url?u:new Request(new URL(t,location.origin),u),o)}return f.call(this,translate(u),o)};const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return open.call(this,m,translate(u),...a)};})();\n"
  );
}

/** Compile reviewed literal copy into every supported delivery surface, without a DOM overlay.
 * Only registered files are exported; original maps/reports are never publicly routed.
 */
export async function materialize(
  site: string,
  plan: ReplacementPlan,
  out: string,
  assetsDir?: string,
) {
  validateReplacements(plan);
  const index = await json<Build>(path.join(site, "routes.json"));
  if (index.routes["/__botmd/layout.js"])
    throw new Error(
      "Usa la reconstrucción base, no una salida con ajuste de texto.",
    );
  if (index.routes["/__botmd/content.js"])
    throw new Error(
      "Usa la reconstrucción base, no una plantilla con sustitución en DOM.",
    );
  if (
    path.resolve(out) === path.resolve(site) ||
    path.resolve(out).startsWith(path.resolve(site) + path.sep)
  )
    throw new Error("Salida dentro de la entrada");
  await newDirectory(out);
  const counts = Object.fromEntries(
    plan.replacements.map((r) => [
      r.id,
      { html: 0, javascript: 0, json: 0, flight: 0 },
    ]),
  );
  const lookup = new Map<string, ReplacementPlan["replacements"][number]>();
  for (const r of plan.replacements)
    for (const s of r.surfaces ?? ["html", "javascript", "json", "flight"])
      lookup.set(s + ":" + r.from, r);
  const replace: Replace = (value, surface) => {
    const r = lookup.get(surface + ":" + value);
    if (!r) return value;
    counts[r.id][surface]++;
    return r.to;
  };
  const files: {
    route: string;
    file: string;
    sha256: string;
    changed: boolean;
    matches: string[];
  }[] = [];
  const seen = new Map<string, { file: string; sha256: string }>();
  for (const [route, record] of Object.entries(index.routes)) {
    const shared = seen.get(record.file);
    if (shared) {
      record.file = shared.file;
      record.sha256 = shared.sha256;
      continue;
    }
    const original = await readFile(inside(site, record.file));
    if (record.sha256 && hash(original) !== record.sha256)
      throw new Error("Recurso de entrada modificado: " + route);
    let body = original;
    try {
      if (route === "/__replica/runtime.js")
        body = Buffer.from(localRuntime(index));
      else if (/text\/html/i.test(record.mime))
        body = Buffer.from(
          materializeHTML(
            new TextDecoder("utf-8", { fatal: true }).decode(original),
            replace,
          ),
        );
      else if (/javascript|ecmascript/i.test(record.mime))
        body = Buffer.from(
          materializeJS(
            new TextDecoder("utf-8", { fatal: true }).decode(original),
            replace,
          ),
        );
      else if (/x-component/i.test(record.mime))
        body = Buffer.from(
          rewriteFlight(
            new TextDecoder("utf-8", { fatal: true }).decode(original),
            (value) => replace(value, "flight"),
          ),
        );
      else if (/json/i.test(record.mime))
        body = Buffer.from(
          rewriteJSON(
            new TextDecoder("utf-8", { fatal: true }).decode(original),
            replace,
          ),
        );
    } catch (e) {
      throw new Error("No se pudo materializar " + route + ": " + String(e));
    }
    if (plan.fitText?.length && /text\/html/i.test(record.mime))
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(
            /<head([^>]*)>/i,
            '$&<script defer src="/__botmd/layout.js"></script>',
          ),
      );
    const newFile =
      "site/" + hash(route).slice(0, 24) + path.extname(record.file);
    const oldFile = record.file;
    record.file = newFile;
    record.sha256 = hash(body);
    seen.set(oldFile, { file: newFile, sha256: record.sha256 });
    await save(inside(out, newFile), body);
    files.push({
      route,
      file: newFile,
      sha256: record.sha256,
      changed: !body.equals(original),
      matches: /^text\/|javascript|json|svg|xml/i.test(record.mime)
        ? literalMatches(
            body.toString("utf8"),
            record.mime,
            plan.forbiddenTerms ?? [],
          )
        : [],
    });
  }
  if (plan.fitText?.length) {
    const body = textFitRuntime(plan.fitText),
      file = "layout.js",
      route = "/__botmd/layout.js";
    await save(path.join(out, file), body);
    index.routes[route] = {
      file,
      mime: "application/javascript",
      status: 200,
      sourceUrl: "generated:text-layout",
      sha256: hash(body),
    };
    files.push({
      route,
      file,
      sha256: hash(body),
      changed: true,
      matches: literalMatches(
        body,
        "application/javascript",
        plan.forbiddenTerms ?? [],
      ),
    });
  }
  if (assetsDir) {
    const previous = new Set(Object.keys(index.routes));
    await addMediaAssets(assetsDir, out, index);
    for (const [route, record] of Object.entries(index.routes))
      if (!previous.has(route)) {
        const body = await readFile(inside(out, record.file));
        files.push({
          route,
          file: record.file,
          sha256: hash(body),
          changed: true,
          matches: /svg|xml|^text\//i.test(record.mime)
            ? literalMatches(
                body.toString("utf8"),
                record.mime,
                plan.forbiddenTerms ?? [],
              )
            : [],
        });
      }
  }
  const unmatchedRules = Object.entries(counts)
    .filter(([, v]) => Object.values(v).every((n) => n === 0))
    .map(([id]) => id);
  const report = {
    schemaVersion: 1,
    sourceDigest: index.sourceDigest,
    status:
      unmatchedRules.length || files.some((f) => f.matches.length)
        ? "blocked"
        : "materialized",
    counts,
    unmatchedRules,
    files,
    limitations: [
      "Sustitución literal explícita; no demuestra eliminación semántica de toda información.",
      "Conserva el código de comportamiento y sus dependencias; no recupera los componentes fuente del framework.",
      "Flight limitado al formato textual observado; binarios y etiquetas desconocidas detienen la exportación.",
      "La fidelidad visual, navegación y movimiento deben comprobarse en navegador después de sustituir el contenido.",
    ],
  };
  await saveJson(path.join(out, "materialization.json"), report);
  // Commit the routable manifest last: parse/integrity failures never leave a servable partial export.
  await saveJson(path.join(out, "routes.json"), index);
  await save(
    path.join(out, "CONTENIDO.md"),
    "# Contenido compilado\n\nLos valores se sustituyeron antes de servir HTML, JavaScript, JSON y Flight. No se instala un runtime que conserve los textos originales en expected. Modifica el plan de sustitución de trabajo y vuelve a ejecutar materialize sobre la reconstrucción base, con una salida nueva.\n\nEstado: " +
      report.status +
      ". Revisa materialization.json y valida navegación, geometría, movimiento y recursos visuales. Este estado no certifica una copia universal ni la limpieza total.\n",
  );
  return report;
}
