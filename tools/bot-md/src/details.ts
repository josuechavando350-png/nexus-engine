import path from "node:path";
import { readFile } from "node:fs/promises";
import { launch } from "./browser.js";
import { serve } from "./server.js";
import { hash, inside, newDirectory, save, saveJson } from "./common.js";
import { validateScrollDetail } from "./detail-runtime.js";
import type { DetailConfig, ScrollDetail } from "./detail-types.js";
import type { Build } from "./types.js";

export function validateDetailConfig(c: DetailConfig) {
  if (
    !c ||
    c.schemaVersion !== 1 ||
    c.kind !== "scroll-svg" ||
    typeof c.route !== "string" ||
    !c.route.startsWith("/") ||
    c.route.startsWith("//") ||
    /[\\#]/.test(c.route) ||
    typeof c.selector !== "string" ||
    !c.selector ||
    c.selector.length > 2048 ||
    typeof c.readySelector !== "string" ||
    !c.readySelector ||
    c.readySelector.length > 2048 ||
    !Array.isArray(c.viewports) ||
    !c.viewports.length ||
    c.viewports.length > 12
  )
    throw new Error("Configuración de detalle inválida");
  const names = new Set<string>(),
    widths = new Set<number>();
  for (const v of c.viewports) {
    if (
      !v ||
      !/^[a-zA-Z0-9_-]+$/.test(v.name) ||
      names.has(v.name) ||
      !Number.isInteger(v.width) ||
      v.width < 240 ||
      v.width > 3840 ||
      !Number.isInteger(v.height) ||
      v.height < 240 ||
      v.height > 2160 ||
      !Number.isInteger(v.minWidth) ||
      v.minWidth < 0 ||
      v.minWidth > v.width ||
      widths.has(v.minWidth) ||
      (v.touch !== undefined && typeof v.touch !== "boolean")
    )
      throw new Error("Tamaño de detalle inválido");
    names.add(v.name);
    widths.add(v.minWidth);
  }
  if (!widths.has(0)) throw new Error("Se requiere una variante desde ancho 0");
  for (const [key, min, max] of [
    ["padding", 1, 100],
    ["timeoutMs", 1000, 120000],
  ] as const)
    if (
      c[key] !== undefined &&
      (!Number.isFinite(c[key]) || c[key]! < min || c[key]! > max)
    )
      throw new Error("Límite de detalle inválido: " + key);
}

export async function extractScrollDetail(
  site: string,
  c: DetailConfig,
  out: string,
) {
  validateDetailConfig(c);
  if (
    path.resolve(site) === path.resolve(out) ||
    path.resolve(out).startsWith(path.resolve(site) + path.sep)
  )
    throw new Error("Salida dentro de la entrada");
  await newDirectory(out);
  const server = await serve(site),
    observations = [];
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  const detail: ScrollDetail = {
    schemaVersion: 1,
    kind: "scroll-svg",
    variants: [],
  };
  try {
    // Use the sealed local reconstruction; extraction never executes remote requests.
    for (const [route, r] of Object.entries(server.index.routes)) {
      if (!r.sha256 || hash(await readFile(inside(site, r.file))) !== r.sha256)
        throw new Error("Recurso sin integridad verificable: " + route);
    }
    browser = await launch();
    for (const v of c.viewports) {
      const context = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: 1,
        isMobile: v.touch ?? false,
        hasTouch: v.touch ?? false,
        serviceWorkers: "block",
      });
      const errors: string[] = [],
        http: string[] = [];
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === new URL(server.url).origin
          ? route.continue()
          : route.abort(),
      );
      const p = await context.newPage();
      p.setDefaultTimeout(c.timeoutMs ?? 30000);
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("response", (r) => {
        if (r.status() >= 400)
          http.push(r.status() + " " + new URL(r.url()).pathname);
      });
      await p.goto(server.url + c.route);
      await p.locator(c.readySelector).waitFor({ state: "attached" });
      await p.evaluate(() => document.fonts.ready);
      if ((await p.locator(c.selector).count()) !== 1)
        throw new Error(
          "El selector debe identificar exactamente un trazo SVG: " +
            c.selector,
        );
      const observed = await p.locator(c.selector).evaluate(
        (node, { padding }) => {
          if (!(node instanceof SVGPathElement) || !node.ownerSVGElement)
            throw new Error("Se requiere un elemento SVG path");
          const svg = node.ownerSVGElement,
            box = svg.viewBox.baseVal,
            style = getComputedStyle(node),
            d = node.getAttribute("d");
          if (
            !d ||
            !Number.isFinite(node.getTotalLength()) ||
            node.getTotalLength() <= 0 ||
            box.width <= 0 ||
            box.height <= 0
          )
            throw new Error("Geometría SVG no utilizable");
          if (
            style.fill !== "none" ||
            style.stroke === "none" ||
            style.stroke.startsWith("url(") ||
            !["butt", "round", "square"].includes(style.strokeLinecap) ||
            !["miter", "round", "bevel"].includes(style.strokeLinejoin)
          )
            throw new Error(
              "Solo se exportan trazos simples sin relleno ni gradiente",
            );
          const root = svg.getScreenCTM(),
            screen = node.getScreenCTM();
          if (!root || !screen)
            throw new Error("SVG sin transformación observable");
          const m = root.inverse().multiply(screen),
            b = node.getBBox();
          const corners = [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x, b.y + b.height],
            [b.x + b.width, b.y + b.height],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
          const top = Math.min(...corners.map((p) => p.y)) - padding,
            bottom = Math.max(...corners.map((p) => p.y)) + padding;
          const inherited = [];
          for (
            let el: Element | null = node;
            el && el !== svg.parentElement;
            el = el.parentElement
          ) {
            const s = getComputedStyle(el);
            for (const prop of [
              "clip-path",
              "mask-image",
              "filter",
              "mix-blend-mode",
              "opacity",
            ]) {
              const value = s.getPropertyValue(prop);
              if (
                value &&
                value !== "none" &&
                value !== "normal" &&
                value !== "1"
              )
                inherited.push({ tag: el.tagName, property: prop, value });
            }
          }
          const length = node.getTotalLength();
          return {
            path: d,
            transform: [m.a, m.b, m.c, m.d, m.e, m.f],
            viewBox: [box.x, top, box.width, bottom - top],
            stroke: style.stroke,
            strokeWidth: parseFloat(style.strokeWidth),
            linecap: style.strokeLinecap,
            linejoin: style.strokeLinejoin,
            length,
            points: Array.from({ length: 33 }, (_, i) => {
              const p = node.getPointAtLength((length * i) / 32);
              return { x: p.x, y: p.y };
            }),
            inherited,
          };
        },
        { padding: c.padding ?? 16 },
      );
      // Catch geometry driven by scroll instead of assuming every SVG is a static trajectory.
      await p.evaluate(() => scrollTo(0, innerHeight * 1.5));
      await p.waitForTimeout(700);
      const after = await p.locator(c.selector).getAttribute("d");
      if (after !== observed.path)
        throw new Error(
          "El trazo cambia con el scroll; requiere un adaptador de geometría dinámica",
        );
      if (errors.length || http.length)
        throw new Error(
          "La reconstrucción tiene errores: " +
            JSON.stringify({ errors, http }),
        );
      const { length, points, inherited, ...shape } = observed;
      detail.variants.push({
        name: v.name,
        minWidth: v.minWidth,
        ...shape,
      } as ScrollDetail["variants"][number]);
      observations.push({
        viewport: v,
        length,
        points,
        inherited,
        sourcePathSha256: hash(observed.path),
        geometryStableAtTwoScrollStates: true,
      });
      await context.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  validateScrollDetail(detail);
  const runtime = await readFile(
    new URL("./detail-runtime.js", import.meta.url),
    "utf8",
  );
  if (/^import\s/m.test(runtime))
    throw new Error("El runtime exportado debe ser independiente");
  const css =
    ".bot-md-thread-art{display:block;isolation:isolate}.bot-md-thread-art *{box-sizing:border-box}\n";
  const demoCSS =
    "*{box-sizing:border-box}html{background:#101010;color:#f3efe5;scroll-behavior:auto}body{margin:0;font-family:Arial,sans-serif}header,footer{min-height:100vh;display:grid;place-content:center;padding:8vw}h1{font-size:clamp(42px,8vw,110px);letter-spacing:-.06em;line-height:.95;margin:0 0 32px;max-width:900px}p{max-width:480px;line-height:1.6}a{color:inherit}#detail{height:100vh;min-height:600px;background:#f3efe5;color:#111;position:relative}.copy{position:absolute;left:5%;top:8%;max-width:38%;z-index:1}.copy h2{font-size:clamp(26px,4vw,60px);letter-spacing:-.04em;margin:0}footer{background:#ff3b12;color:#111}::selection{background:#ff3b12;color:#fff}@media(max-width:600px){.copy{max-width:68%}}";
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Bot MD — detalle independiente</title><link rel="stylesheet" href="./scroll-thread.css"><link rel="stylesheet" href="./demo.css"></head><body><header><div><p>BOT MD / DETALLE EDITABLE</p><h1>Un detalle.<br>Tu diseño.</h1><p>Desplázate para dibujar la línea. Regresa para recorrerla en sentido contrario.</p><a href="#detail">Explorar el efecto ↓</a></div></header><main><section id="detail" aria-label="Demostración de línea decorativa"><div class="copy"><h2>Tu siguiente<br>idea empieza aquí.</h2><p>Contenido de ejemplo. El dibujo funciona como una pieza independiente.</p></div></section></main><footer><div><h2>Hazlo tuyo.</h2><p>Edita el color, el grosor, la forma y el intervalo de scroll. El componente respeta la preferencia de movimiento reducido.</p></div></footer><script type="module" src="./demo.js"></script></body></html>';
  const files: Record<string, [string, string]> = {
    "/": ["index.html", html],
    "/scroll-thread.js": ["scroll-thread.js", runtime],
    "/effect.json": ["effect.json", JSON.stringify(detail, null, 2) + "\n"],
    "/scroll-thread.css": ["scroll-thread.css", css],
    "/demo.css": ["demo.css", demoCSS],
    "/demo.js": [
      "demo.js",
      'import {mountScrollThread} from "./scroll-thread.js";\nconst definition=await(await fetch("./effect.json")).json();\nconst controller=mountScrollThread(document.querySelector("#detail"),definition);\nwindow.botMDExample={controller,definition,mountScrollThread};\n',
    ],
  };
  const built: Build = {
    schemaVersion: 1,
    origin: "https://bot-md.invalid",
    sourceDigest: server.index.sourceDigest,
    routes: {},
    missing: [],
    patches: [],
  };
  for (const [route, [file, body]] of Object.entries(files)) {
    await save(path.join(out, file), body);
    built.routes[route] = {
      file,
      mime: file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "application/json",
      status: 200,
      sourceUrl: "generated:scroll-detail",
      sha256: hash(body),
    };
  }
  const report = {
    schemaVersion: 1,
    kind: "scroll-svg",
    status: "exported-needs-validation",
    sourceDigest: server.index.sourceDigest,
    sourceRoute: c.route,
    selector: c.selector,
    browser: "Chromium",
    config: c,
    observations,
    exportedFiles: Object.entries(built.routes).map(([route, r]) => ({
      route,
      file: r.file,
      sha256: r.sha256,
    })),
    limitations: [
      "Exports one explicitly selected stroke and observed responsive variants, not arbitrary components or websites.",
      "Controller is newly authored; original easing, trigger timing, clipping, masks, filters and surrounding content are not transplanted.",
      "Preserves aspect ratio. The trajectory scales inside the host; it does not automatically bend around newly authored text.",
      "Inherited visual dependencies are listed for review. Geometric comparison does not certify identical painted pixels.",
      "Intermediate widths select the declared breakpoint variant; only tested sizes can be claimed as validated.",
    ],
  };
  await saveJson(path.join(out, "extraction.json"), report);
  await save(
    path.join(out, "DETAIL.md"),
    '# Detalle SVG independiente\n\nSe extrajo únicamente el trazo seleccionado y sus estilos observados. El controlador de scroll es propio y editable, sin React, Next, GSAP ni código del sitio original. No se exportan textos, imágenes ni otros componentes.\n\n## Integración\n\n```js\nimport { mountScrollThread } from "./scroll-thread.js";\nconst definition = await (await fetch("./effect.json")).json();\nconst effect = mountScrollThread(document.querySelector("#mi-seccion"), definition, { start: .85, end: .25, smoothingMs: 100, headRadius: 4 });\n// Al desmontar la sección:\n// effect.destroy();\n```\n\nEl contenedor necesita altura mayor que cero. Cambia `--bot-md-thread-color` y `--bot-md-thread-width` en su CSS. `effect.json` contiene trazos, colores, grosores y variantes por ancho del contenedor. `refresh()` recalcula después de desplazar una sección sin scroll/resize. `setOptions()` cambia el intervalo y suavizado. `destroy()` elimina listeners, observadores y el SVG. No elimina tus hijos ni sus listeners.\n\nCon movimiento reducido se muestra la línea completa y no se anima con el scroll. El SVG es decorativo y no recibe foco ni intercepta clics.\n\n## Alcance\n\nEsto es una extracción de dibujo y estilos con un comportamiento propio. No reproduce automáticamente el tiempo, easing, recortes o efectos de profundidad de la referencia. La trayectoria mantiene su proporción dentro de la sección y no se adapta a la forma de nuevos títulos. Revisa `extraction.json`, que enumera dependencias visuales del origen no exportadas. La extracción no equivale a una aprobación: valida el paquete en tu composición final.\n',
  );
  // A failed extraction never leaves a routable partial package.
  await saveJson(path.join(out, "routes.json"), built);
  return report;
}
