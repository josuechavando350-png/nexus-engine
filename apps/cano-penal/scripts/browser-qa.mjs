#!/usr/bin/env node
// Independently verify the CANO site. Never treats CORTEX's isolated probe as CANO evidence.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const requireFromCapture = createRequire(new URL("../../../packages/capture/package.json", import.meta.url));
const { chromium, webkit } = requireFromCapture("playwright");

const base = process.env.CANO_QA_BASE || "http://127.0.0.1:3000";
const output = resolve(process.env.CANO_QA_OUTPUT || "artifacts/cano-browser-qa");
const routes = [
  "/", "/acerca-de-mi", "/casos", "/aviso-de-privacidad",
  "/areas/delitos-fiscales-y-financieros",
  "/areas/delitos-patrimoniales-y-fraude",
  "/areas/homicidio-y-delitos-violentos",
  "/areas/delitos-sexuales",
  "/areas/corrupcion-y-administracion-publica",
  "/areas/despojo-y-defensa-de-victimas",
  "/areas/justicia-penal-para-adolescentes",
  "/areas/amparo-recursos-y-apelaciones",
  "/detenido-cdmx",
  "/citatorio-ministerio-publico-cdmx",
  "/audiencia-inicial-control-detencion-cdmx",
  "/diagnostico-penal",
  "/guias/requerimiento-sat-riesgo-penal",
  "/guias/responsabilidad-penal-representante-legal-contador",
  "/guias/defensa-penal-empresa-delitos-financieros",
  "/guias/honorarios-abogado-penalista-cdmx",
  "/herramientas/calendario-fiscal",
];
const visualRoutes = new Set([
  "/", "/areas/delitos-fiscales-y-financieros", "/areas/delitos-patrimoniales-y-fraude",
  "/areas/homicidio-y-delitos-violentos", "/areas/delitos-sexuales",
  "/areas/corrupcion-y-administracion-publica", "/areas/despojo-y-defensa-de-victimas",
  "/areas/justicia-penal-para-adolescentes", "/areas/amparo-recursos-y-apelaciones",
  "/detenido-cdmx", "/diagnostico-penal", "/herramientas/calendario-fiscal",
  "/guias/responsabilidad-penal-representante-legal-contador",
  "/guias/requerimiento-sat-riesgo-penal",
]);
const failures = [];
const results = [];
const screenshotPaths = [];

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
function slug(path) {
  return path === "/" ? "home" : path.slice(1).replaceAll("/", "--");
}
function noteFailure(label, error) {
  const message = label + ": " + (error?.stack || String(error));
  failures.push(message);
  console.error("FAIL " + message);
}

await mkdir(output, { recursive: true });
for (const spec of [
  { name: "chromium-mobile", engine: chromium, viewport: { width: 390, height: 844 }, isMobile: true, routes },
  { name: "chromium-tablet", engine: chromium, viewport: { width: 820, height: 1180 }, isMobile: false, routes },
  { name: "chromium-laptop", engine: chromium, viewport: { width: 1024, height: 768 }, isMobile: false, routes },
  { name: "chromium-desktop", engine: chromium, viewport: { width: 1440, height: 900 }, isMobile: false, routes },
  { name: "webkit-mobile", engine: webkit, viewport: { width: 390, height: 844 }, isMobile: true,
    routes: ["/", "/detenido-cdmx", "/diagnostico-penal", "/areas/delitos-fiscales-y-financieros", "/herramientas/calendario-fiscal"] },
]) {
  const browser = await spec.engine.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: spec.viewport,
      isMobile: spec.isMobile,
      deviceScaleFactor: 1,
      locale: "es-MX",
      reducedMotion: "reduce",
    });
    for (const route of spec.routes) {
      const label = spec.name + " " + route;
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error)));
      try {
        const response = await page.goto(new URL(route, base).href, {
          waitUntil: "domcontentloaded", timeout: 30000,
        });
        assert(response && response.status() < 400, "HTTP response is " + (response?.status() ?? "missing"));
        await page.locator("main#main-content h1").first().waitFor({ state: "visible", timeout: 12000 });
        assert(await page.locator("main#main-content h1").count() === 1, "expected one main h1");
        await page.waitForFunction(() => {
          const img = document.querySelector("header img");
          return img && img.complete && img.naturalWidth > 0;
        }, null, { timeout: 8000 });
        await page.waitForTimeout(170);
        const measurements = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        assert(measurements.document <= measurements.viewport + 3
          && measurements.body <= measurements.viewport + 3,
          "horizontal overflow " + JSON.stringify(measurements));
        assert(pageErrors.length === 0, "browser exceptions: " + pageErrors.join(" | "));
        if (route === "/herramientas/calendario-fiscal") {
          assert(await page.getByText("Aviso de carácter informativo").count() > 0,
            "prominent fiscal disclaimer absent");
          assert(await page.getByText("Todavía no hay vencimientos fiscales certificados", { exact: false }).count() > 0,
            "unverified deadlines must remain unpublished");
          const robots = await page.locator('meta[name="robots"]').getAttribute("content");
          assert((robots || "").includes("noindex"), "uncertified calendar must remain noindex");
        }
        if (route === "/") {
          for (const destination of [
            "/detenido-cdmx", "/citatorio-ministerio-publico-cdmx",
            "/audiencia-inicial-control-detencion-cdmx", "/diagnostico-penal",
            "/guias/requerimiento-sat-riesgo-penal",
            "/guias/responsabilidad-penal-representante-legal-contador",
            "/guias/defensa-penal-empresa-delitos-financieros",
            "/guias/honorarios-abogado-penalista-cdmx",
          ]) {
            assert(await page.locator('main a[href="' + destination + '"]').count() > 0,
              "homepage commercial route missing " + destination);
          }
          assert(await page.locator("main .cp-organic-bridge").count() === 0,
            "fiscal feature must remain in its own navigation section");
          if (spec.isMobile) {
            const menu = page.locator("header details.cp-mobile-nav summary");
            await menu.click({ timeout: 5000 });
            assert(await page.locator('header details.cp-mobile-nav nav a[href="/herramientas/calendario-fiscal"]').isVisible(),
              "mobile fiscal calendar link not accessible");
            if (spec.name === "chromium-mobile") {
              const menuProof = "chromium-mobile__home-menu.png";
              await page.screenshot({ path: join(output, menuProof), fullPage: false, animations: "disabled" });
              screenshotPaths.push(menuProof);
            }
            await menu.click();
            assert(!(await page.locator("header details.cp-mobile-nav").evaluate(el => el.open)),
              "mobile navigation failed to close");
          }
        }
        const screenshot = visualRoutes.has(route) && (spec.name === "chromium-mobile" || spec.name === "chromium-desktop");
        if (screenshot) {
          if (route === "/") await page.locator(".cp-splash").waitFor({ state: "hidden", timeout: 5000 });
          const filename = spec.name + "__" + slug(route) + ".png";
          await page.screenshot({ path: join(output, filename), fullPage: true, animations: "disabled" });
          screenshotPaths.push(filename);
        }
        results.push({ label, status: "PASS", measurements });
        console.log("PASS " + label);
      } catch (error) {
        noteFailure(label, error);
        results.push({ label, status: "FAIL", message: String(error) });
        const filename = "failure__" + spec.name + "__" + slug(route) + ".png";
        await page.screenshot({ path: join(output, filename), fullPage: false, timeout: 7000 }).catch(() => {});
      } finally {
        await page.close();
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
}
const manifest = {
  sha: process.env.NEXUS_VALIDATED_SHA || null,
  base, checked: results.length, pass: results.filter(r => r.status === "PASS").length,
  fail: failures.length, routes, screenshots: screenshotPaths, results, failures,
};
await writeFile(join(output, "report.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("CANO browser QA: " + manifest.pass + "/" + manifest.checked + " passing; screenshots " + screenshotPaths.length);
if (failures.length) process.exitCode = 1;
