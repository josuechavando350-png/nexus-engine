// Oráculo de tendencias: lee fuentes públicas (RSS/Atom) y detecta temas nuevos del
// rubro antes de que la competencia escriba de ellos. Cada tema trae su fuente y una
// idea de página o noticia; publicar sigue pasando por la Forja y sus candados.
import { sha256, normalizarTexto, deepFreeze } from "../core/canonical.mjs";
import { decodificar, textoPlano } from "../ojos/crawler.mjs";

function etiqueta(bloque, nombre) {
  const m = bloque.match(new RegExp(`<${nombre}\\b[^>]*>([\\s\\S]*?)</${nombre}>`, "i"));
  if (!m) return null;
  const sinCdata = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return textoPlano(decodificar(sinCdata));
}

export function leerFeed(xml, fuente = "") {
  const items = [];
  const bloques = [...String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  for (const b of bloques) {
    const titulo = etiqueta(b, "title");
    let enlace = etiqueta(b, "link");
    if (!enlace) enlace = b.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] ?? null;
    const fechaRaw = etiqueta(b, "pubDate") ?? etiqueta(b, "updated") ?? etiqueta(b, "published");
    const fecha = fechaRaw && !Number.isNaN(Date.parse(fechaRaw)) ? new Date(fechaRaw).toISOString() : null;
    const resumen = etiqueta(b, "description") ?? etiqueta(b, "summary") ?? "";
    if (titulo && enlace) items.push({ titulo, enlace, fecha, resumen: resumen.slice(0, 400), fuente });
  }
  return items;
}

// terminos: [{ termino, peso }] del rubro y del cliente.
export function detectarTemas(items, { terminos, vistos = [], ahora = new Date(), diasMax = 14, minimo = 2 } = {}) {
  const yaVistos = new Set(vistos);
  const limite = ahora.getTime() - diasMax * 86_400_000;
  const normales = terminos.map((t) => ({ ...t, n: normalizarTexto(t.termino) })).filter((t) => t.n.length > 2);
  const temas = [];
  const huellas = new Set();
  for (const it of items) {
    if (it.fecha && Date.parse(it.fecha) < limite) continue;
    const huella = sha256(normalizarTexto(it.titulo)).slice(7, 23);
    if (yaVistos.has(huella) || huellas.has(huella)) continue;
    const texto = normalizarTexto(`${it.titulo} ${it.resumen}`);
    const coincidencias = normales.filter((t) => new RegExp(`(^| )${t.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(texto));
    const puntaje = coincidencias.reduce((s, t) => s + t.peso, 0);
    if (puntaje < minimo) continue;
    huellas.add(huella);
    temas.push({
      huella,
      titulo: it.titulo,
      enlace: it.enlace,
      fecha: it.fecha,
      fuente: it.fuente,
      puntaje,
      coincide_con: coincidencias.map((t) => t.termino),
      idea: `Explicar qué significa para quien vive una situación así: "${it.titulo}" (verificar con la fuente antes de escribir).`,
    });
  }
  temas.sort((a, b) => b.puntaje - a.puntaje || (b.fecha ?? "").localeCompare(a.fecha ?? ""));
  return deepFreeze({ total: temas.length, temas, vistos: [...yaVistos, ...temas.map((t) => t.huella)].slice(-2000) });
}

export async function leerFuentes(fuentes, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const items = [];
  const errores = [];
  for (const f of fuentes) {
    try {
      const res = await fetchImpl(f.url, { headers: { "user-agent": "NexusSuperSEO/1.0 (+https://nexusbotstudio.com)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { errores.push({ fuente: f.nombre, error: `HTTP ${res.status}` }); continue; }
      items.push(...leerFeed(await res.text(), f.nombre));
    } catch (e) {
      errores.push({ fuente: f.nombre, error: String(e.message ?? e) });
    }
  }
  return { items, errores };
}
