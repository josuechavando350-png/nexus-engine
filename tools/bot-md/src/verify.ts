import path from "node:path";
import { readFile, copyFile } from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { integrity } from "./build.js";
import {
  launch,
  settle,
  layout,
  applySteps,
  checkAssertions,
} from "./browser.js";
import {
  inside,
  json,
  localPath,
  newDirectory,
  save,
  saveJson,
} from "./common.js";
import { serve } from "./server.js";
import { report } from "./report.js";
import type { Layout, State, StateResult, Verification } from "./types.js";
import { optionalPrefetchCancelled } from "./http-metadata.js";

export const hasFailures = (v: Verification) =>
  v.totals.fail +
    v.totals.error +
    v.totals.unstable +
    v.captureCoverage.failedStates +
    v.captureCoverage.failedPageLoads +
    v.captureCoverage.truncatedStates >
  0;

export function comparePNGs(a: Buffer, b: Buffer, threshold: number) {
  const x = PNG.sync.read(a),
    y = PNG.sync.read(b),
    width = Math.max(x.width, y.width),
    height = Math.max(x.height, y.height);
  if (width * height > 120_000_000)
    throw new Error("Comparación demasiado grande.");
  const pad = (p: PNG) => {
    if (p.width === width && p.height === height) return p;
    const out = new PNG({ width, height });
    out.data.fill(255);
    PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, 0);
    return out;
  };
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(
    pad(x).data,
    pad(y).data,
    diff.data,
    width,
    height,
    { threshold, includeAA: false },
  );
  return {
    pixels,
    ratio: pixels / (width * height),
    dimensionsMatch: x.width === y.width && x.height === y.height,
    diff: PNG.sync.write(diff),
  };
}
export function compareGeometry(a: Layout, b: Layout, tolerance: number) {
  const byKey = new Map(b.nodes.map((n) => [n.key, n]));
  const errors: { selector: string; delta: number }[] = [];
  for (const n of a.nodes) {
    const m = byKey.get(n.key);
    if (!m) {
      if (n.visible) errors.push({ selector: n.selector, delta: Infinity });
      continue;
    }
    if (n.visible !== m.visible) {
      errors.push({ selector: n.selector, delta: Infinity });
      continue;
    }
    if (!n.visible) continue;
    const delta = Math.max(
      ...(["x", "y", "width", "height"] as const).map((k) =>
        Math.abs(n.rect[k] - m.rect[k]),
      ),
    );
    if (delta > tolerance || n.text !== m.text)
      errors.push({
        selector: n.selector,
        delta: Math.max(delta, n.text !== m.text ? 1 : 0),
      });
  }
  const oldKeys = new Set(a.nodes.map((n) => n.key));
  for (const n of b.nodes)
    if (n.visible && !oldKeys.has(n.key))
      errors.push({ selector: n.selector, delta: Infinity });
  return errors.map((e) => ({
    ...e,
    delta: Number.isFinite(e.delta) ? e.delta : -1,
  }));
}
export async function verify(
  captureDir: string,
  siteDir: string,
  out: string,
  progress: (message: string) => void = console.log,
  options: { legacyCDPReplay?: boolean; stateIds?: string[] } = {},
): Promise<Verification> {
  const { manifest, digest } = await integrity(captureDir);
  const selected = options.stateIds
    ? manifest.states.filter((s) => options.stateIds!.includes(s.id))
    : manifest.states;
  if (
    !selected.length ||
    (options.stateIds && selected.length !== new Set(options.stateIds).size)
  )
    throw new Error("Selección de estados vacía o desconocida.");
  await newDirectory(out);
  const server = await serve(siteDir);
  const browser = await launch();
  const output: Verification = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceDigest: digest,
    baselineIntegrity: true,
    scope:
      (options.stateIds
        ? "Verificación parcial: " +
          selected.length +
          " de " +
          manifest.states.length +
          " estados capturados. "
        : "") +
      "Solo páginas, viewports y estados capturados; no mide cobertura universal ni equivalencia del backend.",
    ...(options.stateIds ? { selection: options.stateIds } : {}),
    captureCoverage: {
      capturedStates: manifest.states.length,
      failedStates: manifest.issues.filter((i) => i.code === "STATE_FAILED")
        .length,
      failedPageLoads: manifest.issues.filter((i) =>
        ["PAGE_FAILED", "ORIGIN_REDIRECT"].includes(i.code),
      ).length,
      truncatedStates: manifest.issues.filter((i) => i.code === "ELEMENT_LIMIT")
        .length,
      exhaustive: false,
    },
    environment: {
      browser: browser.version(),
      platform: process.platform,
      legacyCDPReplay: options.legacyCDPReplay ?? false,
    },
    results: [],
    totals: { pass: 0, fail: 0, unstable: 0, error: 0 },
    limitations: [
      "APIs GET reproducidas desde respuestas capturadas; no se implementó un backend.",
      "Las capturas estáticas desactivan animaciones; no certifican el movimiento completo.",
      "Solo Chromium; no se certificó Safari ni Firefox.",
      "El sello SHA-256 detecta cambios accidentales; no es una firma externa.",
      ...(options.legacyCDPReplay
        ? [
            "Compatibilidad explícita con captura antigua: se reproduce la desconexión CDP antes del primer estado posterior al inicial (s1). Las capturas full-page restauraban el puntero después. Las referencias y tolerancias permanecen intactas.",
          ]
        : []),
      ...manifest.issues.map((i) => i.code + ": " + i.detail),
    ],
  };
  try {
    if (server.index.sourceDigest !== digest)
      throw new Error("La reconstrucción pertenece a otra captura.");
    if (browser.version() !== manifest.browserVersion)
      throw new Error(
        "Cambió la versión del navegador; vuelve a capturar con el entorno actual.",
      );
    const verifyState = async (state: State) => {
      const result: StateResult = {
        id: state.id,
        name: state.name,
        viewport: state.viewport,
        status: "error",
        assertions: [],
        missingRequests: [],
        consoleErrors: [],
      };
      const context = await browser.newContext({
        viewport: {
          width: state.viewport.width,
          height: state.viewport.height,
        },
        deviceScaleFactor: 1,
        locale: "es-MX",
        timezoneId: "UTC",
        serviceWorkers: "block",
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
      });
      await context.route("**/*", async (route) => {
        const req = route.request();
        if (
          new URL(req.url()).origin !== server.url ||
          !["GET", "HEAD"].includes(req.method())
        ) {
          result.missingRequests.push(req.method() + " " + req.url());
          await route.abort();
        } else await route.continue();
      });
      await context.routeWebSocket("**/*", (ws) => {
        result.missingRequests.push("WS " + ws.url());
        ws.close();
      });
      const page = await context.newPage();
      if (options.legacyCDPReplay && state.id.endsWith("-s1")) {
        const legacy = await context.newCDPSession(page);
        await legacy.send("DOM.enable");
        await legacy.send("CSS.enable");
        await legacy.detach();
      }
      let observing = true;
      page.setDefaultNavigationTimeout(manifest.config.navigationTimeoutMs);
      page.on("dialog", (d) => {
        void d.dismiss();
      });
      page.on("pageerror", (e) => {
        if (observing) result.consoleErrors.push(e.message);
      });
      page.on("response", (r) => {
        if (!observing) return;
        if (r.status() >= 400)
          result.missingRequests.push(r.status() + " " + r.url());
      });
      page.on("requestfailed", (r) => {
        if (!observing) return;
        const u = new URL(r.url());
        const route = server.index.routes[u.pathname + u.search];
        if (
          optionalPrefetchCancelled(
            r.failure()?.errorText,
            r.headers(),
            route?.mime,
          )
        )
          (result.cancelledPrefetches ??= []).push(r.url());
        else
          result.missingRequests.push(r.url() + " " + r.failure()?.errorText);
      });
      try {
        const baseline = await readFile(inside(captureDir, state.screenshot)),
          repeat = await readFile(inside(captureDir, state.repeatScreenshot));
        const noise = comparePNGs(
          baseline,
          repeat,
          manifest.config.pixelThreshold,
        );
        result.baselineNoiseRatio = noise.ratio;
        await page.goto(server.url + localPath(state.url, manifest.origin), {
          waitUntil: "domcontentloaded",
        });
        await settle(page, manifest.config, true);
        await applySteps(page, state.steps);
        await settle(page, manifest.config);
        const expectedLayout = await json<Layout>(
          inside(captureDir, state.layout),
        );
        if (expectedLayout.scrollY !== undefined) {
          await page.evaluate(
            ({ x, y }) =>
              window.scrollTo({ left: x, top: y, behavior: "instant" }),
            { x: expectedLayout.scrollX ?? 0, y: expectedLayout.scrollY },
          );
          await settle(page, manifest.config);
        }
        const actualLayout = await layout(page, manifest.config.maxElements);
        result.environmentErrors = expectedLayout.input
          ? Object.entries(expectedLayout.input)
              .filter(
                ([key, value]) =>
                  actualLayout.input?.[
                    key as keyof NonNullable<Layout["input"]>
                  ] !== value,
              )
              .map(([key]) => key)
          : [];
        if (actualLayout.height > 30000)
          throw new Error("Reconstrucción excede 30000px.");
        result.assertionErrors = [];
        result.assertions = await checkAssertions(
          page,
          state.assertions,
          manifest.config.navigationTimeoutMs,
          result.assertionErrors,
        );
        const actual = await page.screenshot({
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        const comparison = comparePNGs(
          baseline,
          actual,
          manifest.config.pixelThreshold,
        );
        result.diffPixels = comparison.pixels;
        result.diffRatio = comparison.ratio;
        result.dimensionsMatch = comparison.dimensionsMatch;
        result.geometryErrors = compareGeometry(
          expectedLayout,
          actualLayout,
          manifest.config.geometryTolerance,
        );
        result.screenshot = state.id + "/actual.png";
        result.diff = state.id + "/diff.png";
        await save(path.join(out, result.screenshot), actual);
        await save(path.join(out, result.diff), comparison.diff);
        await saveJson(path.join(out, state.id + "/layout.json"), actualLayout);
        await copyFile(
          inside(captureDir, state.screenshot),
          path.join(out, state.id + "/original.png"),
        );
        result.missingRequests = [...new Set(result.missingRequests)];
        const sourceIncomplete = manifest.issues.some(
          (i) =>
            i.stateId === state.id &&
            ["ELEMENT_LIMIT", "SOURCE_ASSERTION_FAILED"].includes(i.code),
        );
        if (
          noise.ratio > manifest.config.maxDiffRatio ||
          !noise.dimensionsMatch
        )
          result.status = "unstable";
        else
          result.status =
            comparison.dimensionsMatch &&
            comparison.ratio <= manifest.config.maxDiffRatio &&
            !result.geometryErrors.length &&
            !result.assertions.includes(false) &&
            !state.assertionResults.includes(false) &&
            !result.missingRequests.length &&
            !result.consoleErrors.length &&
            !result.environmentErrors.length &&
            !sourceIncomplete
              ? "pass"
              : "fail";
      } catch (e) {
        result.error = String(e);
        result.status = "error";
      } finally {
        observing = false;
        await context.close();
      }
      output.results.push(result);
      output.totals[result.status]++;
      await saveJson(path.join(out, state.id, "result.json"), result);
      progress(
        "Verificado: " +
          state.id +
          " · " +
          result.status +
          (result.diffRatio !== undefined
            ? " · diferencia " + (result.diffRatio * 100).toFixed(4) + "%"
            : ""),
      );
    };
    const workers = Number(process.env.REPLICA_VERIFY_WORKERS ?? 2);
    if (!Number.isInteger(workers) || workers < 1 || workers > 4)
      throw new Error("REPLICA_VERIFY_WORKERS debe estar entre 1 y 4.");
    for (let i = 0; i < selected.length; i += workers)
      await Promise.all(selected.slice(i, i + workers).map(verifyState));
    const order = new Map(manifest.states.map((s, i) => [s.id, i]));
    output.results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } finally {
    await browser.close();
    await server.close();
  }
  await saveJson(path.join(out, "verification.json"), output);
  await report(output, out);
  return output;
}
