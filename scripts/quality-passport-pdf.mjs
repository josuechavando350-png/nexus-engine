#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const normalizePath = (path) => path.split(sep).join("/");
const available = (value) => value === undefined || value === null || value === "" ? "no disponible" : String(value);
const escapeHtml = (value) => available(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function displayDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "no disponible";
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(parsed);
}

export function buildPassportHtml(passport) {
  const checks = Array.isArray(passport.checks) ? passport.checks : [];
  const artifactCount = passport.artifactHashes && typeof passport.artifactHashes === "object"
    ? Object.keys(passport.artifactHashes).length
    : 0;
  const viewport = passport.viewport && typeof passport.viewport === "object"
    ? `${available(passport.viewport.width)} × ${available(passport.viewport.height)}`
    : "no disponible";
  const rows = checks.length
    ? checks.map((check) => `<tr><td>${escapeHtml(check.id)}</td><td><span class="status status-${escapeHtml(check.status).toLowerCase()}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>`).join("")
    : '<tr><td colspan="3">no disponible</td></tr>';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #172033; font: 10.5pt Arial, sans-serif; line-height: 1.4; }
  header { border-bottom: 3px solid #172033; padding-bottom: 12px; margin-bottom: 18px; }
  .eyebrow { color: #566176; font-size: 9pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { font-size: 27pt; margin: 4px 0 2px; }
  .project { font-size: 15pt; font-weight: 700; }
  .date { color: #566176; margin-top: 3px; }
  h2 { font-size: 12pt; margin: 17px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
  .identity { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #d6dbe4; }
  .identity div { padding: 8px 10px; border-bottom: 1px solid #d6dbe4; }
  .identity div:nth-child(odd) { border-right: 1px solid #d6dbe4; }
  .identity div:nth-last-child(-n+2) { border-bottom: 0; }
  dt { color: #566176; font-size: 8pt; font-weight: 700; text-transform: uppercase; }
  dd { margin: 2px 0 0; overflow-wrap: anywhere; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border-bottom: 1px solid #d6dbe4; padding: 7px 6px; text-align: left; vertical-align: top; }
  th { background: #eef1f5; font-size: 8pt; text-transform: uppercase; }
  th:nth-child(1) { width: 23%; } th:nth-child(2) { width: 17%; }
  .status { font-size: 8pt; font-weight: 700; }
  .status-pass { color: #176b3a; } .status-fail { color: #a42323; }
  .verdict { border: 2px solid #172033; display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding: 12px 14px; }
  .verdict strong { font-size: 25pt; }
  .summary { background: #eef1f5; padding: 10px 12px; }
  .hash { font-family: monospace; font-size: 8.5pt; overflow-wrap: anywhere; }
  footer { border-top: 1px solid #aeb6c4; color: #566176; font-size: 8.5pt; margin-top: 18px; padding-top: 9px; }
</style></head><body>
  <header><div class="eyebrow">Certificado de entrega</div><h1>${escapeHtml(passport.projectId)}</h1><div class="project">${escapeHtml(passport.projectId)}</div><div class="date">Generado: ${escapeHtml(displayDate(passport.generatedAt))} UTC</div></header>
  <h2>Identidad</h2><dl class="identity">
    <div><dt>Proyecto</dt><dd>${escapeHtml(passport.projectId)}</dd></div>
    <div><dt>Versión del motor</dt><dd>${escapeHtml(passport.engineVersion)}</dd></div>
    <div><dt>Commit</dt><dd class="hash">${escapeHtml(passport.sourceRevision)}</dd></div>
    <div><dt>Viewport</dt><dd>${escapeHtml(viewport)}</dd></div>
  </dl>
  <h2>Comprobaciones de entrega</h2><table><thead><tr><th>Identificador</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table>
  <section class="verdict"><span>Veredicto de entrega</span><strong>${escapeHtml(passport.verdict)}</strong></section>
  <h2>Resumen de artefactos</h2><section class="summary"><div><strong>Archivos:</strong> ${artifactCount}</div><div><strong>Hash del Passport:</strong></div><div class="hash">${escapeHtml(passport.passportHash)}</div></section>
  <footer>El hash del Passport permite verificar que la información certificada de esta entrega no fue alterada.</footer>
</body></html>`;
}

async function loadQualityPassportContract(repositoryRoot) {
  const compiledContract = join(repositoryRoot, "packages", "quality", "dist", "quality", "quality-passport.js");
  execFileSync("pnpm", ["--filter", "@nexus/quality", "build"], { cwd: repositoryRoot, stdio: "inherit" });
  return import(pathToFileURL(compiledContract).href);
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const projectId = process.env.NEXUS_PROJECT_ID?.trim();
  if (!projectId) throw new Error("NEXUS_PROJECT_ID is required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) throw new Error("NEXUS_PROJECT_ID must be a kebab-case monorepo app id");

  const inputPath = join(repositoryRoot, ".artifacts", "quality-passports", `${projectId}.json`);
  const outputPath = join(repositoryRoot, ".artifacts", "quality-passports", `${projectId}.pdf`);
  const passport = JSON.parse(await readFile(inputPath, "utf8"));
  const { verifyQualityPassport } = await loadQualityPassportContract(repositoryRoot);
  if (!verifyQualityPassport(passport)) throw new Error(`Quality Passport integrity verification failed: ${normalizePath(relative(repositoryRoot, inputPath))}`);

  const requireFromCapture = createRequire(join(repositoryRoot, "packages", "capture", "package.json"));
  const { chromium } = requireFromCapture("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(buildPassportHtml(passport), { waitUntil: "load" });
  await mkdir(dirname(outputPath), { recursive: true });
  await page.pdf({ path: outputPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  await browser.close();
  process.stdout.write(`${normalizePath(relative(repositoryRoot, outputPath))}\n`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });
