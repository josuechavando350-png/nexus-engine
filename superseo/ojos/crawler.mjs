// NEXUS Crawler: rastreo propio, acotado y respetuoso.
// Lee robots.txt y sitemaps, sigue enlaces internos, registra redirecciones sin
// seguirlas a ciegas y extrae lo que Google lee de cada página. No usa librerías
// externas ni scrapea Google: solo visita el sitio que se le indica.
import { SuperSeoError } from "../core/canonical.mjs";

export const USER_AGENT = "NexusSuperSEO/1.0 (+https://nexusbotstudio.com)";
const MAX_HTML = 3_000_000;
const MAX_TEXTO = 40_000;

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ntilde: "ñ", Ntilde: "Ñ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", uuml: "ü", iquest: "¿", iexcl: "¡", middot: "·", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©", reg: "®" };

export function decodificar(texto) {
  return String(texto).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTIDADES[e] ?? m;
  });
}

function atributos(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  const cuerpo = tag.replace(/^<\/?[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(cuerpo))) {
    const nombre = m[1].toLowerCase();
    let valor = m[2] ?? "";
    if ((valor.startsWith("\"") && valor.endsWith("\"")) || (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    if (!(nombre in out)) out[nombre] = decodificar(valor);
  }
  return out;
}

function etiquetas(html, nombre) {
  return [...html.matchAll(new RegExp(`<${nombre}\\b[^>]*>`, "gi"))].map((m) => atributos(m[0]));
}

function contenidoDe(html, nombre) {
  return [...html.matchAll(new RegExp(`<${nombre}\\b[^>]*>([\\s\\S]*?)</${nombre}>`, "gi"))].map((m) => m[1]);
}

export function textoPlano(fragmento) {
  return decodificar(
    String(fragmento)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|tr|td|th|ul|ol|nav|main|aside|blockquote|figcaption|summary|details)>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

export function mismoSitio(a, b) {
  const ha = new URL(a).hostname.replace(/^www\./, "");
  const hb = new URL(b).hostname.replace(/^www\./, "");
  return ha === hb;
}

export function normalizarUrl(href, base) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(h)) return null;
  let u;
  try { u = new URL(h, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.toString();
}

function jsonLd(html) {
  const bloques = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  const nodos = [];
  let invalidos = 0;
  for (const b of bloques) {
    try {
      const data = JSON.parse(b[1].trim());
      const pila = Array.isArray(data) ? [...data] : [data];
      while (pila.length) {
        const n = pila.shift();
        if (!n || typeof n !== "object") continue;
        if (Array.isArray(n["@graph"])) pila.push(...n["@graph"]);
        nodos.push(n);
      }
    } catch {
      invalidos += 1;
    }
  }
  return { nodos, invalidos };
}

const TIPOS_NEGOCIO = /^(LocalBusiness|LegalService|Attorney|Organization|ProfessionalService|Dentist|MedicalBusiness|MedicalClinic|Physician|Restaurant|RealEstateAgent|HomeAndConstructionBusiness|GeneralContractor|Store|FoodEstablishment)$/;

function tiposDe(nodo) {
  const t = nodo["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === "string");
}

function direccionTexto(addr) {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  if (typeof addr === "object") {
    return ["streetAddress", "addressLocality", "addressRegion", "postalCode"].map((k) => addr[k]).filter(Boolean).join(", ") || null;
  }
  return null;
}

export function soloDigitos(tel) {
  const d = String(tel ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export function extraerPagina(html, url) {
  const head = contenidoDe(html, "head").join(" ");
  const bodyMatch = contenidoDe(html, "body");
  const body = bodyMatch.length ? bodyMatch.join(" ") : html;
  const base = etiquetas(head || html, "base").find((b) => b.href)?.href;
  const baseUrl = base ? (normalizarUrl(base, url) ?? url) : url;

  const metas = etiquetas(html, "meta");
  const meta = (nombre) => metas.find((m) => (m.name ?? "").toLowerCase() === nombre)?.content?.trim() ?? null;
  const canonical = etiquetas(html, "link").find((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href ?? null;

  const anclas = [...body.matchAll(/<a\b[^>]*>/gi)].map((m) => atributos(m[0]));
  const internos = new Set();
  let externos = 0;
  const telefonos = new Set();
  for (const a of anclas) {
    if (/^tel:/i.test(a.href ?? "")) {
      const d = soloDigitos(a.href);
      if (d) telefonos.add(d);
      continue;
    }
    const n = normalizarUrl(a.href, baseUrl);
    if (!n) continue;
    if (mismoSitio(n, url)) internos.add(n); else externos += 1;
  }

  const ld = jsonLd(html);
  const negocio = [];
  for (const n of ld.nodos) {
    if (tiposDe(n).some((t) => TIPOS_NEGOCIO.test(t))) {
      negocio.push({ nombre: typeof n.name === "string" ? n.name : null, direccion: direccionTexto(n.address), telefono: typeof n.telephone === "string" ? n.telephone : null });
      const d = soloDigitos(n.telephone);
      if (d) telefonos.add(d);
    }
  }

  const texto = textoPlano(body);
  const htmlTag = etiquetas(html, "html").at(0) ?? {};
  return {
    titulo: (() => { const t = contenidoDe(head || html, "title").at(0); return t === undefined ? null : textoPlano(t) || null; })(),
    descripcion: meta("description"),
    robots: meta("robots"),
    canonical: canonical ? normalizarUrl(canonical, baseUrl) : null,
    idioma: htmlTag.lang ?? null,
    h1: contenidoDe(body, "h1").map(textoPlano).filter(Boolean),
    h2: contenidoDe(body, "h2").map(textoPlano).filter(Boolean).slice(0, 40),
    palabras: texto ? texto.split(" ").length : 0,
    texto: texto.slice(0, MAX_TEXTO),
    enlaces_internos: [...internos].sort(),
    enlaces_externos: externos,
    jsonld_tipos: [...new Set(ld.nodos.flatMap(tiposDe))].sort(),
    jsonld_invalidos: ld.invalidos,
    negocio,
    telefonos: [...telefonos].sort(),
  };
}

export function leerSitemap(xml) {
  const locs = [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodificar(m[1]));
  const esIndice = /<sitemapindex\b/i.test(xml);
  return { esIndice, urls: locs };
}

export function parsearRobots(txt) {
  const grupos = [];
  let actual = null;
  const sitemaps = [];
  for (const linea of String(txt).split(/\r?\n/)) {
    const l = linea.replace(/#.*/, "").trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const campo = m[1].toLowerCase();
    const valor = m[2].trim();
    if (campo === "sitemap") { if (valor) sitemaps.push(valor); continue; }
    if (campo === "user-agent") {
      if (!actual || actual.reglas.length) { actual = { agentes: [], reglas: [] }; grupos.push(actual); }
      actual.agentes.push(valor.toLowerCase());
    } else if ((campo === "disallow" || campo === "allow") && actual) {
      actual.reglas.push({ tipo: campo, ruta: valor });
    }
  }
  const nuestro = grupos.find((g) => g.agentes.some((a) => a.length > 2 && a !== "*" && "nexussuperseo".includes(a)));
  const general = grupos.find((g) => g.agentes.includes("*"));
  const reglas = (nuestro ?? general)?.reglas ?? [];
  return {
    sitemaps,
    reglas,
    permitido(ruta) {
      let mejor = null;
      for (const r of reglas) {
        if (!r.ruta) continue;
        const patron = new RegExp(`^${r.ruta.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
        if (patron.test(ruta) && (!mejor || r.ruta.length > mejor.ruta.length || (r.ruta.length === mejor.ruta.length && r.tipo === "allow"))) mejor = r;
      }
      return !mejor || mejor.tipo === "allow";
    },
  };
}

async function pedir(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tipo = res.headers.get("content-type") ?? "";
  const ubicacion = res.headers.get("location");
  let cuerpo = null;
  if (res.status >= 200 && res.status < 300 && /html|xml|text\/plain/i.test(tipo)) {
    cuerpo = await res.text();
    if (cuerpo.length > MAX_HTML) cuerpo = cuerpo.slice(0, MAX_HTML);
  }
  return { estado: res.status, tipo, ubicacion, cuerpo };
}

export async function rastrear({ inicio, maxPaginas = 300, fetchImpl = globalThis.fetch, timeoutMs = 15_000, concurrencia = 4, reloj = () => new Date() } = {}) {
  let origen;
  try { origen = new URL(inicio).origin; } catch { throw new SuperSeoError("INICIO_INVALIDO", String(inicio)); }
  if (typeof fetchImpl !== "function") throw new SuperSeoError("SIN_FETCH");
  const iniciado = reloj().toISOString();
  const errores = [];

  let robots = parsearRobots("");
  let robotsEstado = null;
  try {
    const r = await pedir(fetchImpl, `${origen}/robots.txt`, timeoutMs);
    robotsEstado = r.estado;
    if (r.cuerpo) robots = parsearRobots(r.cuerpo);
  } catch (e) {
    errores.push({ url: `${origen}/robots.txt`, error: String(e.message ?? e) });
  }

  const sitemapUrls = new Set();
  const pendientesSitemap = robots.sitemaps.length ? [...robots.sitemaps] : [`${origen}/sitemap.xml`];
  const vistosSitemap = new Set();
  while (pendientesSitemap.length && vistosSitemap.size < 20) {
    const s = pendientesSitemap.shift();
    if (vistosSitemap.has(s)) continue;
    vistosSitemap.add(s);
    try {
      const r = await pedir(fetchImpl, s, timeoutMs);
      if (!r.cuerpo) { errores.push({ url: s, error: `sitemap HTTP ${r.estado}` }); continue; }
      const { esIndice, urls } = leerSitemap(r.cuerpo);
      for (const u of urls) {
        const n = normalizarUrl(u, origen);
        if (!n) continue;
        if (esIndice) pendientesSitemap.push(n);
        else if (mismoSitio(n, origen)) sitemapUrls.add(n);
      }
    } catch (e) {
      errores.push({ url: s, error: String(e.message ?? e) });
    }
  }

  const cola = [`${origen}/`, ...[...sitemapUrls].sort()];
  const vistos = new Set();
  const paginas = [];
  const bloqueadas = [];

  async function procesar(url) {
    const ruta = new URL(url).pathname;
    if (!robots.permitido(ruta)) { bloqueadas.push(url); return; }
    const registro = { url, ruta, en_sitemap: sitemapUrls.has(url), estado_http: null, redireccion_a: null, tipo: null, error: null };
    try {
      const r = await pedir(fetchImpl, url, timeoutMs);
      registro.estado_http = r.estado;
      registro.tipo = r.tipo || null;
      if (r.estado >= 300 && r.estado < 400 && r.ubicacion) {
        registro.redireccion_a = normalizarUrl(r.ubicacion, url);
        if (registro.redireccion_a && mismoSitio(registro.redireccion_a, origen)) cola.push(registro.redireccion_a);
      } else if (r.cuerpo && /html/i.test(r.tipo)) {
        const datos = extraerPagina(r.cuerpo, url);
        Object.assign(registro, datos);
        for (const enlace of datos.enlaces_internos) {
          const u = new URL(enlace);
          if (!u.search && !/\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) cola.push(enlace);
        }
      }
    } catch (e) {
      registro.error = String(e.message ?? e);
    }
    paginas.push(registro);
  }

  while (cola.length && vistos.size < maxPaginas) {
    const lote = [];
    while (cola.length && lote.length < concurrencia && vistos.size < maxPaginas) {
      const u = cola.shift();
      if (vistos.has(u)) continue;
      vistos.add(u);
      lote.push(procesar(u));
    }
    await Promise.all(lote);
  }

  paginas.sort((a, b) => a.url.localeCompare(b.url));
  return {
    schema_version: 1,
    origen,
    iniciado_en: iniciado,
    terminado_en: reloj().toISOString(),
    limite_paginas: maxPaginas,
    truncado: cola.some((u) => !vistos.has(u)),
    robots: { estado_http: robotsEstado, sitemaps: robots.sitemaps, reglas: robots.reglas.length },
    sitemap_urls: [...sitemapUrls].sort(),
    bloqueadas_por_robots: bloqueadas.sort(),
    paginas,
    errores,
  };
}
