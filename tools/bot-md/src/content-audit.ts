import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse, type DefaultTreeAdapterMap as Tree } from "parse5";
import { hash, inside, json, newDirectory, save, saveJson } from "./common.js";
import { integrity } from "./build.js";
import { catalogContent, validateContent } from "./content.js";
import type { Build } from "./types.js";
import type { ContentBinding, ContentMap } from "./experience-types.js";

export type ContentAuditPolicy = {
  forbiddenTerms: string[];
  reviewedResources?: { sha256: string; reason: string }[];
};
export function validateAuditPolicy(p: ContentAuditPolicy) {
  if (
    !Array.isArray(p.forbiddenTerms) ||
    !p.forbiddenTerms.length ||
    p.forbiddenTerms.length > 200 ||
    p.forbiddenTerms.some(
      (s) => typeof s !== "string" || s.trim().length < 3 || s.length > 200,
    )
  )
    throw new Error(
      "Especifica entre 1 y 200 términos de origen, de 3 a 200 caracteres.",
    );
  if (
    p.reviewedResources &&
    (!Array.isArray(p.reviewedResources) ||
      p.reviewedResources.length > 2000 ||
      p.reviewedResources.some(
        (r) =>
          !r ||
          !/^[a-f0-9]{64}$/.test(r.sha256) ||
          typeof r.reason !== "string" ||
          r.reason.trim().length < 10,
      ))
  )
    throw new Error(
      "La revisión de recursos requiere SHA-256 y una justificación explícita.",
    );
  return p;
}
function normalized(s: string) {
  return s.normalize("NFKC").toLowerCase();
}
export function literalMatches(raw: string, mime: string, terms: string[]) {
  const variants = [
    raw,
    raw.replace(
      /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
      (original, a, b, c) => {
        const n = parseInt(a ?? b ?? c, 16);
        return n <= 0x10ffff ? String.fromCodePoint(n) : original;
      },
    ),
  ];
  if (/html/i.test(mime)) {
    const doc = parse(raw);
    const text: string[] = [];
    function walk(n: Tree["node"]) {
      if (n.nodeName === "#text" && "value" in n) text.push(n.value);
      if ("attrs" in n) for (const a of n.attrs) variants.push(a.value);
      if ("childNodes" in n) for (const c of n.childNodes) walk(c);
    }
    walk(doc);
    variants.push(text.join(""), text.join(" "));
  }
  const haystack = variants.map(normalized);
  return terms.filter((t) => haystack.some((v) => v.includes(normalized(t))));
}
const target = (b: ContentBinding) =>
  JSON.stringify([b.route, b.selector, b.kind, b.textIndex, b.attribute]);

/** Inventory actual served bytes, not just the visible substitutions. No opaque resource is silently approved. */
export async function auditContent(
  captureDir: string,
  site: string,
  content: ContentMap,
  policy: ContentAuditPolicy,
  out: string,
) {
  validateContent(content);
  validateAuditPolicy(policy);
  const { manifest, digest } = await integrity(captureDir);
  const index = await json<Build>(path.join(site, "routes.json"));
  if (index.sourceDigest !== digest)
    throw new Error(
      "La plantilla y la captura no comparten la misma referencia.",
    );
  await newDirectory(out);
  const catalog = await catalogContent(captureDir, path.join(out, "catalog"));
  const chosen = new Map(content.bindings.map((b) => [target(b), b]));
  const fields = catalog.bindings.map((original) => {
    const selected = chosen.get(target(original));
    const state = !selected
      ? "unmapped"
      : selected.expected !== original.expected
        ? "source-conflict"
        : selected.value === original.expected
          ? "unchanged"
          : "replacement-declared";
    return {
      id: original.id,
      route: original.route,
      selector: original.selector,
      kind: original.kind,
      attribute: original.attribute,
      state,
    };
  });
  const approved = new Map(
    (policy.reviewedResources ?? []).map((r) => [r.sha256, r.reason]),
  );
  const originals = new Set(
    Object.values(manifest.resources).map((r) => r.sha256),
  );
  const files = [];
  const seen = new Set<string>();
  for (const [route, r] of Object.entries(index.routes)) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    const body = await readFile(inside(site, r.file)),
      sha256 = hash(body);
    const isText = /^text\/|json|javascript|xml|svg/i.test(r.mime);
    const matches = isText
      ? literalMatches(body.toString("utf8"), r.mime, policy.forbiddenTerms)
      : [];
    const fromSource = /^https?:/.test(r.sourceUrl);
    const media = /^(image|video|audio)\//i.test(r.mime);
    const opaque =
      fromSource && /javascript|ecmascript|json|x-component/i.test(r.mime);
    const reviewRequired = (media && originals.has(sha256)) || opaque;
    files.push({
      route,
      file: r.file,
      mime: r.mime,
      sha256,
      bytes: body.length,
      matches,
      originalMedia: media && originals.has(sha256),
      opaqueOriginalCodeOrData: opaque,
      reviewRequired,
      review: approved.get(sha256) ?? null,
    });
  }
  const matched = files.filter((f) => f.matches.length),
    pendingResources = files.filter((f) => f.reviewRequired && !f.review),
    pendingFields = fields.filter((f) => f.state !== "replacement-declared");
  const result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceDigest: digest,
    status:
      matched.length || pendingResources.length || pendingFields.length
        ? "blocked"
        : "review-required",
    policy,
    summary: {
      catalogFields: fields.length,
      replacementsDeclared: fields.length - pendingFields.length,
      pendingFields: pendingFields.length,
      filesScanned: files.length,
      filesWithForbiddenTerms: matched.length,
      resourcesRequiringReview: pendingResources.length,
    },
    fields,
    files,
    limitations: [
      "Las sustituciones declaradas no prueban su aplicación: verificar la plantilla en el navegador.",
      "Coincidencias literales y normalizadas de los términos declarados; no es un detector semántico universal ni OCR.",
      "El código y los datos conservados pueden ocultar o reconstruir información no detectable por estas reglas.",
      "Una revisión de un recurso nunca silencia una coincidencia de término prohibido.",
      "Los informes y la captura original son material de trabajo, no parte del paquete público.",
    ],
  };
  await saveJson(path.join(out, "audit.json"), result);
  await save(
    path.join(out, "SUSTITUCION.md"),
    "# Sustitución de contenido\n\nEstado: **" +
      result.status +
      "**. No equivale a una certificación de limpieza total.\n\n| Comprobación | Resultado |\n|---|---:|\n| Campos catalogados | " +
      fields.length +
      " |\n| Sustituciones declaradas | " +
      result.summary.replacementsDeclared +
      " |\n| Campos pendientes | " +
      pendingFields.length +
      " |\n| Archivos servidos revisados | " +
      files.length +
      " |\n| Archivos con términos de origen | " +
      matched.length +
      " |\n| Recursos opacos o visuales pendientes | " +
      pendingResources.length +
      " |\n\n## Coincidencias\n\n" +
      matched
        .map(
          (f) =>
            "- `" + f.route.replace(/`/g, "") + "`: " + f.matches.join(", "),
        )
        .join("\n") +
      "\n\n## Siguiente edición\n\nEl catálogo completo está en catalog/content.json. Completa sus value y vuelve a crear la plantilla. Los recursos visuales originales requieren sustitución o revisión explícita por hash. El JavaScript y las respuestas originales requieren reconstrucción o revisión; cambiar texto después de cargar no los elimina. audit.json identifica los archivos y campos pendientes.\n\n## Alcance\n\n" +
      result.limitations.map((s) => "- " + s).join("\n") +
      "\n",
  );
  return result;
}
