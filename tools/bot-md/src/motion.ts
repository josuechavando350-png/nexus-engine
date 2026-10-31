import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { launch } from "./browser.js";
import { allowedURL, installCapturePolicy } from "./network.js";
import { hash, json, newDirectory, save, saveJson } from "./common.js";
import { serve } from "./server.js";
import type { MotionConfig, MotionTrace } from "./experience-types.js";
import type { Issue } from "./types.js";
import { routingRequestHeaders } from "./http-metadata.js";

export function motionConfig(input: Partial<MotionConfig>): MotionConfig {
  const c: MotionConfig = {
    route: "/",
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844, touch: true },
    ],
    svgSelector: "svg path,svg circle",
    steps: [0, 0.1, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0].map(
      (progress, i) => ({ name: "scroll-" + i, progress }),
    ),
    sampleMs: [0, 150, 600],
    timeoutMs: 30000,
    initialWaitMs: 1200,
    maxPaths: 200,
    pointSamples: 17,
    allowLocalhost: false,
    clockMode: "realtime",
    renderWaitMs: 20,
    ...input,
  };
  if (
    typeof c.route !== "string" ||
    !c.route.startsWith("/") ||
    c.route.startsWith("//") ||
    c.route.includes("\\")
  )
    throw new Error("Ruta de movimiento inválida.");
  if (!c.svgSelector || c.svgSelector.length > 4000)
    throw new Error("Selector SVG inválido.");
  if (
    !Array.isArray(c.steps) ||
    !c.steps.length ||
    c.steps.length > 60 ||
    c.steps.some(
      (s) =>
        !s.name ||
        !Number.isFinite(s.progress) ||
        s.progress < 0 ||
        s.progress > 1,
    )
  )
    throw new Error("Pasos de scroll inválidos.");
  if (
    !Array.isArray(c.sampleMs) ||
    !c.sampleMs.length ||
    c.sampleMs.length > 20 ||
    c.sampleMs.some(
      (v, i) =>
        !Number.isInteger(v) ||
        v < 0 ||
        v > 10000 ||
        (i > 0 && v <= c.sampleMs[i - 1]),
    )
  )
    throw new Error("Muestreo temporal inválido.");
  for (const [key, min, max] of [
    ["maxPaths", 1, 1000],
    ["pointSamples", 3, 65],
    ["timeoutMs", 1000, 120000],
    ["initialWaitMs", 0, 10000],
    ["renderWaitMs", 0, 200],
  ] as const)
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error("Límite inválido: " + key);
  if (
    !Array.isArray(c.viewports) ||
    !c.viewports.length ||
    c.viewports.length > 8 ||
    new Set(c.viewports.map((v) => v.name)).size !== c.viewports.length ||
    c.viewports.some(
      (v) =>
        !/^[\w-]+$/.test(v.name) ||
        !Number.isInteger(v.width) ||
        v.width < 240 ||
        v.width > 3840 ||
        !Number.isInteger(v.height) ||
        v.height < 240 ||
        v.height > 2160 ||
        (v.touch !== undefined && typeof v.touch !== "boolean"),
    )
  )
    throw new Error("Viewport de movimiento inválido.");
  if (
    c.readySelector !== undefined &&
    (typeof c.readySelector !== "string" || c.readySelector.length > 4000)
  )
    throw new Error("Selector de preparación inválido.");
  if (typeof c.allowLocalhost !== "boolean")
    throw new Error("allowLocalhost inválido.");
  if (!["realtime", "controlled"].includes(c.clockMode))
    throw new Error("Reloj inválido.");
  if (c.clockMode === "controlled" && !c.readySelector)
    throw new Error("El reloj controlado requiere readySelector explícito.");
  return c;
}

export async function motionFrame(page: Page, c: MotionConfig) {
  return page.evaluate(
    ({ selector: query, maxPaths, samples }) => {
      function selector(el: Element): string {
        if (el.id) return "#" + CSS.escape(el.id);
        const parent = el.parentElement;
        if (!parent) return el.tagName.toLowerCase();
        const siblings = [...parent.children].filter(
          (n) => n.tagName === el.tagName,
        );
        return (
          selector(parent) +
          " > " +
          el.tagName.toLowerCase() +
          ":nth-of-type(" +
          (siblings.indexOf(el) + 1) +
          ")"
        );
      }
      const all = [...document.querySelectorAll(query)].filter(
        (el): el is SVGGeometryElement => el instanceof SVGGeometryElement,
      );
      const paths = all.slice(0, maxPaths).map((el) => {
        const length = el.getTotalLength(),
          matrix = el.getScreenCTM(),
          style = getComputedStyle(el);
        // Responsive/conditional routes can exist as empty paths until activated.
        // Preserve them as zero-length geometry instead of asking the browser for a nonexistent point.
        const points = Array.from(
          { length: length > 0 ? samples : 0 },
          (_, i) => {
            const point = el.getPointAtLength((length * i) / (samples - 1));
            const p = matrix
              ? new DOMPoint(point.x, point.y).matrixTransform(matrix)
              : point;
            return { x: p.x + scrollX, y: p.y + scrollY };
          },
        );
        return {
          key: selector(el),
          tag: el.tagName.toLowerCase(),
          route: el.getAttribute("data-thread-route"),
          d: el.getAttribute("d"),
          length,
          points,
          style: Object.fromEntries(
            [
              "stroke",
              "stroke-width",
              "stroke-dasharray",
              "stroke-dashoffset",
              "stroke-linecap",
              "opacity",
              "visibility",
              "display",
              "transform",
              "clip-path",
              "fill",
            ].map((k) => [k, style.getPropertyValue(k)]),
          ),
        };
      });
      return {
        capturedAtMs: performance.now(),
        scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        overflowX: Math.max(
          0,
          document.documentElement.scrollWidth - innerWidth,
        ),
        input: {
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          touchPoints: navigator.maxTouchPoints,
          hover: matchMedia("(hover:hover)").matches,
        },
        paths,
        truncated: all.length > maxPaths,
      };
    },
    { selector: c.svgSelector, maxPaths: c.maxPaths, samples: c.pointSamples },
  );
}

export async function captureMotion(
  target: { url: string } | { site: string },
  input: Partial<MotionConfig>,
  out: string,
  progress: (s: string) => void = console.log,
): Promise<MotionTrace> {
  const c = motionConfig({
    ...("url" in target
      ? { route: new URL(target.url).pathname + new URL(target.url).search }
      : {}),
    ...input,
  });
  if ("url" in target && !(await allowedURL(target.url, c.allowLocalhost)))
    throw new Error("Destino no permitido.");
  await newDirectory(out);
  const server = "site" in target ? await serve(target.site) : undefined;
  const base = server?.url ?? (target as { url: string }).url;
  const url = new URL(c.route, base).href;
  const browser = await launch(!server);
  const { allowLocalhost: _allowLocalhost, ...profile } = c;
  const trace: MotionTrace = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: "site" in target ? "local:" + path.resolve(target.site) : url,
    browser: browser.version(),
    profileHash: hash(JSON.stringify(profile)),
    config: c,
    frames: [],
    issues: [],
    limitations: [
      "Movimiento habilitado; muestras discretas, no certificación de cada frame.",
      "Scroll programático por fracción de altura; no certifica la latencia de gestos físicos.",
      "Puntos SVG en coordenadas de documento. No interpreta shaders, Canvas, vídeo ni Shadow DOM cerrado.",
      "La comparación estricta corresponde al mismo contenido; al cambiarlo se necesita una prueba de adaptación independiente.",
      "El reloj controlado gobierna temporizadores y requestAnimationFrame de JavaScript; no certifica relojes de vídeo, WebGL, workers ni animaciones CSS del compositor.",
    ],
  };
  try {
    for (const viewport of c.viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        locale: "es-MX",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "no-preference",
        hasTouch: viewport.touch ?? false,
        isMobile: viewport.touch ?? false,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const issues: Issue[] = [];
      if (server) {
        await context.route("**/*", async (route) => {
          const req = route.request();
          if (
            new URL(req.url()).origin !== server.url ||
            !["GET", "HEAD"].includes(req.method())
          ) {
            trace.issues.push(
              "NETWORK_BLOCKED " + req.method() + " " + req.url(),
            );
            await route.abort();
          } else await route.continue();
        });
        await context.routeWebSocket("**/*", (ws) => {
          trace.issues.push("WEBSOCKET_UNSUPPORTED " + ws.url());
          ws.close();
        });
      } else await installCapturePolicy(context, c.allowLocalhost, issues);
      const page = await context.newPage();
      page.setDefaultTimeout(c.timeoutMs);
      page.setDefaultNavigationTimeout(c.timeoutMs);
      let observing = true;
      const loading = new Set<import("playwright").Request>();
      page.on("request", (r) => {
        if (
          ["document", "script", "stylesheet", "font"].includes(
            r.resourceType(),
          )
        )
          loading.add(r);
      });
      page.on("requestfinished", (r) => loading.delete(r));
      page.on("requestfailed", (r) => loading.delete(r));
      const deadline = () => Date.now() + c.timeoutMs;
      async function waitAssets() {
        const limit = deadline();
        while (loading.size) {
          if (Date.now() > limit) throw new Error("BOOTSTRAP_ASSETS_TIMEOUT");
          await page.waitForTimeout(20);
        }
      }
      page.on("pageerror", (e) => {
        if (observing) trace.issues.push("JS_ERROR " + e.message);
      });
      const responseTypes = new Map<string, string>();
      page.on("response", (r) => {
        responseTypes.set(r.url(), r.headers()["content-type"] ?? "");
        if (observing && r.status() >= 400)
          trace.issues.push("HTTP " + r.status() + " " + r.url());
        if (observing && !server && r.request().method() === "GET") {
          trace.observedRequests ??= [];
          if (!trace.observedRequests.some((q) => q.url === r.url())) {
            if (trace.observedRequests.length >= 1000) {
              trace.issues.push("REQUEST_LIMIT");
              return;
            }
            trace.observedRequests.push({
              url: r.url(),
              status: r.status(),
              mime: r.headers()["content-type"] ?? "",
              requestHeaders: routingRequestHeaders(r.request().headers()),
            });
          }
        }
      });
      page.on("requestfailed", (r) => {
        if (
          observing &&
          !(
            r.failure()?.errorText === "net::ERR_ABORTED" &&
            r.headers()["next-router-prefetch"] === "1" &&
            /^text\/x-component\b/i.test(responseTypes.get(r.url()) ?? "")
          )
        )
          trace.issues.push(
            "REQUEST_FAILED " + r.url() + " " + r.failure()?.errorText,
          );
      });
      page.on("dialog", (d) => {
        void d.dismiss();
      });
      try {
        if (c.clockMode === "controlled") {
          await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
          await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
        }
        await page.goto(url, {
          waitUntil: c.clockMode === "controlled" ? "load" : "domcontentloaded",
        });
        if (c.clockMode === "controlled") {
          await waitAssets();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(300);
          const limit = deadline();
          let ticks = 0;
          while (!(await page.locator(c.readySelector!).count())) {
            if (Date.now() > limit || ticks >= c.timeoutMs)
              throw new Error("CONTROLLED_READY_TIMEOUT");
            await waitAssets();
            await page.clock.runFor(100);
            ticks += 100;
            await page.waitForTimeout(c.renderWaitMs);
          }
          (trace.readiness ??= []).push({
            viewport: viewport.name,
            virtualReadyMs: await page.evaluate(() => performance.now()),
            clockMode: c.clockMode,
          });
          await page.clock.runFor(c.initialWaitMs);
          await page.waitForTimeout(c.renderWaitMs);
        } else {
          if (c.readySelector)
            await page
              .locator(c.readySelector)
              .first()
              .waitFor({ state: "attached" });
          await page.evaluate(async () => {
            await Promise.race([
              document.fonts.ready,
              new Promise((r) => setTimeout(r, 5000)),
            ]);
          });
          await page.waitForTimeout(c.initialWaitMs);
        }
        for (let step = 0; step < c.steps.length; step++) {
          const started = await page.evaluate((progress) => {
            window.scrollTo({
              left: 0,
              top:
                progress *
                (document.documentElement.scrollHeight - innerHeight),
              behavior: "instant",
            });
            return performance.now();
          }, c.steps[step].progress);
          if (c.clockMode === "controlled")
            await page.waitForTimeout(c.renderWaitMs);
          let previousSample = 0;
          for (const sampleMs of c.sampleMs) {
            if (c.clockMode === "controlled") {
              if (sampleMs > previousSample)
                await page.clock.runFor(sampleMs - previousSample);
              await page.waitForTimeout(c.renderWaitMs);
              previousSample = sampleMs;
            } else
              await page.evaluate(
                async ({ started, at }) => {
                  const delay = started + at - performance.now();
                  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
                  await new Promise(requestAnimationFrame);
                },
                { started, at: sampleMs },
              );
            const measured = await motionFrame(page, c);
            trace.frames.push({
              viewport: viewport.name,
              step,
              sampleMs,
              elapsedMs: measured.capturedAtMs - started,
              ...measured,
            });
            if (measured.truncated)
              trace.issues.push(
                "PATH_LIMIT " + viewport.name + " step=" + step,
              );
            if (measured.input.reduced)
              trace.issues.push("MOTION_DISABLED " + viewport.name);
            if (!measured.paths.length)
              trace.issues.push(
                "NO_SVG_MATCH " + viewport.name + " step=" + step,
              );
          }
          progress("Movimiento: " + viewport.name + " · " + c.steps[step].name);
        }
      } catch (error) {
        trace.issues.push(
          "VIEWPORT_FAILED " + viewport.name + ": " + String(error),
        );
      } finally {
        observing = false;
        trace.issues.push(...issues.map((i) => i.code + " " + i.detail));
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }
  trace.issues = [...new Set(trace.issues)];
  await saveJson(path.join(out, "motion.json"), trace);
  await saveJson(path.join(out, "seal.json"), {
    sha256: hash(await readFile(path.join(out, "motion.json"))),
  });
  await motionReport(trace, out);
  return trace;
}

export async function readMotion(dir: string) {
  const raw = await readFile(path.join(dir, "motion.json"));
  const seal = await json<{ sha256: string }>(path.join(dir, "seal.json"));
  if (hash(raw) !== seal.sha256)
    throw new Error("La traza de movimiento cambió.");
  return JSON.parse(raw.toString()) as MotionTrace;
}

export function compareMotion(a: MotionTrace, b: MotionTrace, tolerance = 2) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100)
    throw new Error("Tolerancia inválida.");
  if (a.profileHash !== b.profileHash || a.browser !== b.browser)
    throw new Error("Las trazas no tienen el mismo perfil/navegador.");
  const failures: {
    viewport: string;
    step: number;
    sampleMs: number;
    detail: string;
  }[] = [];
  const indexed = new Map(
    b.frames.map((f) => [f.viewport + ":" + f.step + ":" + f.sampleMs, f]),
  );
  let maxPointDelta = 0,
    maxLengthDelta = 0,
    maxDashDelta = 0;
  for (const frame of a.frames) {
    const candidate = indexed.get(
      frame.viewport + ":" + frame.step + ":" + frame.sampleMs,
    );
    const fail = (detail: string) =>
      failures.push({
        viewport: frame.viewport,
        step: frame.step,
        sampleMs: frame.sampleMs,
        detail,
      });
    if (!candidate) {
      fail("Falta muestra");
      continue;
    }
    if (JSON.stringify(frame.input) !== JSON.stringify(candidate.input))
      fail("Condiciones de entrada diferentes");
    if (
      a.config.clockMode === "controlled" &&
      (Math.abs(frame.elapsedMs - frame.sampleMs) > 1 ||
        Math.abs(candidate.elapsedMs - candidate.sampleMs) > 1)
    )
      fail("Tiempo virtual de muestreo diferente del perfil");
    if (
      Math.abs(frame.scrollY - candidate.scrollY) > tolerance ||
      Math.abs(frame.scrollHeight - candidate.scrollHeight) > tolerance
    )
      fail("Geometría del documento/scroll diferente");
    const paths = new Map(candidate.paths.map((p) => [p.key, p]));
    if (frame.paths.length !== candidate.paths.length)
      fail("Cantidad de trazos diferente");
    for (const original of frame.paths) {
      const actual = paths.get(original.key);
      if (!actual) {
        fail("Falta trazo " + original.key);
        continue;
      }
      const pointDelta =
        original.points.length === actual.points.length
          ? Math.max(
              0,
              ...original.points.map((p, i) =>
                Math.hypot(p.x - actual.points[i].x, p.y - actual.points[i].y),
              ),
            )
          : Infinity;
      if (
        ![
          original.length,
          actual.length,
          ...original.points.flatMap((p) => [p.x, p.y]),
          ...actual.points.flatMap((p) => [p.x, p.y]),
        ].every(Number.isFinite)
      )
        fail("Geometría no finita " + original.key);
      const lengthDelta = Math.abs(original.length - actual.length);
      const dashDelta = Math.abs(
        parseFloat(original.style["stroke-dashoffset"]) -
          parseFloat(actual.style["stroke-dashoffset"]),
      );
      maxPointDelta = Math.max(maxPointDelta, pointDelta);
      maxLengthDelta = Math.max(maxLengthDelta, lengthDelta);
      if (Number.isFinite(dashDelta))
        maxDashDelta = Math.max(maxDashDelta, dashDelta);
      if (
        pointDelta > tolerance ||
        lengthDelta > tolerance ||
        dashDelta > tolerance
      )
        fail("Geometría/progreso " + original.key);
      for (const key of [
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-dasharray",
        "visibility",
        "display",
        "fill",
        "opacity",
      ])
        if (original.style[key] !== actual.style[key])
          fail("Estilo " + key + " " + original.key);
    }
  }
  const expected =
    a.config.viewports.length *
    a.config.steps.length *
    a.config.sampleMs.length;
  const keys = (t: MotionTrace) =>
    new Set(t.frames.map((f) => f.viewport + ":" + f.step + ":" + f.sampleMs));
  const validKeys = new Set(
    a.config.viewports.flatMap((v) =>
      a.config.steps.flatMap((_, i) =>
        a.config.sampleMs.map((ms) => v.name + ":" + i + ":" + ms),
      ),
    ),
  );
  const complete =
    a.frames.length === expected &&
    b.frames.length === expected &&
    keys(a).size === expected &&
    keys(b).size === expected &&
    [...keys(a), ...keys(b)].every((k) => validKeys.has(k));
  return {
    status:
      complete && !failures.length && !a.issues.length && !b.issues.length
        ? "pass"
        : "fail",
    expectedFrames: expected,
    referenceFrames: a.frames.length,
    candidateFrames: b.frames.length,
    complete,
    tolerancePx: tolerance,
    maxPointDelta,
    maxLengthDelta,
    maxDashDelta,
    referenceIssues: a.issues,
    candidateIssues: b.issues,
    failures,
    scope:
      "Solo geometría, progreso y estilos SVG muestreados con el mismo contenido; no certifica igualdad visual de toda la página ni cada frame intermedio.",
  };
}

export function assessMotion(
  reference: MotionTrace,
  candidate: MotionTrace,
  repeat?: MotionTrace,
) {
  const comparison = compareMotion(reference, candidate);
  const baselineRepeat = repeat ? compareMotion(reference, repeat) : undefined;
  const invalidEvidence =
    !comparison.complete ||
    reference.issues.length > 0 ||
    candidate.issues.length > 0 ||
    Boolean(
      baselineRepeat && (!baselineRepeat.complete || repeat!.issues.length > 0),
    );
  const unstable =
    !invalidEvidence && baselineRepeat && baselineRepeat.status !== "pass";
  return {
    status: invalidEvidence
      ? "fail"
      : unstable
        ? "unstable"
        : comparison.status,
    comparison,
    ...(baselineRepeat ? { baselineRepeat } : {}),
    note: invalidEvidence
      ? "La evidencia contiene muestras ausentes o incidencias. No se clasifica como variación temporal del origen."
      : unstable
        ? "El origen también cambia entre ejecuciones. Se conservan ambas comparaciones; no se amplían umbrales ni se certifica identidad temporal."
        : "La aprobación se limita al perfil y muestras declarados.",
  };
}

async function motionReport(trace: MotionTrace, out: string) {
  const initial = trace.frames[0];
  const routes = [
    ...new Set(
      trace.frames.flatMap((f) => f.paths.map((p) => p.route ?? p.key)),
    ),
  ];
  await save(
    path.join(out, "MOVIMIENTO.md"),
    "# Movimiento observado\n\nFuente: " +
      trace.source +
      "\n\nFecha: " +
      trace.createdAt +
      "\n\nNavegador: " +
      trace.browser +
      " · Movimiento: no-preference · Captura sin desactivar animaciones.\n\nPerfil SHA-256: `" +
      trace.profileHash +
      "`\n\nReloj: " +
      trace.config.clockMode +
      ". En modo controlado, el tiempo medido es virtual.\n\n## Muestreo\n\n| Tamaño | Paso | Muestra solicitada (ms) | Tiempo medido (ms) | Scroll Y | Trazos |\n|---|---|---:|---:|---:|---:|\n" +
      trace.frames
        .map(
          (f) =>
            `| ${f.viewport} | ${trace.config.steps[f.step].name} | ${f.sampleMs} | ${f.elapsedMs.toFixed(1)} | ${f.scrollY.toFixed(1)} | ${f.paths.length} |`,
        )
        .join("\n") +
      "\n\n## Recorridos\n\n" +
      routes.map((r) => "- `" + r.replace(/`/g, "") + "`").join("\n") +
      "\n\n## Evidencia\n\nCada muestra de motion.json conserva puntos de la curva en coordenadas de documento, longitud, atributo d, stroke/dashoffset, visibilidad y condiciones de entrada. No se deduce una librería de animación a partir de una imagen.\n\nTrazos iniciales: " +
      (initial?.paths.length ?? 0) +
      ".\n\n## Incidencias\n\n" +
      (trace.issues.length
        ? trace.issues.map((i) => "- " + i).join("\n")
        : "Sin incidencias observadas.") +
      "\n\n## Alcance\n\n" +
      trace.limitations.map((s) => "- " + s).join("\n") +
      "\n",
  );
}
