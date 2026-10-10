// Demand Miner: propone las páginas que responden búsquedas reales.
// Cruza situaciones, servicios y zonas del cliente; marca lo que el sitio ya cubre;
// usa volúmenes reales (Keyword Planner) y Search Console cuando existen. Sin ellos,
// el valor es una estimación heurística y así queda etiquetado.
import { sha256, normalizarTexto, deepFreeze } from "../core/canonical.mjs";
import { RUBROS, nombreDeZona, subzonas } from "../core/catalogo.mjs";
import { SITUACIONES, PESO_INTENCION } from "../core/situaciones.mjs";

const SEGMENTO = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const ESFUERZO = { TORRE_ZONA: 3, GUIA_SITUACION: 2, SERVICIO_SITUACION: 2 };
const ESPECIFICIDAD = { TORRE_ZONA: 1, GUIA_SITUACION: 1.2, SERVICIO_SITUACION: 0.8 };

// Patrones para saber si el sitio ya tiene una página de esa situación.
const PATRONES_EXISTENTES = {
  detencion: /detenid|detencion/,
  citatorio: /citatorio/,
  "orden-aprehension": /orden-?aprehension/,
  "audiencia-inicial": /audiencia-?inicial/,
  "carpeta-investigacion": /carpeta-?investigacion/,
  "acusacion-falsa": /acusacion-?falsa|denuncia-?falsa/,
  denuncia: /denuncia|victima/,
  costo: /honorario|costo|precio|cuanto-cuesta/,
  precio: /precio|costo|cuanto/,
};

function slugDeZona(zona) {
  return zona.replace(/^[a-z]+-/, "");
}

function recortar(slug) {
  if (slug.length <= 80) return slug;
  return slug.slice(0, 80).replace(/-+[^-]*$/, "");
}

function sustituir(plantilla, { zona, servicio }) {
  return normalizarTexto(plantilla.replace("{zona}", zona ?? "").replace("{servicio}", servicio ?? ""));
}

function mapaNormalizado(registros, campoConsulta, campoValor) {
  const m = new Map();
  for (const r of registros ?? []) {
    const k = normalizarTexto(r[campoConsulta]);
    const v = Number(r[campoValor]);
    if (k && Number.isFinite(v) && v >= 0) m.set(k, (m.get(k) ?? 0) + v);
  }
  return m;
}

export function rutasExistentes({ snapshot = null, perfil }) {
  const rutas = new Set(perfil.servicios.map((s) => s.ruta));
  for (const p of snapshot?.paginas ?? []) {
    if (p.estado_http === 200) rutas.add(p.ruta);
  }
  return [...rutas].sort();
}

/**
 * @param perfil perfil validado
 * @param opciones.snapshot rastreo del sitio (para saber qué existe)
 * @param opciones.volumenes [{ consulta, volumen_mensual }] exportado de Keyword Planner
 * @param opciones.searchConsole [{ query, impressions }] filas de Search Console
 */
export function minarDemanda(perfil, { snapshot = null, volumenes = [], searchConsole = [] } = {}) {
  const rubro = RUBROS[perfil.rubro];
  const situaciones = SITUACIONES[perfil.rubro];
  const torre = rubro.torre ?? { slug: perfil.rubro.replace(/_/g, "-"), titulo: `${rubro.nombre} en {zona}` };
  const existentes = rutasExistentes({ snapshot, perfil });
  const existentesNorm = existentes.map((r) => r.toLowerCase());
  const vol = mapaNormalizado(volumenes, "consulta", "volumen_mensual");
  const gsc = mapaNormalizado(searchConsole, "query", "impressions");
  const zonaPrincipal = perfil.territorio.zonas[0];
  const nombrePrincipal = nombreDeZona(zonaPrincipal);
  const alcaldias = [...new Set(perfil.territorio.zonas.flatMap(subzonas))];
  const servicioPorSlug = new Map(perfil.servicios.map((s) => [s.slug, s]));
  // Servicios que son un tipo de delito (no víctimas ni recursos): con ellos se cruzan las situaciones genéricas.
  const serviciosDelito = perfil.servicios.filter((s) => s.ruta.startsWith("/areas/") && !/victima|amparo|recurso|adolescente/.test(s.ruta));

  const candidatos = [];
  const agregar = (c) => {
    const ruta = `/${recortar(c.slug)}`;
    if (!SEGMENTO.test(ruta.slice(1))) return;
    const consultas = [...new Set(c.consultas.filter(Boolean))];
    const volumen = consultas.reduce((s, q) => s + (vol.get(q) ?? 0), 0);
    const impresiones = consultas.reduce((s, q) => s + (gsc.get(q) ?? 0), 0);
    const peso = PESO_INTENCION[c.intencion] ?? 4;
    // En los cruces, el orden en que el cliente presenta sus servicios desempata: primero su fuerte.
    const orden = c.servicio ? perfil.servicios.findIndex((s) => s.slug === c.servicio) : -1;
    const ajuste = orden >= 0 ? 1 + 0.1 * (1 - orden / perfil.servicios.length) : 1;
    const estimado = Math.round(peso * ESPECIFICIDAD[c.tipo] * ajuste * 100) / 10;
    const valor = volumen > 0 ? Math.round(volumen * (peso / 10) + impresiones / 10) : Math.round((estimado + impresiones / 10) * 10) / 10;
    const patron = PATRONES_EXISTENTES[c.situacion];
    const cubiertaPor = existentes.includes(ruta)
      ? ruta
      : (c.tipo === "GUIA_SITUACION" && patron ? existentes[existentesNorm.findIndex((r) => patron.test(r) && !alcaldias.some((a) => r.includes(slugDeZona(a))))] ?? null : null);
    candidatos.push({
      id: ruta.slice(1),
      tipo: c.tipo,
      ruta,
      titulo: c.titulo,
      situacion: c.situacion ?? null,
      servicio: c.servicio ?? null,
      zona: c.zona,
      intencion: c.intencion,
      consultas,
      volumen: volumen > 0 ? volumen : null,
      impresiones_search_console: impresiones > 0 ? impresiones : null,
      fuente_valor: volumen > 0 ? "VOLUMEN_REAL" : "ESTIMADO",
      valor,
      esfuerzo: ESFUERZO[c.tipo],
      requiere_datos_locales: c.tipo === "TORRE_ZONA",
      cobertura: cubiertaPor ? "EXISTE" : "NUEVA",
      cubierta_por: cubiertaPor,
    });
  };

  // 1. Torres por zona: una por alcaldía, con datos locales propios.
  const urgentes = situaciones.filter((s) => s.intencion === "URGENTE");
  for (const zona of alcaldias) {
    const nombre = nombreDeZona(zona);
    agregar({
      tipo: "TORRE_ZONA",
      slug: `${torre.slug}-${slugDeZona(zona)}`,
      titulo: torre.titulo.replace("{zona}", nombre),
      zona,
      situacion: null,
      intencion: "URGENTE",
      consultas: [
        sustituir(torre.titulo.toLowerCase(), { zona: nombre }),
        ...urgentes.flatMap((s) => s.consultas.filter((q) => q.includes("{zona}")).map((q) => sustituir(q, { zona: nombre, servicio: perfil.servicios[0]?.nombre }))),
      ],
    });
  }

  // 2. Guías por situación en la zona principal.
  for (const s of situaciones) {
    agregar({
      tipo: "GUIA_SITUACION",
      slug: `${s.slug}-${slugDeZona(zonaPrincipal)}`,
      titulo: s.titulo ? s.titulo.replace("{zona}", nombrePrincipal) : `${s.nombre} en ${nombrePrincipal}: qué hacer`,
      zona: zonaPrincipal,
      situacion: s.slug,
      intencion: s.intencion,
      consultas: s.consultas.map((q) => sustituir(q, { zona: nombrePrincipal, servicio: perfil.servicios[0]?.nombre })),
    });
  }

  // 3. Situación × servicio: solo cruces con sentido, nunca todos contra todos.
  for (const s of situaciones) {
    const servicios = s.servicios.includes("*")
      ? (s.cruce ? serviciosDelito : [])
      : s.servicios.map((slug) => servicioPorSlug.get(slug)).filter(Boolean);
    for (const serv of servicios) {
      if (s.servicios.includes(serv.slug) && !s.servicios.includes("*")) continue; // ya lo cubre la guía de la situación
      agregar({
        tipo: "SERVICIO_SITUACION",
        slug: `${s.slug}-${serv.slug}`,
        titulo: s.cruce ? `${s.cruce.replace("{servicio}", serv.nombre.toLowerCase())}: qué hacer` : `${s.nombre}: ${serv.nombre}`,
        zona: zonaPrincipal,
        situacion: s.slug,
        servicio: serv.slug,
        intencion: s.intencion,
        consultas: [normalizarTexto(s.cruce ? s.cruce.replace("{servicio}", serv.nombre) : `${s.nombre} ${serv.nombre}`), ...s.consultas.map((q) => sustituir(q, { zona: nombrePrincipal, servicio: serv.nombre }))],
      });
    }
  }

  const vistos = new Set();
  const unicos = candidatos.filter((c) => (vistos.has(c.id) ? false : (vistos.add(c.id), true)));
  unicos.sort((a, b) => (b.valor / b.esfuerzo) - (a.valor / a.esfuerzo) || a.id.localeCompare(b.id));
  const cuerpo = {
    schema_version: 1,
    cliente: perfil.id,
    fuente: vol.size ? "VOLUMEN_REAL_Y_ESTIMADO" : "ESTIMADO",
    nota: vol.size
      ? "Los candidatos con volumen usan Keyword Planner; los demás son estimaciones heurísticas."
      : "Sin volúmenes de Keyword Planner: el valor es una estimación heurística por intención y especificidad, no un volumen real.",
    rutas_existentes: existentes,
    total: unicos.length,
    nuevos: unicos.filter((c) => c.cobertura === "NUEVA").length,
    candidatos: unicos,
  };
  return deepFreeze({ ...cuerpo, demanda_digest: sha256(cuerpo) });
}

// Lee un CSV exportado de Keyword Planner (columnas "Keyword" y "Avg. monthly searches"
// o sus equivalentes en español). Devuelve [{ consulta, volumen_mensual }].
export function leerKeywordPlanner(texto) {
  const lineas = String(texto).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  // La fila de encabezados es la que nombra la palabra clave Y las búsquedas mensuales
  // (el export de Keyword Planner trae antes un par de líneas de título).
  const esCabecera = (l) => /keyword|palabra clave/i.test(l) && /searches|b[uú]squedas/i.test(l);
  const sep = (lineas.find(esCabecera) ?? "").includes("\t") ? "\t" : ",";
  const idxCab = lineas.findIndex(esCabecera);
  if (idxCab < 0) return [];
  const partir = (l) => {
    const out = [];
    let actual = "";
    let comillas = false;
    for (const ch of l) {
      if (ch === "\"") comillas = !comillas;
      else if (ch === sep && !comillas) { out.push(actual); actual = ""; }
      else actual += ch;
    }
    out.push(actual);
    return out.map((x) => x.trim());
  };
  const cab = partir(lineas.at(idxCab)).map((c) => normalizarTexto(c));
  const iK = cab.findIndex((c) => c === "keyword" || c.startsWith("palabra clave"));
  const iV = cab.findIndex((c) => c.includes("avg monthly searches") || c.includes("promedio de busquedas mensuales") || c.includes("busquedas mensuales"));
  if (iK < 0 || iV < 0) return [];
  return lineas.slice(idxCab + 1).map(partir).map((cols) => {
    const raw = (cols.at(iV) ?? "").replace(/[^\d\s–-]/g, "").trim();
    const rango = raw.split(/\s*[–-]\s*/).map(Number).filter(Number.isFinite);
    const volumen = rango.length === 2 ? Math.round((rango[0] + rango[1]) / 2) : rango[0];
    return { consulta: cols.at(iK) ?? "", volumen_mensual: Number.isFinite(volumen) ? volumen : NaN };
  }).filter((r) => r.consulta && Number.isFinite(r.volumen_mensual));
}
