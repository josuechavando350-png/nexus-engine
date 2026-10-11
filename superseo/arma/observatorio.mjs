// Observatorio del delito: datos abiertos de carpetas de investigación de la Fiscalía
// General de Justicia de la CDMX, agregados por alcaldía, colonia, delito y mes.
// Cada cifra lleva su fuente y fecha de corte, y el agregado se verifica por
// consistencia antes de usarse. Las páginas Torre toman de aquí sus datos locales:
// eso es lo que las hace distintas entre sí y útiles, no un nombre de zona cambiado.
import { SuperSeoError, sha256, normalizarTexto, deepFreeze } from "../core/canonical.mjs";
import { ZONAS, nombreDeZona } from "../core/catalogo.mjs";

export const CKAN_CDMX = "https://datos.cdmx.gob.mx/api/3/action/package_show?id=carpetas-de-investigacion-fgj-de-la-ciudad-de-mexico";
export const FUENTE = "Carpetas de investigación de la FGJ CDMX, datos abiertos de la Ciudad de México";
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const CANDIDATAS = {
  alcaldia: ["alcaldia_hecho", "alcaldia_catalogo", "alcaldia", "alcaldia_hechos"],
  colonia: ["colonia_hecho", "colonia_catalogo", "colonia", "colonia_hechos"],
  delito: ["delito"],
  fecha: ["fecha_hecho", "fecha_hechos", "fecha_inicio"],
  anio: ["anio_hecho", "ao_hechos", "anio_hechos", "anio_inicio", "ao_inicio"],
  mes: ["mes_hecho", "mes_hechos", "mes_inicio"],
};

// --- CSV en streaming (comillas, comas y saltos de línea dentro de campos) ---
export class ParserCsv {
  constructor(alFila) {
    this.alFila = alFila;
    this.campo = "";
    this.fila = [];
    this.comillas = false;
    this.pendienteComilla = false;
  }

  empujar(texto) {
    for (let i = 0; i < texto.length; i += 1) {
      const c = texto[i];
      if (this.comillas) {
        if (this.pendienteComilla) {
          this.pendienteComilla = false;
          if (c === "\"") { this.campo += "\""; continue; }
          this.comillas = false;
        } else if (c === "\"") { this.pendienteComilla = true; continue; } else { this.campo += c; continue; }
      }
      if (c === "\"" && this.campo === "") { this.comillas = true; continue; }
      if (c === ",") { this.fila.push(this.campo); this.campo = ""; continue; }
      if (c === "\n") { this.fila.push(this.campo.replace(/\r$/, "")); this.alFila(this.fila); this.fila = []; this.campo = ""; continue; }
      this.campo += c;
    }
  }

  terminar() {
    if (this.pendienteComilla) { this.comillas = false; this.pendienteComilla = false; }
    if (this.campo !== "" || this.fila.length) { this.fila.push(this.campo.replace(/\r$/, "")); this.alFila(this.fila); }
    this.fila = []; this.campo = "";
  }
}

export function detectarColumnas(cabecera) {
  const norm = cabecera.map((c) => normalizarTexto(c).replace(/[\s-]+/g, "_"));
  const buscar = (lista) => { for (const n of lista) { const i = norm.indexOf(n); if (i >= 0) return i; } return -1; };
  const cols = Object.fromEntries(Object.entries(CANDIDATAS).map(([k, lista]) => [k, buscar(lista)]));
  const faltan = [];
  if (cols.alcaldia < 0) faltan.push("alcaldía");
  if (cols.delito < 0) faltan.push("delito");
  if (cols.fecha < 0 && (cols.anio < 0 || cols.mes < 0)) faltan.push("fecha o año+mes");
  if (faltan.length) throw new SuperSeoError("COLUMNAS_FALTANTES", `${faltan.join(", ")}. Cabecera: ${cabecera.slice(0, 30).join(", ")}`);
  return cols;
}

export function mesDe(fila, cols) {
  if (cols.fecha >= 0) {
    const f = (fila[cols.fecha] ?? "").trim();
    let m = f.match(/^(\d{4})-(\d{2})-\d{2}/);
    if (m) return `${m[1]}-${m[2]}`;
    m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}`;
  }
  if (cols.anio >= 0 && cols.mes >= 0) {
    const a = (fila[cols.anio] ?? "").trim();
    const rawMes = normalizarTexto(fila[cols.mes] ?? "");
    const num = /^\d{1,2}$/.test(rawMes) ? Number(rawMes) : MESES.indexOf(rawMes) + 1;
    if (/^\d{4}$/.test(a) && num >= 1 && num <= 12) return `${a}-${String(num).padStart(2, "0")}`;
  }
  return null;
}

const ALCALDIAS = Object.entries(ZONAS)
  .filter(([z]) => z.startsWith("cdmx-"))
  .map(([z, terminos]) => ({ zona: z, terminos }))
  .sort((a, b) => Math.max(...b.terminos.map((t) => t.length)) - Math.max(...a.terminos.map((t) => t.length)));

export function zonaDeAlcaldia(texto) {
  const t = normalizarTexto(texto).replace(/\./g, "");
  if (!t) return null;
  for (const { zona, terminos } of ALCALDIAS) if (terminos.some((term) => term.length > 3 && t.includes(term))) return zona;
  return null;
}

function bonito(texto) {
  const t = String(texto ?? "").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export class Agregador {
  constructor() {
    this.cols = null;
    this.filas = 0;
    this.descartadas = 0;
    this.fueraDeCatalogo = 0;
    this.porZonaMes = new Map();
    this.porZonaMesDelito = new Map();
    this.porZonaMesColonia = new Map();
    this.porMes = new Map();
  }

  fila(campos) {
    if (!this.cols) { this.cols = detectarColumnas(campos); return; }
    this.filas += 1;
    const mes = mesDe(campos, this.cols);
    if (!mes) { this.descartadas += 1; return; }
    this.porMes.set(mes, (this.porMes.get(mes) ?? 0) + 1);
    const zona = zonaDeAlcaldia(campos[this.cols.alcaldia]);
    if (!zona) { this.fueraDeCatalogo += 1; return; }
    const k = `${zona}|${mes}`;
    this.porZonaMes.set(k, (this.porZonaMes.get(k) ?? 0) + 1);
    const delito = bonito(campos[this.cols.delito]) || "Sin dato";
    const kd = `${k}|${delito}`;
    this.porZonaMesDelito.set(kd, (this.porZonaMesDelito.get(kd) ?? 0) + 1);
    if (this.cols.colonia >= 0) {
      const colonia = String(campos[this.cols.colonia] ?? "").trim().toUpperCase();
      if (colonia) {
        const kc = `${k}|${colonia}`;
        this.porZonaMesColonia.set(kc, (this.porZonaMesColonia.get(kc) ?? 0) + 1);
      }
    }
  }
}

function sumarMes(mes, n) {
  const [a, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function rangoMeses(fin, n) {
  return Array.from({ length: n }, (_, i) => sumarMes(fin, i - n + 1));
}

export function nombreMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  return `${MESES[m - 1]} de ${a}`;
}

function top(mapa, prefijos, n) {
  const acumulado = new Map();
  for (const [k, v] of mapa) {
    const partes = k.split("|");
    if (!prefijos.has(`${partes[0]}|${partes[1]}`)) continue;
    acumulado.set(partes[2], (acumulado.get(partes[2]) ?? 0) + v);
  }
  return [...acumulado.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([nombre, carpetas]) => ({ nombre, carpetas }));
}

export function resultadoObservatorio(ag, { recurso = null, corteForzado = null } = {}) {
  const meses = [...ag.porMes.keys()].sort();
  if (!meses.length) throw new SuperSeoError("OBSERVATORIO_SIN_DATOS");
  // El último mes del archivo suele estar incompleto: el corte es el mes anterior.
  const corte = corteForzado ?? sumarMes(meses.at(-1), -1);
  const ventana = rangoMeses(corte, 12);
  const previa = rangoMeses(sumarMes(corte, -12), 12);
  const serie24 = rangoMeses(corte, 24);
  const zonas = [...new Set([...ag.porZonaMes.keys()].map((k) => k.split("|")[0]))].sort();
  const totalCiudad12 = ventana.reduce((s, m) => s + zonas.reduce((t, z) => t + (ag.porZonaMes.get(`${z}|${m}`) ?? 0), 0), 0);

  const porZona = {};
  for (const z of zonas) {
    const v = new Set(ventana.map((m) => `${z}|${m}`));
    const total12 = ventana.reduce((s, m) => s + (ag.porZonaMes.get(`${z}|${m}`) ?? 0), 0);
    const totalPrevio = previa.reduce((s, m) => s + (ag.porZonaMes.get(`${z}|${m}`) ?? 0), 0);
    porZona[z] = {
      zona: z,
      nombre: nombreDeZona(z),
      total_12_meses: total12,
      total_12_meses_previos: totalPrevio,
      cambio_pct: totalPrevio > 0 ? Math.round(((total12 - totalPrevio) / totalPrevio) * 1000) / 10 : null,
      participacion_pct: totalCiudad12 > 0 ? Math.round((total12 / totalCiudad12) * 1000) / 10 : null,
      top_delitos: top(ag.porZonaMesDelito, v, 5),
      top_colonias: top(ag.porZonaMesColonia, v, 5),
      serie: serie24.map((m) => ({ mes: m, carpetas: ag.porZonaMes.get(`${z}|${m}`) ?? 0 })),
    };
  }

  const comprobaciones = [];
  const comprobar = (nombre, ok, detalle) => comprobaciones.push({ nombre, ok, detalle });
  const sumaZonas = Object.values(porZona).reduce((s, z) => s + z.total_12_meses, 0);
  comprobar("Suma de alcaldías = total de la ciudad", sumaZonas === totalCiudad12, `${sumaZonas} vs ${totalCiudad12}`);
  for (const z of Object.values(porZona)) {
    const desdeSerie = z.serie.slice(-12).reduce((s, x) => s + x.carpetas, 0);
    if (desdeSerie !== z.total_12_meses) comprobar(`Serie de ${z.nombre}`, false, `${desdeSerie} vs ${z.total_12_meses}`);
    if (z.top_delitos.some((d) => d.carpetas > z.total_12_meses)) comprobar(`Delitos de ${z.nombre}`, false, "un delito supera el total");
  }
  const totalFilas = [...ag.porMes.values()].reduce((s, v) => s + v, 0) + ag.descartadas;
  comprobar("Filas contadas = filas leídas", totalFilas === ag.filas, `${totalFilas} vs ${ag.filas}`);
  const ok = comprobaciones.every((c) => c.ok);
  const cuerpo = {
    schema_version: 1,
    fuente: FUENTE,
    recurso,
    corte,
    ventana: { desde: ventana[0], hasta: corte },
    filas_leidas: ag.filas,
    filas_sin_fecha: ag.descartadas,
    filas_fuera_de_catalogo: ag.fueraDeCatalogo,
    total_ciudad_12_meses: totalCiudad12,
    ranking: Object.values(porZona).sort((a, b) => b.total_12_meses - a.total_12_meses || a.zona.localeCompare(b.zona)).map((z) => ({ zona: z.zona, nombre: z.nombre, total_12_meses: z.total_12_meses })),
    zonas: porZona,
    verificacion: { ok, comprobaciones },
  };
  return deepFreeze({ ...cuerpo, observatorio_digest: sha256(cuerpo) });
}

export function procesarTextoCsv(texto, opciones = {}) {
  const ag = new Agregador();
  const p = new ParserCsv((f) => ag.fila(f));
  p.empujar(String(texto).replace(/^\uFEFF/, ""));
  p.terminar();
  return resultadoObservatorio(ag, opciones);
}

export async function resolverRecurso({ fetchImpl = globalThis.fetch, url = CKAN_CDMX } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new SuperSeoError("CKAN_FALLO", `HTTP ${res.status}`);
  const data = await res.json();
  const recursos = (data?.result?.resources ?? []).filter((r) => /csv/i.test(r.format ?? "") || /\.csv(\?|$)/i.test(r.url ?? ""));
  if (!recursos.length) throw new SuperSeoError("CKAN_SIN_CSV");
  recursos.sort((a, b) => String(b.last_modified ?? b.created ?? "").localeCompare(String(a.last_modified ?? a.created ?? "")) || (Number(b.size) || 0) - (Number(a.size) || 0));
  const r = recursos[0];
  return { nombre: r.name ?? null, url: r.url, actualizado: r.last_modified ?? r.created ?? null };
}

export async function descargarYProcesar({ url, fetchImpl = globalThis.fetch, recurso = null, timeoutMs = 1_800_000 } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new SuperSeoError("DESCARGA_FALLO", `HTTP ${res.status}`);
  const ag = new Agregador();
  const p = new ParserCsv((f) => ag.fila(f));
  const decoder = new TextDecoder("utf-8");
  let primero = true;
  for await (const chunk of res.body) {
    let t = decoder.decode(chunk, { stream: true });
    if (primero) { t = t.replace(/^\uFEFF/, ""); primero = false; }
    p.empujar(t);
  }
  p.empujar(decoder.decode());
  p.terminar();
  return resultadoObservatorio(ag, { recurso: recurso ?? { url } });
}

function miles(n) {
  return n.toLocaleString("en-US");
}

// Hechos verificados para la página Torre de una alcaldía. Redacción neutral:
// los datos informan, no estigmatizan.
export function datosLocalesDe(observatorio, zona) {
  const z = observatorio?.zonas?.[zona];
  if (!z || !observatorio.verificacion?.ok) return [];
  const fuente = `${observatorio.fuente}; corte ${nombreMes(observatorio.corte)}`;
  const periodo = `entre ${nombreMes(observatorio.ventana.desde)} y ${nombreMes(observatorio.ventana.hasta)}`;
  const datos = [{ dato: `${periodo.charAt(0).toUpperCase()}${periodo.slice(1)}, la Fiscalía General de Justicia de la Ciudad de México abrió ${miles(z.total_12_meses)} carpetas de investigación por hechos ocurridos en ${z.nombre}.`, fuente }];
  if (z.top_delitos.length >= 3) {
    const [a, b, c] = z.top_delitos;
    datos.push({ dato: `Los delitos con más carpetas en ${z.nombre} en ese periodo fueron ${a.nombre.toLowerCase()} (${miles(a.carpetas)}), ${b.nombre.toLowerCase()} (${miles(b.carpetas)}) y ${c.nombre.toLowerCase()} (${miles(c.carpetas)}).`, fuente });
  }
  if (z.top_colonias.length >= 3) {
    const titulo = (t) => t.toLowerCase().split(" ").filter(Boolean).map((w) => (["de", "del", "la", "las", "los", "y"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
    const cols = z.top_colonias.slice(0, 3).map((c) => titulo(c.nombre));
    datos.push({ dato: `Las colonias de ${z.nombre} con más carpetas registradas fueron ${cols[0]}, ${cols[1]} y ${cols[2]}.`, fuente });
  }
  if (z.cambio_pct !== null) {
    const verbo = z.cambio_pct > 0 ? "aumentaron" : z.cambio_pct < 0 ? "disminuyeron" : "se mantuvieron";
    datos.push({ dato: z.cambio_pct === 0 ? `Frente a los 12 meses anteriores, las carpetas en ${z.nombre} se mantuvieron sin cambio.` : `Frente a los 12 meses anteriores, las carpetas en ${z.nombre} ${verbo} ${Math.abs(z.cambio_pct)}%.`, fuente });
  }
  if (z.participacion_pct !== null) datos.push({ dato: `${z.nombre} concentró el ${z.participacion_pct}% de las carpetas de la ciudad en ese periodo.`, fuente });
  return datos;
}
