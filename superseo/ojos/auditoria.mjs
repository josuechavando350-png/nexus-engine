// Despertador de autoridad: auditoría técnica sobre un rastreo real.
// Cada hallazgo dice qué está mal, por qué importa y en qué URLs. No inventa
// estados de Google: solo reporta lo que el rastreo observó.
import { sha256, deepFreeze } from "../core/canonical.mjs";
import { paresParecidos } from "../core/similitud.mjs";
import { soloDigitos } from "./crawler.mjs";

const PESO = { CRITICO: 12, ALTO: 6, MEDIO: 3, BAJO: 1 };
const MAX_URLS = 25;

function esIndexable(p) {
  return p.estado_http === 200 && /html/i.test(p.tipo ?? "") && !/noindex/i.test(p.robots ?? "");
}

function sinBarra(u) {
  return u && u !== "/" ? u.replace(/\/$/, "") : u;
}

function agrupar(paginas, clave) {
  const mapa = new Map();
  for (const p of paginas) {
    const v = clave(p);
    if (!v) continue;
    if (!mapa.has(v)) mapa.set(v, []);
    mapa.get(v).push(p.url);
  }
  return [...mapa.entries()].filter(([, urls]) => urls.length > 1);
}

export function auditar(snapshot, { perfil = null } = {}) {
  const hallazgos = [];
  const add = (id, severidad, titulo, porque, urls = []) => {
    if (!urls.length && id !== "sin_schema_negocio" && id !== "sin_sitemap") return;
    hallazgos.push({ id, severidad, titulo, porque, total: urls.length, urls: [...urls].sort().slice(0, MAX_URLS) });
  };

  const paginas = snapshot.paginas;
  const porUrl = new Map(paginas.map((p) => [p.url, p]));
  const html = paginas.filter((p) => p.estado_http === 200 && /html/i.test(p.tipo ?? ""));
  const indexables = html.filter(esIndexable);
  const sitemap = new Set(snapshot.sitemap_urls);

  // 1. Errores HTTP y enlaces internos rotos
  const errores = paginas.filter((p) => (p.estado_http ?? 0) >= 400 || p.error);
  add("paginas_con_error", "CRITICO", "Páginas que responden con error", "Google no puede leerlas y el visitante ve un error.", errores.map((p) => `${p.url} (${p.estado_http ?? p.error})`));
  const rotos = new Set(errores.map((p) => p.url));
  const enlazanRoto = html.filter((p) => p.enlaces_internos.some((e) => rotos.has(e)));
  add("enlaces_rotos", "ALTO", "Páginas que enlazan a páginas con error", "Desperdician autoridad y frustran al visitante.", enlazanRoto.map((p) => p.url));

  // 2. Redirecciones
  const redirs = paginas.filter((p) => p.redireccion_a);
  const cadenas = redirs.filter((p) => porUrl.get(p.redireccion_a)?.redireccion_a);
  add("cadenas_de_redireccion", "MEDIO", "Redirecciones en cadena", "Cada salto extra pierde velocidad y algo de autoridad.", cadenas.map((p) => `${p.url} → ${p.redireccion_a}`));
  const temporales = redirs.filter((p) => p.estado_http === 302 || p.estado_http === 307);
  add("redirecciones_temporales", "BAJO", "Redirecciones temporales (302/307)", "Si el cambio es permanente, una 301 transmite mejor la autoridad.", temporales.map((p) => `${p.url} → ${p.redireccion_a}`));
  const aRedir = new Set(redirs.map((p) => p.url));
  const enlazanRedir = html.filter((p) => p.enlaces_internos.some((e) => aRedir.has(e)));
  add("enlaces_a_redirecciones", "BAJO", "Enlaces internos que apuntan a una redirección", "Conviene enlazar directo a la URL final.", enlazanRedir.map((p) => p.url));
  const sitemapRedir = [...sitemap].filter((u) => aRedir.has(u) || rotos.has(u));
  add("sitemap_sucio", "MEDIO", "URLs del sitemap que redirigen o fallan", "El sitemap debe listar solo URLs finales que funcionan.", sitemapRedir);

  // 3. Indexación
  const noindexEnSitemap = html.filter((p) => sitemap.has(p.url) && /noindex/i.test(p.robots ?? ""));
  add("noindex_en_sitemap", "CRITICO", "Páginas del sitemap marcadas noindex", "Le pides a Google que la vea y a la vez que no la indexe.", noindexEnSitemap.map((p) => p.url));
  if (!snapshot.sitemap_urls.length) add("sin_sitemap", "ALTO", "No se encontró sitemap", "El sitemap acelera que Google descubra páginas nuevas.", []);

  // 4. Títulos y descripciones
  add("sin_titulo", "ALTO", "Páginas sin título", "El título es lo primero que Google muestra.", indexables.filter((p) => !p.titulo).map((p) => p.url));
  add("titulo_duplicado", "MEDIO", "Títulos repetidos", "Google no sabe cuál página mostrar para esa búsqueda.", agrupar(indexables, (p) => p.titulo).flatMap(([t, urls]) => urls.map((u) => `${u} — "${t}"`)));
  add("titulo_largo", "BAJO", "Títulos de más de 65 caracteres", "Google los corta en el resultado.", indexables.filter((p) => (p.titulo ?? "").length > 65).map((p) => p.url));
  add("sin_descripcion", "MEDIO", "Páginas sin meta descripción", "Google improvisa el texto del resultado y suele bajar el clic.", indexables.filter((p) => !p.descripcion).map((p) => p.url));
  add("descripcion_duplicada", "BAJO", "Descripciones repetidas", "Cada página debe vender su propia respuesta.", agrupar(indexables, (p) => p.descripcion).flatMap(([, urls]) => urls));

  // 5. Canonical
  add("sin_canonical", "MEDIO", "Páginas sin canonical", "Sin canonical, Google puede elegir otra versión de la URL.", indexables.filter((p) => !p.canonical).map((p) => p.url));
  const canonExterno = indexables.filter((p) => p.canonical && new URL(p.canonical).hostname.replace(/^www\./, "") !== new URL(p.url).hostname.replace(/^www\./, ""));
  add("canonical_externo", "CRITICO", "Canonical que apunta a otro dominio", "Le cede la autoridad de la página a otro sitio.", canonExterno.map((p) => `${p.url} → ${p.canonical}`));
  const canonOtra = indexables.filter((p) => p.canonical && sinBarra(p.canonical) !== sinBarra(p.url) && !canonExterno.includes(p));
  add("canonical_a_otra_url", "BAJO", "Canonical que apunta a otra URL del sitio", "Válido si es intencional; si no, esa página no rankeará.", canonOtra.map((p) => `${p.url} → ${p.canonical}`));

  // 6. Encabezados y contenido
  add("sin_h1", "MEDIO", "Páginas sin H1", "El H1 le dice a Google y al visitante de qué trata la página.", indexables.filter((p) => !p.h1?.length).map((p) => p.url));
  add("varios_h1", "BAJO", "Páginas con varios H1", "Un solo H1 claro es más fácil de entender.", indexables.filter((p) => (p.h1?.length ?? 0) > 1).map((p) => p.url));
  add("contenido_delgado", "MEDIO", "Páginas con menos de 300 palabras", "Poco contenido rara vez responde lo que la gente busca.", indexables.filter((p) => p.palabras < 300).map((p) => `${p.url} (${p.palabras} palabras)`));
  const duplicados = paresParecidos(indexables.map((p) => ({ id: p.url, texto: p.texto })), { umbral: 0.8 });
  add("contenido_casi_duplicado", "ALTO", "Páginas casi idénticas entre sí", "Google tiende a mostrar solo una y puede tratarlas como relleno.", duplicados.map((d) => `${d.a} ≈ ${d.b} (${Math.round(d.similitud * 100)}%)`));

  // 7. Enlazado interno
  const enlazadas = new Set(html.flatMap((p) => p.enlaces_internos.filter((e) => e !== p.url)));
  const raiz = `${snapshot.origen}/`;
  const huerfanas = indexables.filter((p) => p.url !== raiz && !enlazadas.has(p.url) && !enlazadas.has(sinBarra(p.url)) && !enlazadas.has(`${sinBarra(p.url)}/`));
  add("paginas_huerfanas", "MEDIO", "Páginas sin enlaces internos que lleguen a ellas", "Si ninguna página las enlaza, Google les da poca importancia.", huerfanas.map((p) => p.url));
  const fueraSitemap = indexables.filter((p) => !sitemap.has(p.url) && snapshot.sitemap_urls.length);
  add("fuera_de_sitemap", "BAJO", "Páginas indexables que no están en el sitemap", "Agregarlas ayuda a que Google las descubra y revise.", fueraSitemap.map((p) => p.url));

  // 8. Negocio local
  const conNegocio = html.filter((p) => p.negocio?.length);
  if (!conNegocio.length) add("sin_schema_negocio", "ALTO", "Sin datos estructurados del negocio", "LocalBusiness / LegalService ayuda a Google a entender quién es y dónde está.", []);
  const ldInvalido = html.filter((p) => p.jsonld_invalidos > 0);
  add("jsonld_invalido", "MEDIO", "Datos estructurados con error de sintaxis", "Google ignora el bloque completo.", ldInvalido.map((p) => p.url));
  const telefonos = new Set(html.flatMap((p) => p.telefonos ?? []));
  const oficial = perfil?.contacto?.telefono ? soloDigitos(perfil.contacto.telefono) : null;
  const ajenos = oficial ? [...telefonos].filter((t) => t !== oficial) : (telefonos.size > 1 ? [...telefonos] : []);
  if (ajenos.length) {
    const urls = html.filter((p) => (p.telefonos ?? []).some((t) => ajenos.includes(t))).map((p) => `${p.url} (${p.telefonos.join(", ")})`);
    add("telefono_inconsistente", "MEDIO", "Teléfonos distintos al oficial", "Datos de contacto inconsistentes confunden a Google y al cliente.", urls);
  }

  hallazgos.sort((a, b) => PESO[b.severidad] - PESO[a.severidad] || b.total - a.total || a.id.localeCompare(b.id));
  const conteo = { CRITICO: 0, ALTO: 0, MEDIO: 0, BAJO: 0 };
  for (const h of hallazgos) conteo[h.severidad] += 1;
  const castigo = hallazgos.reduce((s, h) => s + PESO[h.severidad] * Math.min(3, 1 + Math.log10(Math.max(1, h.total))), 0);
  const cuerpo = {
    schema_version: 1,
    origen: snapshot.origen,
    rastreo: { paginas: paginas.length, html: html.length, indexables: indexables.length, en_sitemap: sitemap.size, truncado: snapshot.truncado },
    salud: Math.max(0, Math.round(100 - castigo)),
    conteo,
    hallazgos,
    rastreo_digest: sha256(snapshot),
  };
  return deepFreeze({ ...cuerpo, auditoria_digest: sha256(cuerpo) });
}
