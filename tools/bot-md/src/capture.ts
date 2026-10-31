import path from "node:path";
import { readFile } from "node:fs/promises";
import TurndownService from "turndown";
import { collectCSSDependencies } from "./dependencies.js";
import { refreshComponentResponses } from "./raw-responses.js";
import {
  launch,
  settle,
  layout,
  discoverControls,
  applySteps,
  checkAssertions,
} from "./browser.js";
import {
  canonical,
  hash,
  localPath,
  newDirectory,
  save,
  saveJson,
} from "./common.js";
import { allowedURL, installCapturePolicy } from "./network.js";
import type { Config, Manifest, Scenario, State, Resource } from "./types.js";
import {
  replayResponseHeaders,
  routingRequestHeaders,
} from "./http-metadata.js";

export async function capture(
  c: Config,
  out: string,
  progress: (message: string) => void = console.log,
): Promise<Manifest> {
  if (!(await allowedURL(c.url, c.allowLocalhost)))
    throw new Error(
      "Destino de red no permitido. Para pruebas locales usa allowLocalhost=true.",
    );
  await newDirectory(out);
  const browser = await launch(true);
  const manifest: Manifest = {
    schemaVersion: 1,
    version: "0.2.1",
    createdAt: new Date().toISOString(),
    browserVersion: browser.version(),
    config: c,
    origin: new URL(c.url).origin,
    pages: [],
    resources: {},
    states: [],
    issues: [],
    files: {},
  };
  let totalBytes = 0;
  const pending = new Set<Promise<void>>();
  const drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const markdown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  markdown.remove(["script", "style", "noscript"]);
  const queue = [c.url];
  for (const s of c.scenarios)
    if (s.path) {
      const u = canonical(s.path, c.url);
      if (!queue.includes(u)) queue.push(u);
    }
  try {
    for (
      let p = 0;
      p < queue.length && manifest.pages.length < c.maxPages;
      p++
    ) {
      const url = queue[p];
      manifest.pages.push(url);
      for (const viewport of c.viewports) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          locale: "es-MX",
          timezoneId: "UTC",
          serviceWorkers: "block",
          colorScheme: "light",
          reducedMotion: "reduce",
          acceptDownloads: false,
        });
        await installCapturePolicy(context, c.allowLocalhost, manifest.issues);
        context.on("response", (response) => {
          const task = (async () => {
            const req = response.request();
            if (req.method() !== "GET") return;
            const resourceUrl = canonical(response.url());
            if (response.status() < 200 || response.status() >= 300) {
              manifest.issues.push({
                code: "HTTP_STATUS",
                detail: response.status() + " " + resourceUrl,
              });
              return;
            }
            const length = Number(response.headers()["content-length"] ?? 0);
            if (length > c.maxResourceBytes) {
              manifest.issues.push({
                code: "RESOURCE_LIMIT",
                detail: resourceUrl,
              });
              return;
            }
            const body = await response.body();
            if (
              body.length > c.maxResourceBytes ||
              totalBytes + body.length > c.maxTotalBytes
            ) {
              manifest.issues.push({
                code: "RESOURCE_LIMIT",
                detail: resourceUrl,
              });
              return;
            }
            const sha256 = hash(body),
              previous = manifest.resources[resourceUrl];
            if (previous) {
              if (
                previous.sha256 !== sha256 &&
                !previous.variants.includes(sha256)
              ) {
                previous.variants.push(sha256);
                manifest.issues.push({
                  code: "DYNAMIC_RESOURCE",
                  detail: resourceUrl,
                });
              }
              return;
            }
            totalBytes += body.length;
            const resource: Resource = {
              url: resourceUrl,
              status: response.status(),
              mime:
                response.headers()["content-type"] ??
                "application/octet-stream",
              kind: req.resourceType(),
              sha256,
              bytes: body.length,
              file: "resources/" + sha256,
              localPath: localPath(resourceUrl, manifest.origin),
              variants: [],
              responseHeaders: replayResponseHeaders(response.headers()),
              requestHeaders: routingRequestHeaders(req.headers()),
            };
            manifest.resources[resourceUrl] = resource;
            await save(path.join(out, resource.file), body);
          })().catch((e) => {
            manifest.issues.push({
              code: "RESPONSE_UNAVAILABLE",
              detail: response.url() + ": " + String(e),
            });
          });
          pending.add(task);
          void task.finally(() => pending.delete(task));
        });
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(c.navigationTimeoutMs);
        page.on("dialog", (d) => {
          void d.dismiss();
        });
        page.on("pageerror", (e) =>
          manifest.issues.push({ code: "SOURCE_JS_ERROR", detail: e.message }),
        );
        try {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await settle(page, c, true);
          await drain();
          if (new URL(page.url()).origin !== manifest.origin) {
            manifest.issues.push({
              code: "ORIGIN_REDIRECT",
              detail: page.url(),
            });
            continue;
          }
          const finalUrl = canonical(page.url());
          if (finalUrl !== url)
            manifest.issues.push({
              code: "PAGE_REDIRECT",
              detail: url + " → " + finalUrl,
            });
          if (viewport === c.viewports[0]) {
            const links = await page
              .locator("a[href]")
              .evaluateAll((els) =>
                els.map((el) => (el as HTMLAnchorElement).href),
              );
            for (const link of links) {
              try {
                const u = new URL(link);
                u.hash = "";
                if (
                  u.origin === manifest.origin &&
                  ["http:", "https:"].includes(u.protocol) &&
                  !u.search &&
                  !/\.(pdf|zip|png|jpe?g|svg|mp4)$/i.test(u.pathname) &&
                  !queue.includes(u.href) &&
                  queue.length < c.maxPages * 5
                )
                  queue.push(u.href);
              } catch {}
            }
          }
          const auto = c.autoExplore
            ? await discoverControls(page, c.maxStates - 1)
            : [];
          const explicit = c.scenarios.filter(
            (s) => !s.path || canonical(s.path, c.url) === url,
          );
          const scenarios: Scenario[] = [
            { name: "initial", steps: [], assertions: [] },
            ...explicit,
            ...auto,
          ].slice(0, c.maxStates);
          if (1 + explicit.length + auto.length > c.maxStates)
            manifest.issues.push({
              code: "STATE_LIMIT",
              detail: url + " " + viewport.name,
            });
          for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i];
            const id = "p" + p + "-" + viewport.name + "-s" + i;
            try {
              if (i > 0) {
                await page.goto(finalUrl, { waitUntil: "domcontentloaded" });
                await settle(page, c, true);
              }
              await applySteps(page, scenario.steps);
              await settle(page, c);
              await drain();
              const measured = await layout(page, c.maxElements);
              if (measured.height > 30000)
                throw new Error(
                  "Página demasiado alta para captura completa (30000px).",
                );
              const prefix = "states/" + id;
              const state: State = {
                id,
                name: scenario.name,
                url: finalUrl,
                viewport,
                steps: scenario.steps,
                assertions: scenario.assertions ?? [],
                assertionResults: await checkAssertions(
                  page,
                  scenario.assertions ?? [],
                  c.navigationTimeoutMs,
                ),
                capturedAt: new Date().toISOString(),
                screenshot: prefix + "/original.png",
                repeatScreenshot: prefix + "/repeat.png",
                layout: prefix + "/layout.json",
                renderedHtml: prefix + "/rendered.html",
                markdown: prefix + "/content.md",
                hash: "",
              };
              const html = await page.content();
              await save(path.join(out, state.renderedHtml), html);
              await saveJson(path.join(out, state.layout), measured);
              await save(
                path.join(out, state.markdown),
                markdown.turndown(html),
              );
              await page.screenshot({
                path: path.join(out, state.screenshot),
                fullPage: true,
                animations: "disabled",
                caret: "hide",
              });
              await page.waitForTimeout(150);
              await page.screenshot({
                path: path.join(out, state.repeatScreenshot),
                fullPage: true,
                animations: "disabled",
                caret: "hide",
              });
              state.hash = hash(
                await readFile(path.join(out, state.screenshot)),
              );
              if (i === 0) {
                const client = await context.newCDPSession(page);
                try {
                  const snapshot = await client.send(
                    "DOMSnapshot.captureSnapshot",
                    {
                      computedStyles: [
                        "display",
                        "position",
                        "font-family",
                        "font-size",
                        "color",
                        "background-color",
                        "width",
                        "height",
                      ],
                      includePaintOrder: true,
                      includeDOMRects: true,
                    },
                  );
                  state.domSnapshot = prefix + "/dom-snapshot.json";
                  await saveJson(path.join(out, state.domSnapshot), snapshot);
                  await client.send("DOM.enable");
                  await client.send("CSS.enable");
                  const doc = await client.send("DOM.getDocument");
                  const nodes = await client.send("DOM.querySelectorAll", {
                    nodeId: doc.root.nodeId,
                    selector: "h1,h2,h3,p,a,button",
                  });
                  const fonts = [];
                  for (const nodeId of nodes.nodeIds.slice(0, 100)) {
                    try {
                      fonts.push({
                        nodeId,
                        ...(await client.send("CSS.getPlatformFontsForNode", {
                          nodeId,
                        })),
                      });
                    } catch {}
                  }
                  state.platformFonts = prefix + "/platform-fonts.json";
                  await saveJson(path.join(out, state.platformFonts), fonts);
                } catch (e) {
                  manifest.issues.push({
                    code: "CDP_PARTIAL",
                    detail: String(e),
                    stateId: id,
                  });
                }
                // Keep the inspection session until context.close(). Detaching here
                // resets Chromium input emulation and changes hover/pointer media.
              }
              if (measured.truncated)
                manifest.issues.push({
                  code: "ELEMENT_LIMIT",
                  detail: String(c.maxElements),
                  stateId: id,
                });
              for (const [kind, count] of Object.entries(measured.unsupported))
                if (count)
                  manifest.issues.push({
                    code: "COMPLEX_CONTENT",
                    detail: kind + ": " + count,
                    stateId: id,
                  });
              if (state.assertionResults.includes(false))
                manifest.issues.push({
                  code: "SOURCE_ASSERTION_FAILED",
                  detail: scenario.name,
                  stateId: id,
                });
              manifest.states.push(state);
              progress(
                "Capturado: " +
                  url +
                  " · " +
                  viewport.name +
                  " · " +
                  scenario.name,
              );
            } catch (e) {
              manifest.issues.push({
                code: "STATE_FAILED",
                detail: String(e),
                stateId: id,
              });
            }
          }
        } catch (e) {
          manifest.issues.push({
            code: "PAGE_FAILED",
            detail: url + " " + String(e),
          });
        } finally {
          await drain();
          await context.close();
        }
      }
    }
  } finally {
    await drain();
    await browser.close();
  }
  if (queue.length > manifest.pages.length)
    manifest.issues.push({
      code: "PAGE_LIMIT",
      detail:
        "URLs descubiertas: " +
        queue.length +
        "; páginas visitadas: " +
        manifest.pages.length,
    });
  await collectCSSDependencies(manifest, out);
  await refreshComponentResponses(manifest, out);
  for (const state of manifest.states)
    for (const file of [
      state.screenshot,
      state.repeatScreenshot,
      state.layout,
      state.renderedHtml,
      state.markdown,
      state.domSnapshot,
      state.platformFonts,
    ].filter(Boolean) as string[])
      manifest.files[file] = hash(await readFile(path.join(out, file)));
  for (const resource of Object.values(manifest.resources))
    manifest.files[resource.file] = resource.sha256;
  await saveJson(path.join(out, "manifest.json"), manifest);
  const manifestHash = hash(await readFile(path.join(out, "manifest.json")));
  await saveJson(path.join(out, "seal.json"), {
    algorithm: "sha256",
    manifestHash,
    note: "Detecta modificaciones accidentales; no es una firma externa.",
  });
  progress(
    "Captura terminada: " +
      manifest.states.length +
      " estados, " +
      Object.keys(manifest.resources).length +
      " recursos.",
  );
  if (!manifest.states.length)
    throw new Error("No se capturó ningún estado. Revisa manifest.json.");
  return manifest;
}
