// Puente SUPERSEO → SEO Avengers 2500.
// Convierte un rastreo real en el contrato de evidencia de Avengers, ejecuta los
// módulos locales M1001–M2500 en su propio proceso Python y resume los recibos.
// Los Avengers siguen siendo OBSERVE_ONLY: aquí no se publica ni se modifica nada.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperSeoError, sha256, deepFreeze } from "../core/canonical.mjs";
import { configAvengers } from "../core/estratega.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SUITE_AVENGERS = join(RAIZ, "seo-avengers-2500");

function esIndexable(p) {
  return p.estado_http === 200 && /html/i.test(p.tipo ?? "") && !/noindex/i.test(p.robots ?? "") && typeof p.texto === "string" && p.texto.length > 0;
}

export function construirSolicitud(snapshot, perfil) {
  const documentos = snapshot.paginas.filter(esIndexable).map((p) => ({ document_id: p.ruta, text: p.texto }));
  const vistos = new Set();
  const unicos = documentos.filter((d) => (vistos.has(d.document_id) ? false : (vistos.add(d.document_id), true)));

  const negocio = [];
  const vistosNegocio = new Set();
  for (const p of snapshot.paginas) {
    for (const n of p.negocio ?? []) {
      if (!n.nombre) continue;
      const clave = `${n.nombre}|${n.direccion ?? ""}|${n.telefono ?? ""}`;
      if (vistosNegocio.has(clave)) continue;
      vistosNegocio.add(clave);
      negocio.push({ source_id: `site:${p.ruta}`, name: n.nombre, address: n.direccion ?? "", phone: n.telefono ?? "" });
    }
  }
  if (perfil.contacto.direccion || perfil.contacto.telefono) {
    negocio.push({ source_id: "superseo:perfil", name: perfil.nombre, address: perfil.contacto.direccion ?? "", phone: perfil.contacto.telefono ?? "" });
  }

  return {
    schema_version: 1,
    payload: {
      content_documents: unicos,
      local_business_records: negocio,
      search_performance_records: [],
      upstream_evidence: [],
    },
    config: configAvengers(perfil),
  };
}

const PUENTE_PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from sidecar.execute_suite import execute_request",
  "request = json.loads(sys.stdin.read())",
  "sys.stdout.write(json.dumps(execute_request(request), sort_keys=True, separators=(',', ':')))",
].join("\n");

export function ejecutarAvengers(solicitud, { python = process.env.SUPERSEO_PYTHON ?? "python3", suite = SUITE_AVENGERS, timeoutMs = 600_000 } = {}) {
  const r = spawnSync(python, ["-I", "-B", "-c", PUENTE_PY, suite], {
    input: JSON.stringify(solicitud),
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.error) throw new SuperSeoError("AVENGERS_NO_EJECUTO", r.error.message);
  if (r.status !== 0) throw new SuperSeoError("AVENGERS_FALLO", (r.stderr || "").trim().split("\n").slice(-3).join(" | "));
  let respuesta;
  try { respuesta = JSON.parse(r.stdout); } catch { throw new SuperSeoError("AVENGERS_RESPUESTA_INVALIDA"); }
  if (respuesta.receipt_count !== 1500 || respuesta.first_module !== "M1001" || respuesta.last_module !== "M2500") {
    throw new SuperSeoError("AVENGERS_RANGO_INCOMPLETO", `${respuesta.first_module}–${respuesta.last_module} (${respuesta.receipt_count})`);
  }
  return respuesta;
}

// Qué fuente desbloquea cada dato que los Avengers reportan como faltante.
const DESBLOQUEA = [
  [/^(search_performance_records|search_intent_records|conversion_search_records)_empty$|^no_eligible_search_demand$/, "Search Console del cliente"],
  [/^keyword_coverage_records_empty$/, "Demand Miner (Keyword Planner y competencia)"],
  [/^(traffic_window_records|traffic_series_records|content_decay_records)_empty$/, "Analítica propia con historial de tráfico"],
  [/^(revenue_funnel_records|revenue_attribution_records)_empty$/, "Analítica propia + cierres reportados por el cliente"],
  [/^semantic_text_records_empty$/, "Grafo de entidades (siguiente fase de SUPERSEO)"],
  [/^authority_scope_empty$/, "Link Graph (siguiente fase de SUPERSEO)"],
  [/^(canonicalization_records|edge_gateway_records|cwv_edge_records|persistence_state_records|policy_audit_records)_empty$/, "Puente técnico del sitio (siguiente fase de SUPERSEO)"],
  [/^local_business_records_empty$/, "Datos del negocio (perfil de Google o schema del sitio)"],
  [/^content_documents_empty$/, "Rastreo del sitio"],
];

export function fuenteQueDesbloquea(razon) {
  for (const [patron, fuente] of DESBLOQUEA) if (patron.test(razon)) return fuente;
  return "Evidencia adicional";
}

export function resumirRecibos(respuesta, solicitud) {
  const recibos = Object.values(respuesta.receipts);
  const porEstado = { SUCCESS: 0, INSUFFICIENT_DATA: 0, ERROR: 0 };
  const porFamilia = {};
  const hallazgos = [];
  const faltantes = new Map();
  for (const r of recibos) {
    porEstado[r.execution_status] = (porEstado[r.execution_status] ?? 0) + 1;
    const f = (porFamilia[r.family] ??= { modulos: 0, hallazgos: 0, sin_datos: 0, errores: 0 });
    f.modulos += 1;
    if (r.finding_status === "FINDING") {
      f.hallazgos += 1;
      hallazgos.push({ modulo: r.module, familia: r.family, operacion: r.operation, razon: r.reason_code });
    }
    if (r.execution_status === "INSUFFICIENT_DATA") {
      f.sin_datos += 1;
      faltantes.set(r.reason_code, (faltantes.get(r.reason_code) ?? 0) + 1);
    }
    if (r.execution_status === "ERROR") f.errores += 1;
  }
  const familias = Object.entries(porFamilia)
    .map(([familia, v]) => ({ familia, ...v }))
    .sort((a, b) => b.hallazgos - a.hallazgos || b.modulos - a.modulos || a.familia.localeCompare(b.familia));
  const cuerpo = {
    schema_version: 1,
    modulos: recibos.length,
    rango: `${respuesta.first_module}–${respuesta.last_module}`,
    execution_hash: respuesta.execution_hash,
    terminal_evidence_hash: respuesta.terminal_evidence_hash,
    terminal: respuesta.receipts.M2500 ? { estado: respuesta.receipts.M2500.execution_status, razon: respuesta.receipts.M2500.reason_code } : null,
    por_estado: porEstado,
    total_hallazgos: hallazgos.length,
    familias,
    hallazgos: hallazgos.sort((a, b) => a.modulo.localeCompare(b.modulo, "en", { numeric: true })),
    datos_faltantes: [...faltantes.entries()].map(([razon, modulos]) => ({ razon, modulos, desbloquea: fuenteQueDesbloquea(razon) })).sort((a, b) => b.modulos - a.modulos || a.razon.localeCompare(b.razon)),
    desbloqueos: Object.entries([...faltantes.entries()].reduce((acc, [razon, modulos]) => {
      const fuente = fuenteQueDesbloquea(razon);
      acc[fuente] = (acc[fuente] ?? 0) + modulos;
      return acc;
    }, {})).map(([fuente, modulos]) => ({ fuente, modulos })).sort((a, b) => b.modulos - a.modulos || a.fuente.localeCompare(b.fuente)),
    evidencia_entregada: {
      documentos: solicitud.payload.content_documents.length,
      registros_negocio: solicitud.payload.local_business_records.length,
      registros_search_console: solicitud.payload.search_performance_records.length,
    },
    solicitud_digest: sha256(solicitud),
  };
  return deepFreeze({ ...cuerpo, resumen_digest: sha256(cuerpo) });
}
