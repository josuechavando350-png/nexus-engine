import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { construirSolicitud, ejecutarAvengers, resumirRecibos, fuenteQueDesbloquea } from "../cerebro/avengers.mjs";
import { validarPerfil } from "../core/perfil.mjs";
import { construirEstrategia } from "../core/estratega.mjs";
import { rastrear } from "../ojos/crawler.mjs";
import { auditar } from "../ojos/auditoria.mjs";
import { generarReporte } from "../reporte.mjs";
import { perfilBase, perfilCano, sitioFalso } from "./fixtures.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELOJ = () => new Date("2026-10-11T12:00:00Z");
const hayPython = spawnSync(process.env.SUPERSEO_PYTHON ?? "python3", ["--version"]).status === 0;

async function snapshotFalso() {
  const s = sitioFalso();
  return { s, snap: await rastrear({ inicio: s.origen, fetchImpl: s.fetchImpl, reloj: RELOJ }) };
}

test("la solicitud a Avengers lleva solo páginas indexables y datos del negocio", async () => {
  const { s, snap } = await snapshotFalso();
  const perfil = validarPerfil(perfilBase({ dominio: s.origen }));
  const sol = construirSolicitud(snap, perfil);
  const ids = sol.payload.content_documents.map((d) => d.document_id).sort();
  assert.deepEqual(ids, ["/", "/contacto", "/fraude-coyoacan", "/fraude-iztapalapa", "/huerfana"]);
  assert.ok(!ids.includes("/privada"), "excluye noindex");
  assert.deepEqual(sol.payload.local_business_records.map((r) => r.source_id), ["site:/", "superseo:perfil"]);
  assert.equal(sol.config.local_brand_terms[0], "despacho de prueba");
  assert.deepEqual(sol.payload.search_performance_records, []);
});

test("cada dato faltante dice qué lo desbloquea", () => {
  assert.equal(fuenteQueDesbloquea("search_performance_records_empty"), "Search Console del cliente");
  assert.equal(fuenteQueDesbloquea("no_eligible_search_demand"), "Search Console del cliente");
  assert.equal(fuenteQueDesbloquea("keyword_coverage_records_empty"), "Demand Miner (Keyword Planner y competencia)");
  assert.equal(fuenteQueDesbloquea("algo_raro"), "Evidencia adicional");
});

test("el resumen cuenta estados, familias y hallazgos sin inventar", () => {
  const recibo = (module, family, execution_status, finding_status, reason_code) => ({ module, family, operation: "op", execution_status, finding_status, reason_code });
  const respuesta = {
    receipt_count: 3, first_module: "M1001", last_module: "M2500", execution_hash: "h", terminal_evidence_hash: "t",
    receipts: {
      M1001: recibo("M1001", "LOCAL", "SUCCESS", "FINDING", "X_FINDING"),
      M1002: recibo("M1002", "LOCAL", "INSUFFICIENT_DATA", "NOT_APPLICABLE", "search_performance_records_empty"),
      M2500: recibo("M2500", "TERMINAL", "SUCCESS", "NO_FINDING", "OK"),
    },
  };
  const sol = { payload: { content_documents: [], local_business_records: [], search_performance_records: [] }, config: {} };
  const r = resumirRecibos(respuesta, sol);
  assert.deepEqual(r.por_estado, { SUCCESS: 2, INSUFFICIENT_DATA: 1, ERROR: 0 });
  assert.equal(r.total_hallazgos, 1);
  assert.deepEqual(r.desbloqueos, [{ fuente: "Search Console del cliente", modulos: 1 }]);
  assert.deepEqual(r.terminal, { estado: "SUCCESS", razon: "OK" });
});

test("integración real: los 1,500 módulos de Avengers corren sobre el rastreo sin errores", { skip: !hayPython && "sin python3" }, async () => {
  const { s, snap } = await snapshotFalso();
  const perfil = validarPerfil(perfilBase({ dominio: s.origen }));
  const sol = construirSolicitud(snap, perfil);
  const r1 = resumirRecibos(ejecutarAvengers(sol), sol);
  assert.equal(r1.modulos, 1500);
  assert.equal(r1.rango, "M1001–M2500");
  assert.equal(r1.por_estado.ERROR, 0);
  assert.ok(r1.por_estado.SUCCESS > 0);
  assert.ok(r1.desbloqueos.some((d) => d.fuente === "Search Console del cliente"));
  const r2 = resumirRecibos(ejecutarAvengers(sol), sol);
  assert.equal(r1.execution_hash, r2.execution_hash, "misma evidencia, mismo resultado");
});

test("el reporte en español cuenta la historia completa", { skip: !hayPython && "sin python3" }, async () => {
  const { s, snap } = await snapshotFalso();
  const perfil = validarPerfil(perfilBase({ dominio: s.origen, estado: "PREPARACION" }));
  const sol = construirSolicitud(snap, perfil);
  const md = generarReporte({
    perfil,
    estrategia: construirEstrategia(perfil),
    auditoria: auditar(snap, { perfil }),
    avengers: resumirRecibos(ejecutarAvengers(sol), sol),
    ahora: RELOJ(),
  });
  assert.match(md, /^# SUPERSEO · Despacho de Prueba/);
  assert.match(md, /## Lo que hay que arreglar primero/);
  assert.match(md, /\| Crítico \| Páginas que responden con error \|/);
  assert.match(md, /## SEO Avengers 2500/);
  assert.match(md, /Search Console del cliente \| \d+/);
  assert.match(md, /## Qué pedirle al cliente para subir la potencia/);
  assert.match(md, /Ningún número de este reporte es una promesa/);
});

test("CLI: estado, estrategia y ciclo completo sobre un rastreo guardado", { skip: !hayPython && "sin python3" }, async () => {
  const cli = join(RAIZ, "superseo", "cli.mjs");
  const estado = spawnSync(process.execPath, [cli, "estado"], { cwd: RAIZ, encoding: "utf8" });
  assert.equal(estado.status, 0, estado.stderr);
  assert.match(estado.stdout, /^cano\s+PREPARACION\s+TOTAL\s+potencia\s+0\/100/m);

  const est = spawnSync(process.execPath, [cli, "estrategia", "cano"], { cwd: RAIZ, encoding: "utf8" });
  assert.equal(est.status, 0, est.stderr);
  const e = JSON.parse(est.stdout);
  assert.equal(e.cliente, "cano");
  assert.equal(e.exposicion.publica_paginas, false);

  const malo = spawnSync(process.execPath, [cli, "estrategia", "nadie"], { cwd: RAIZ, encoding: "utf8" });
  assert.equal(malo.status, 2);
  assert.match(malo.stderr, /CLIENTE_NO_EXISTE/);

  const { snap } = await snapshotFalso();
  const tmp = mkdtempSync(join(tmpdir(), "superseo-"));
  const archivo = join(tmp, "rastreo.json");
  writeFileSync(archivo, JSON.stringify({ ...snap, origen: "https://canopenal.com" }));
  const ciclo = spawnSync(process.execPath, [cli, "ciclo", "cano", "--snapshot", archivo, "--salida", tmp], { cwd: RAIZ, encoding: "utf8" });
  assert.equal(ciclo.status, 0, ciclo.stderr);
  for (const f of ["reporte.md", "estrategia.json", "auditoria.json", "avengers.json"]) assert.ok(existsSync(join(tmp, f)), f);
  assert.match(readFileSync(join(tmp, "reporte.md"), "utf8"), /# SUPERSEO · CANO \| Estrategia Penal/);
});

test("el perfil de Cano en el repo sigue intacto después de las pruebas", () => {
  const p = validarPerfil(perfilCano());
  assert.equal(p.estado, "PREPARACION");
  assert.equal(p.historial.length, 2);
});
