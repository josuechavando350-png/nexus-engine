import path from "node:path";
import { readFile } from "node:fs/promises";
import { hash, inside, json, newDirectory, save, saveJson } from "./common.js";
import { createMapper, rewriteCSS, rewriteHTML, rewriteJS } from "./rewrite.js";
import type { Build, Manifest } from "./types.js";

export async function integrity(
  dir: string,
): Promise<{ manifest: Manifest; digest: string }> {
  const raw = await readFile(path.join(dir, "manifest.json"));
  const manifest = JSON.parse(raw.toString()) as Manifest;
  const seal = await json<{ manifestHash: string }>(
    path.join(dir, "seal.json"),
  );
  if (hash(raw) !== seal.manifestHash)
    throw new Error(
      "La referencia cambió: manifest.json no coincide con el sello.",
    );
  for (const [file, digest] of Object.entries(manifest.files))
    if (hash(await readFile(inside(dir, file))) !== digest)
      throw new Error("La referencia cambió: " + file);
  return { manifest, digest: hash(raw) };
}
export async function build(captureDir: string, out: string) {
  const { manifest, digest } = await integrity(captureDir);
  await newDirectory(out);
  const known = new Set(Object.keys(manifest.resources)),
    missing = new Set<string>();
  const map = createMapper(manifest.origin, known, missing);
  const index: Build = {
    schemaVersion: 1,
    sourceDigest: digest,
    origin: manifest.origin,
    routes: {},
    missing: [],
    patches: [],
  };
  const replacements = Object.fromEntries(
    Object.values(manifest.resources).map((r) => [r.url, r.localPath]),
  );
  // The runtime only rewrites observed URLs. Unrecorded calls remain blocked by the preview CSP.
  const runtime =
    "(()=>{const urls=" +
    JSON.stringify(replacements).replace(/</g, "\\u003c") +
    ";const original=" +
    JSON.stringify(manifest.origin) +
    ";const translate=u=>{try{const x=new URL(String(u),original+location.pathname);return urls[x.href]||u}catch{return u}};const f=window.fetch;window.fetch=function(u,o){if(u instanceof Request){const target=translate(u.url);return f.call(this,target===u.url?u:new Request(new URL(target,location.origin),u),o)}return f.call(this,translate(u),o)};const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return open.call(this,m,translate(u),...a)};})();";
  await save(path.join(out, "runtime.js"), runtime);
  await save(
    path.join(out, "repairs.css"),
    "/* Correcciones medidas; vacío en la reconstrucción inicial. */\n",
  );
  index.routes["/__replica/runtime.js"] = {
    file: "runtime.js",
    mime: "application/javascript",
    status: 200,
    sourceUrl: "generated:runtime",
    sha256: hash(runtime),
  };
  index.routes["/__replica/repairs.css"] = {
    file: "repairs.css",
    mime: "text/css",
    status: 200,
    sourceUrl: "generated:repair",
    sha256: "",
  };
  const injection =
    '<script src="/__replica/runtime.js"></script><link rel="stylesheet" href="/__replica/repairs.css">';
  const changes: { url: string; transformation: string; error?: string }[] = [];
  for (const resource of Object.values(manifest.resources)) {
    let body = await readFile(inside(captureDir, resource.file));
    try {
      if (/text\/html/i.test(resource.mime)) {
        body = Buffer.from(
          rewriteHTML(
            body.toString("utf8"),
            resource.url,
            map,
            known,
            injection,
          ),
        );
        changes.push({
          url: resource.url,
          transformation: "HTML URLs + isolated runtime",
        });
      } else if (/text\/css/i.test(resource.mime)) {
        body = Buffer.from(
          rewriteCSS(body.toString("utf8"), resource.url, map),
        );
        changes.push({ url: resource.url, transformation: "CSS URLs" });
      } else if (/javascript|ecmascript/i.test(resource.mime)) {
        body = Buffer.from(
          rewriteJS(body.toString("utf8"), resource.url, map, known),
        );
        changes.push({
          url: resource.url,
          transformation: "Observed absolute JS literals",
        });
      }
    } catch (e) {
      missing.add("TRANSFORM_FAILED " + resource.url);
      changes.push({
        url: resource.url,
        transformation: "unchanged",
        error: String(e),
      });
    }
    const file =
      "site/" +
      hash(resource.url).slice(0, 24) +
      (resource.kind === "document"
        ? ".html"
        : /css/.test(resource.mime)
          ? ".css"
          : /javascript/.test(resource.mime)
            ? ".js"
            : ".bin");
    await save(path.join(out, file), body);
    index.routes[resource.localPath] = {
      file,
      mime: resource.mime,
      status: resource.status,
      sourceUrl: resource.url,
      sha256: hash(body),
      responseHeaders: resource.responseHeaders,
    };
  }
  index.missing = [...missing].sort();
  await saveJson(path.join(out, "routes.json"), index);
  await saveJson(path.join(out, "transformations.json"), changes);
  await save(
    path.join(out, "README.md"),
    "# Reconstrucción local\n\nSirve esta carpeta con `npm run bot-md -- serve --site RUTA`.\n\nLos archivos en site/ son HTML, CSS, JS y recursos editables. routes.json conserva la relación con sus URLs.\n\nLas respuestas API son grabaciones GET; no constituyen un backend. Las solicitudes no registradas devuelven 404.\n\nNo se han recuperado los componentes originales del framework.\n",
  );
  return index;
}
