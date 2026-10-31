import path from "node:path";
import { readdir, readFile, lstat } from "node:fs/promises";
import { hash, save, saveJson } from "./common.js";
import type { Build } from "./types.js";
import { parseFragment, type DefaultTreeAdapterMap as Tree } from "parse5";
const mimes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};
export function assertSafeSvg(source: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("SVG con declaraciones no admitidas.");
  const doc = parseFragment(source);
  let svg = false;
  function walk(n: Tree["node"]) {
    if ("tagName" in n) {
      const tag = n.tagName.toLowerCase();
      if (tag === "svg") svg = true;
      if (
        [
          "script",
          "foreignobject",
          "iframe",
          "object",
          "embed",
          "animate",
          "animatetransform",
          "animatemotion",
          "set",
          "a",
        ].includes(tag)
      )
        throw new Error("SVG activo no admitido.");
      for (const a of n.attrs)
        if (
          /^on/i.test(a.name) ||
          ((a.name === "href" || a.name === "src") && !a.value.startsWith("#"))
        )
          throw new Error(
            "SVG con acciones o referencias externas no admitido.",
          );
    }
    if ("childNodes" in n) for (const c of n.childNodes) walk(c);
  }
  walk(doc);
  if (!svg) throw new Error("El archivo no contiene un SVG.");
}
/** Copy explicitly supplied media; the original site and its resources remain untouched. */
export async function addMediaAssets(
  folder: string,
  out: string,
  index: Build,
) {
  if (!(await lstat(folder)).isDirectory())
    throw new Error("La carpeta de medios debe ser un directorio real.");
  const assets: { name: string; url: string; sha256: string; bytes: number }[] =
    [];
  let total = 0;
  async function walk(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("No se admiten enlaces simbólicos en los medios.");
      const relative = prefix + entry.name,
        absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative + "/");
        continue;
      }
      if (!entry.isFile()) throw new Error("Medio no regular: " + relative);
      const ext = path.extname(entry.name).toLowerCase(),
        mime = mimes[ext];
      if (!mime) throw new Error("Formato de medio no admitido: " + relative);
      if (assets.length >= 100) throw new Error("Límite de 100 medios.");
      const size = (await lstat(absolute)).size;
      if (size > 20 * 1024 * 1024 || total + size > 100 * 1024 * 1024)
        throw new Error("Límite de tamaño de medios.");
      const body = await readFile(absolute);
      total += body.length;
      if (ext === ".svg") assertSafeSvg(body.toString("utf8"));
      const sha256 = hash(body),
        file = "media/" + sha256 + ext,
        url =
          "/__botmd/media/" +
          relative.split("/").map(encodeURIComponent).join("/");
      if (index.routes[url]) throw new Error("Ruta de medio duplicada: " + url);
      await save(path.join(out, file), body);
      index.routes[url] = {
        file,
        mime,
        status: 200,
        sourceUrl: "generated:user-media",
        sha256,
      };
      assets.push({ name: relative, url, sha256, bytes: body.length });
    }
  }
  await walk(folder, "");
  await saveJson(path.join(out, "media-manifest.json"), assets);
  return assets;
}
