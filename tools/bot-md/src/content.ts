import path from "node:path";
import { cp, readFile } from "node:fs/promises";
import { parse, type DefaultTreeAdapterMap as Tree } from "parse5";
import { integrity } from "./build.js";
import { hash, inside, json, newDirectory, save, saveJson } from "./common.js";
import type { Build } from "./types.js";
import type { ContentMap, ContentBinding } from "./experience-types.js";

const attributes = ["alt", "title", "aria-label", "placeholder", "href", "src"];
export function validateContent(map: ContentMap): ContentMap {
  if (
    map.schemaVersion !== 1 ||
    !Array.isArray(map.bindings) ||
    map.bindings.length > 10000 ||
    !Number.isInteger(map.timeoutMs) ||
    map.timeoutMs < 100 ||
    map.timeoutMs > 120000
  )
    throw new Error("Mapa de contenido inválido.");
  if (
    map.readySelector !== undefined &&
    (typeof map.readySelector !== "string" || map.readySelector.length > 4000)
  )
    throw new Error("Señal de preparación inválida.");
  if (
    map.readySelectors &&
    Object.entries(map.readySelectors).some(
      ([k, v]) =>
        !k.startsWith("/") || typeof v !== "string" || v.length > 4000,
    )
  )
    throw new Error("Señales de preparación inválidas.");
  const ids = new Set<string>(),
    targets = new Set<string>();
  for (const b of map.bindings) {
    if (
      !b.id ||
      ids.has(b.id) ||
      typeof b.route !== "string" ||
      !b.route.startsWith("/") ||
      b.route.startsWith("//") ||
      typeof b.selector !== "string" ||
      !b.selector ||
      b.selector.length > 4000 ||
      typeof b.value !== "string" ||
      typeof b.expected !== "string" ||
      b.value.length > 100000
    )
      throw new Error("Campo de contenido inválido: " + b.id);
    ids.add(b.id);
    const key = JSON.stringify([
      b.route,
      b.selector,
      b.kind,
      b.textIndex,
      b.attribute,
    ]);
    if (targets.has(key)) throw new Error("Destino duplicado: " + b.id);
    targets.add(key);
    if (b.kind === "text") {
      if (!Number.isInteger(b.textIndex) || b.textIndex! < 0)
        throw new Error("Índice de texto inválido: " + b.id);
    } else if (b.kind === "attribute") {
      if (!attributes.includes(b.attribute ?? ""))
        throw new Error("Atributo no editable: " + b.attribute);
      if (
        b.attribute === "src" &&
        (!b.value.startsWith("/") || b.value.startsWith("//"))
      )
        throw new Error(
          "Las imágenes nuevas requieren una ruta local registrada.",
        );
      if (
        b.attribute === "href" &&
        !["https:", "http:", "mailto:", "tel:"].includes(
          new URL(b.value, "https://bot-md.invalid/").protocol,
        )
      )
        throw new Error("Enlace no permitido.");
    } else throw new Error("Tipo de campo inválido.");
  }
  return map;
}

/** Catalog every observed direct text node without replacing its parent element. */
export async function catalogContent(captureDir: string, out: string) {
  const { manifest, digest } = await integrity(captureDir);
  await newDirectory(out);
  const bindings: ContentBinding[] = [],
    seen = new Set<string>();
  const conflicts: {
    route: string;
    selector: string;
    observed: string;
    retained: string;
  }[] = [];
  const fields = new Map<string, ContentBinding>();
  for (const state of manifest.states) {
    const url = new URL(state.url),
      route = url.pathname + url.search;
    const doc = parse(
      await readFile(inside(captureDir, state.renderedHtml), "utf8"),
    );
    function walk(node: Tree["node"], parentSelector: string) {
      if (!("tagName" in node)) {
        if ("childNodes" in node)
          for (const c of node.childNodes) walk(c, parentSelector);
        return;
      }
      if (
        [
          "script",
          "style",
          "noscript",
          "template",
          "link",
          "meta",
          "base",
        ].includes(node.tagName)
      )
        return;
      const siblings =
        node.parentNode && "childNodes" in node.parentNode
          ? node.parentNode.childNodes.filter(
              (n): n is Tree["element"] =>
                "tagName" in n && n.tagName === node.tagName,
            )
          : [node];
      const selector =
        (parentSelector ? parentSelector + " > " : "") +
        node.tagName +
        ":nth-of-type(" +
        (siblings.indexOf(node) + 1) +
        ")";
      function add(
        kind: ContentBinding["kind"],
        expected: string,
        index?: number,
        attribute?: string,
      ) {
        const key = JSON.stringify([route, selector, kind, index, attribute]);
        if (seen.has(key)) {
          const old = fields.get(key)!;
          if (old.expected !== expected)
            conflicts.push({
              route,
              selector,
              observed: expected,
              retained: old.expected,
            });
          return;
        }
        seen.add(key);
        const b: ContentBinding = {
          id: "field-" + (bindings.length + 1),
          route,
          selector,
          kind,
          expected,
          value: expected,
          ...(kind === "text" ? { textIndex: index } : { attribute }),
        };
        bindings.push(b);
        fields.set(key, b);
      }
      node.childNodes.forEach((child, index) => {
        if (
          child.nodeName === "#text" &&
          "value" in child &&
          child.value.trim()
        )
          add("text", child.value, index);
      });
      for (const attr of node.attrs)
        if (
          ["alt", "title", "aria-label", "placeholder"].includes(attr.name) &&
          attr.value.trim()
        )
          add("attribute", attr.value, undefined, attr.name);
      for (const child of node.childNodes) walk(child, selector);
    }
    walk(doc, "");
  }
  const map: ContentMap = { schemaVersion: 1, timeoutMs: 30000, bindings };
  validateContent(map);
  await saveJson(path.join(out, "content.json"), map);
  await saveJson(path.join(out, "catalog-evidence.json"), {
    sourceDigest: digest,
    states: manifest.states.length,
    fields: bindings.length,
    conflicts,
  });
  await save(
    path.join(out, "CONTENIDO.md"),
    "# Contenido editable\n\nEdita solo value en content.json; expected conserva el texto observado y detecta discrepancias. textIndex identifica un nodo de texto directo, no reemplaza los elementos anidados.\n\nCampos: " +
      bindings.length +
      ". Variantes entre estados: " +
      conflicts.length +
      ". Revisa catalog-evidence.json: se conserva la primera variante, no se inventa una regla para estados dinámicos.\n\nEl catálogo incluye texto y etiquetas observados. No detecta información incrustada en imágenes, vídeos, Canvas, código o respuestas API. No elimina los textos originales de los recursos conservados. Añade vínculos o imágenes como campos explícitos y comprueba las rutas.\n\nConfigura readySelector o readySelectors por ruta si la web tiene una señal de hidratación/preparación. La plantilla informa campos aplicados, ausentes y en conflicto en window.__BOT_MD_CONTENT__.\n",
  );
  return map;
}

// Compiled to plain JS and embedded as a self-contained runtime. No eval or innerHTML.
function contentRuntime(validate: (map: ContentMap) => ContentMap) {
  type Status = {
    route: string;
    ready: boolean;
    applied: string[];
    unchanged: string[];
    missing: string[];
    conflicts: string[];
    error?: string;
  };
  const global = window as unknown as { __BOT_MD_CONTENT__: Status };
  const status: Status = {
    route: "",
    ready: false,
    applied: [],
    unchanged: [],
    missing: [],
    conflicts: [],
  };
  global.__BOT_MD_CONTENT__ = status;
  fetch("/__botmd/content.json")
    .then((r) => {
      if (!r.ok) throw new Error("content.json HTTP " + r.status);
      return r.json() as Promise<ContentMap>;
    })
    .then(validate)
    .then((map) => {
      let scheduled = false,
        deadline = 0,
        stopped = false;
      function apply() {
        scheduled = false;
        const route = location.pathname + location.search;
        if (status.route !== route) {
          status.route = route;
          deadline = Date.now() + map.timeoutMs;
          status.ready = false;
          delete status.error;
        }
        const bindings = map.bindings.filter((b) => b.route === route);
        const ready = map.readySelectors?.[route] ?? map.readySelector;
        try {
          if (bindings.length && ready && !document.querySelector(ready)) {
            if (Date.now() > deadline) {
              status.error = "READY_TIMEOUT";
              status.ready = false;
              return;
            }
            setTimeout(schedule, 100);
            return;
          }
        } catch {
          status.error = "READY_SELECTOR_INVALID";
          return;
        }
        status.applied = [];
        status.unchanged = [];
        status.missing = [];
        status.conflicts = [];
        let changed = false;
        for (const b of bindings) {
          let matches: NodeListOf<Element>;
          try {
            matches = document.querySelectorAll(b.selector);
          } catch {
            status.conflicts.push(b.id + ":selector");
            continue;
          }
          if (!matches.length) {
            status.missing.push(b.id);
            continue;
          }
          if (matches.length !== 1) {
            status.conflicts.push(b.id + ":ambiguous");
            continue;
          }
          const el = matches[0];
          if (
            [
              "SCRIPT",
              "STYLE",
              "LINK",
              "META",
              "BASE",
              "IFRAME",
              "OBJECT",
              "EMBED",
            ].includes(el.tagName)
          ) {
            status.conflicts.push(b.id + ":element");
            continue;
          }
          const node =
            b.kind === "text" ? el.childNodes[b.textIndex!] : undefined;
          if (
            b.kind === "text" &&
            (!node || node.nodeType !== Node.TEXT_NODE)
          ) {
            status.conflicts.push(b.id + ":node");
            continue;
          }
          const current =
            b.kind === "text" ? node!.nodeValue : el.getAttribute(b.attribute!);
          if (current !== b.expected && current !== b.value) {
            status.conflicts.push(b.id + ":source");
            continue;
          }
          if (b.expected === b.value) {
            status.unchanged.push(b.id);
            continue;
          }
          if (current !== b.value) {
            if (b.kind === "text") node!.nodeValue = b.value;
            else el.setAttribute(b.attribute!, b.value);
            changed = true;
          }
          status.applied.push(b.id);
        }
        status.ready = true;
        if (changed)
          requestAnimationFrame(() => {
            window.dispatchEvent(new Event("resize"));
            window.dispatchEvent(
              new CustomEvent("bot-md:content-updated", { detail: { route } }),
            );
          });
      }
      function schedule() {
        if (!scheduled && !stopped) {
          scheduled = true;
          requestAnimationFrame(apply);
        }
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "alt",
          "title",
          "aria-label",
          "placeholder",
          "href",
          "src",
        ],
      });
      window.addEventListener("popstate", schedule);
      window.addEventListener(
        "pagehide",
        () => {
          stopped = true;
          observer.disconnect();
        },
        { once: true },
      );
      // DOMContentLoaded + two frames permit default hydration; explicit readiness is preferred.
      if (document.readyState === "loading")
        document.addEventListener(
          "DOMContentLoaded",
          () => requestAnimationFrame(schedule),
          { once: true },
        );
      else requestAnimationFrame(schedule);
    })
    .catch((e) => {
      status.error = String(e);
    });
}

export async function createTemplate(
  site: string,
  map: ContentMap,
  out: string,
) {
  validateContent(map);
  const index = await json<Build>(path.join(site, "routes.json"));
  if (index.routes["/__botmd/content.js"])
    throw new Error("La entrada ya contiene una plantilla editable.");
  if (path.resolve(out).startsWith(path.resolve(site) + path.sep))
    throw new Error("La salida no puede estar dentro de la entrada.");
  await newDirectory(out);
  await cp(site, out, { recursive: true });
  const runtime =
    "(()=>{const attributes=" +
    JSON.stringify(attributes) +
    ";const validateContent=" +
    validateContent.toString() +
    ";(" +
    contentRuntime.toString() +
    ")(validateContent);})();\n";
  await save(path.join(out, "content.js"), runtime);
  await saveJson(path.join(out, "content.json"), map);
  for (const [url, file, mime] of [
    ["/__botmd/content.js", "content.js", "application/javascript"],
    ["/__botmd/content.json", "content.json", "application/json"],
  ])
    index.routes[url] = {
      file,
      mime,
      status: 200,
      sourceUrl: "generated:editable-content",
      sha256: hash(await readFile(path.join(out, file))),
    };
  for (const record of Object.values(index.routes).filter((r) =>
    /text\/html/i.test(r.mime),
  )) {
    const file = inside(out, record.file),
      original = await readFile(file, "utf8");
    if (!/<head(?:\s[^>]*)?>/i.test(original))
      throw new Error("Documento sin head: " + record.file);
    const html = original.replace(
      /<head(?:\s[^>]*)?>/i,
      (match) => match + '<script defer src="/__botmd/content.js"></script>',
    );
    await save(file, html);
    record.sha256 = hash(html);
  }
  await saveJson(path.join(out, "routes.json"), index);
  await save(
    path.join(out, "CONTENIDO.md"),
    "# Plantilla editable\n\nEdita value en content.json y recarga. No reconstruyas la referencia original. Ejecuta serve --site sobre esta carpeta. El runtime conserva elementos y modifica nodos de texto/atributos; notifica resize y bot-md:content-updated. Comprueba window.__BOT_MD_CONTENT__: missing y conflicts deben estar vacíos para los campos esperados.\n\nEl mapa no se considera una eliminación de información del original: código, respuestas y recursos pueden conservarla. Esta versión permite sustituir contenido visible; revisa el catálogo y los estados del sitio antes de publicar.\n",
  );
  return index;
}
