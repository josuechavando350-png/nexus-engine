#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceBinding(path, bytes) {
  return Object.freeze({ path, sha256: sha256Bytes(bytes) });
}

function parseArgs(argv) {
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--out") throw new Error(`unknown argument:${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing value for --out");
    out = resolve(value);
    index += 1;
  }
  if (!out) throw new Error("--out is required");
  return { out };
}

export async function buildRound1Evidence({ repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))) } = {}) {
  const paths = {
    parentAudit: "tournaments/cano-penal-zero/audit-evidence.json",
    sitemap: "apps/cano-penal/src/app/sitemap.ts",
    content: "apps/cano-penal/src/app/content.ts",
    home: "apps/cano-penal/src/app/page.tsx",
    interactions: "apps/cano-penal/src/app/ClientInteractions.tsx",
    about: "apps/cano-penal/src/app/acerca-de-mi/page.tsx",
    cases: "apps/cano-penal/src/app/casos/page.tsx",
    areaPage: "apps/cano-penal/src/app/areas/[slug]/page.tsx",
    approvedAreas: "apps/cano-penal/src/approved-programmatic-seo.ts",
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    const bytes = await readFile(resolve(repoRoot, path));
    return [key, { path, bytes, text: bytes.toString("utf8") }];
  }));
  const files = Object.fromEntries(entries);
  const parentAudit = JSON.parse(files.parentAudit.text);

  assert.equal(parentAudit.tournamentId, "CANO_PENAL_CDMX_ZERO");
  assert.equal(parentAudit.siteId, "cano-penal");
  assert.match(files.content.text, /delitos-fiscales-y-financieros/);
  assert.match(files.approvedAreas.text, /Las investigaciones por delitos fiscales no empiezan con una detención/);
  assert.match(files.home.text, /Me llegó un citatorio/);
  assert.match(files.home.text, /Detuvieron a alguien/);
  assert.match(files.home.text, /a cualquier hora/);
  assert.match(files.home.text, /Diagnóstico y estrategia/);
  assert.match(files.home.text, /<strong>\$2,500<\/strong>/);
  assert.match(files.home.text, /<form className="cp-form">/);
  assert.doesNotMatch(files.home.text, /<form[^>]+(?:action=|onSubmit=)/);
  assert.doesNotMatch(files.interactions.text, /submit|cp-form/i);
  assert.match(files.about.text, /trajectory/);
  assert.match(files.cases.text, /cases\.map/);
  assert.doesNotMatch(files.sitemap.text, /citatorio|detenido|calendario/i);

  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const sourceFiles = Object.freeze(
    Object.values(files)
      .filter((row) => row.path !== paths.parentAudit)
      .map((row) => sourceBinding(row.path, row.bytes))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );

  const sourceSignals = [
    {
      id: "R01",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_ROUTE_INVENTORY",
      claim: "El sitemap fuente publica home, acerca-de-mi, casos, ocho áreas de práctica y aviso de privacidad; no contiene rutas independientes de citatorio, detenido o calendario fiscal.",
      sourcePaths: [paths.sitemap, paths.content],
    },
    {
      id: "R02",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_INTENT_ROUTING",
      claim: "La home ya distingue citatorio y detenido y los envía a WhatsApp con mensajes prellenados diferentes.",
      sourcePaths: [paths.home],
    },
    {
      id: "R03",
      status: "SOURCE_CLAIM_NEEDS_OPERATIONAL_CONFIRMATION",
      topic: "CURRENT_24H_CLAIM",
      claim: "La home publica para detenido la frase 'Atención inmediata, a cualquier hora'; el código demuestra la afirmación publicada, no disponibilidad operativa real 24/7.",
      sourcePaths: [paths.home],
    },
    {
      id: "R04",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_DIAGNOSTIC_OFFER",
      claim: "La home ya ofrece 'Diagnóstico y estrategia' por 2,500 MXN y describe valoración y estudio inicial, pero no desarrolla una metodología detallada del diagnóstico.",
      sourcePaths: [paths.home],
    },
    {
      id: "R05",
      status: "SOURCE_VERIFIED_IMPLEMENTATION_GAP",
      topic: "CURRENT_CONTACT_FORM",
      claim: "El page source renderiza campos de formulario sin action ni onSubmit y ClientInteractions no registra manejo de submit; el CTA operativo visible separado es WhatsApp.",
      sourcePaths: [paths.home, paths.interactions],
    },
    {
      id: "R06",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_FISCAL_HUB",
      claim: "CANO ya tiene una ruta de delitos fiscales y financieros y contenido aprobado sobre auditorías, requerimientos, defraudación fiscal, responsabilidad de representantes y contadores, y defensa temprana.",
      sourcePaths: [paths.content, paths.areaPage, paths.approvedAreas],
    },
    {
      id: "R07",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_AUTHORITY_PAGE",
      claim: "Existe una página Acerca de mí dedicada que reutiliza la trayectoria y formación académica de Eduardo Cano; una estrategia de timeline debe mejorar ese activo y no duplicarlo.",
      sourcePaths: [paths.about, paths.content],
    },
    {
      id: "R08",
      status: "SOURCE_VERIFIED",
      topic: "CURRENT_CASE_LIBRARY",
      claim: "La biblioteca de casos ya incluye defensa en delito fiscal entre sus casos publicados.",
      sourcePaths: [paths.cases, paths.content],
    },
    {
      id: "R09",
      status: "SOURCE_VERIFIED_GAP",
      topic: "NO_STANDALONE_CITATORIO_DETENIDO_ROUTE",
      claim: "En el inventario de sitemap y áreas no existen rutas independientes para citatorio o detenido; ambas intenciones viven actualmente en la home.",
      sourcePaths: [paths.sitemap, paths.content, paths.home],
    },
    {
      id: "R10",
      status: "SOURCE_VERIFIED_GAP",
      topic: "NO_INTERACTIVE_FISCAL_CALENDAR_ROUTE",
      claim: "El inventario de sitemap y áreas no contiene una ruta de calendario fiscal o herramienta fiscal interactiva.",
      sourcePaths: [paths.sitemap, paths.content],
    },
  ];

  const evidence = {
    schemaVersion: 1,
    tournamentId: "CANO_PENAL_CDMX_ZERO",
    stage: "ROUND_1_SITE_EVIDENCE",
    siteId: "cano-penal",
    siteHostname: "canopenal.com",
    sourceRevision,
    sourceTree,
    parentAuditSha256: sha256Bytes(files.parentAudit.bytes),
    sourceFiles,
    signals: [...parentAudit.signals, ...sourceSignals],
    interpretation: "SOURCE_AND_AUDIT_EVIDENCE_ONLY_NO_TRAFFIC_CONVERSION_OR_CLIENT_OUTCOME_INFERENCE",
  };
  return Object.freeze(evidence);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out } = parseArgs(process.argv.slice(2));
  buildRound1Evidence().then(async (evidence) => {
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(out, body);
    process.stdout.write(JSON.stringify({
      status: "PASS",
      stage: evidence.stage,
      signalCount: evidence.signals.length,
      sourceFileCount: evidence.sourceFiles.length,
      evidenceSha256: sha256Bytes(Buffer.from(body, "utf8")),
    }) + "\n");
  }).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
