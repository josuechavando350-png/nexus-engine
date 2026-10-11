import test from "node:test";
import assert from "node:assert/strict";
import { extraerPagina, leerSitemap, parsearRobots, rastrear, decodificar, normalizarUrl } from "../ojos/crawler.mjs";
import { auditar } from "../ojos/auditoria.mjs";
import { tejas, jaccard, paresParecidos, enmascarar } from "../core/similitud.mjs";
import { validarPerfil } from "../core/perfil.mjs";
import { html, perfilBase, sitioFalso, textoUnico } from "./fixtures.mjs";

const RELOJ = () => new Date("2026-10-11T12:00:00Z");

test("extrae lo que Google lee y descarta scripts, estilos y enlaces que no son páginas", () => {
  const p = extraerPagina(html({
    titulo: "Abogado &amp; defensa — CDMX",
    descripcion: "Atención &quot;urgente&quot;",
    canonical: "/inicio",
    h1: ["Defensa <em>penal</em>"],
    cuerpo: "Texto visible con acentos: niño, acción.",
    enlaces: ["/a#seccion", "/b?x=1", "https://www.sitio.mx/c", "https://externo.mx/", "javascript:void(0)", "#top"],
    jsonld: { "@context": "https://schema.org", "@graph": [{ "@type": "LegalService", name: "Despacho", telephone: "+52 (55) 1234-5678", address: { streetAddress: "Uno 1", addressLocality: "CDMX" } }, { "@type": "WebPage" }] },
    tel: "+525598765432",
  }), "https://sitio.mx/pagina");
  assert.equal(p.titulo, "Abogado & defensa — CDMX");
  assert.equal(p.descripcion, "Atención \"urgente\"");
  assert.equal(p.canonical, "https://sitio.mx/inicio");
  assert.deepEqual(p.h1, ["Defensa penal"]);
  assert.ok(p.texto.includes("niño, acción"));
  assert.ok(!p.texto.includes("no debe aparecer") && !p.texto.includes("color:red"));
  assert.deepEqual(p.enlaces_internos, ["https://sitio.mx/a", "https://sitio.mx/b?x=1", "https://www.sitio.mx/c"]);
  assert.equal(p.enlaces_externos, 1);
  assert.deepEqual(p.jsonld_tipos, ["LegalService", "WebPage"]);
  assert.deepEqual(p.negocio, [{ nombre: "Despacho", direccion: "Uno 1, CDMX", telefono: "+52 (55) 1234-5678" }]);
  assert.deepEqual(p.telefonos, ["5512345678", "5598765432"]);
  assert.equal(p.idioma, "es-MX");
});

test("JSON-LD roto se cuenta, no tumba el rastreo", () => {
  const p = extraerPagina(html({ titulo: "x", jsonld: "{ roto" }), "https://sitio.mx/");
  assert.equal(p.jsonld_invalidos, 1);
  assert.deepEqual(p.negocio, []);
});

test("entidades, URLs y robots.txt se interpretan como lo haría un buscador", () => {
  assert.equal(decodificar("&iquest;Qu&eacute; &#241; &#x41;?"), "¿Qué ñ A?");
  assert.equal(normalizarUrl("mailto:a@b.mx", "https://s.mx/"), null);
  assert.equal(normalizarUrl("/x#y", "https://s.mx/a/"), "https://s.mx/x");
  const r = parsearRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /privado\nAllow: /privado/publico\nDisallow: /*.pdf$\nSitemap: https://s.mx/sitemap.xml");
  assert.deepEqual(r.sitemaps, ["https://s.mx/sitemap.xml"]);
  assert.equal(r.permitido("/"), true);
  assert.equal(r.permitido("/privado/x"), false);
  assert.equal(r.permitido("/privado/publico/y"), true);
  assert.equal(r.permitido("/docs/a.pdf"), false);
  assert.equal(r.permitido("/docs/a.pdf?v=1"), true);
  const indice = leerSitemap("<sitemapindex><sitemap><loc>https://s.mx/a.xml</loc></sitemap></sitemapindex>");
  assert.deepEqual(indice, { esIndice: true, urls: ["https://s.mx/a.xml"] });
});

test("el rastreo respeta robots, no sigue redirecciones a ciegas y registra errores", async () => {
  const s = sitioFalso();
  const snap = await rastrear({ inicio: s.origen, fetchImpl: s.fetchImpl, reloj: RELOJ });
  const rutas = snap.paginas.map((p) => p.ruta);
  assert.ok(!s.visitas.includes("/bloqueada"), "no visita lo prohibido por robots.txt");
  assert.deepEqual(snap.bloqueadas_por_robots, []);
  for (const r of ["/", "/fraude-iztapalapa", "/fraude-coyoacan", "/contacto", "/privada", "/huerfana", "/viejo", "/intermedio", "/no-existe"]) {
    assert.ok(rutas.includes(r), `rastreó ${r}`);
  }
  const viejo = snap.paginas.find((p) => p.ruta === "/viejo");
  assert.equal(viejo.estado_http, 301);
  assert.equal(viejo.redireccion_a, "https://sitio-prueba.mx/intermedio");
  assert.equal(snap.paginas.find((p) => p.ruta === "/no-existe").estado_http, 404);
  assert.equal(snap.sitemap_urls.length, 4);
  assert.equal(snap.iniciado_en, "2026-10-11T12:00:00.000Z");
});

test("el rastreo se detiene en el límite de páginas y lo declara", async () => {
  const s = sitioFalso();
  const snap = await rastrear({ inicio: s.origen, fetchImpl: s.fetchImpl, maxPaginas: 3, reloj: RELOJ });
  assert.equal(snap.paginas.length, 3);
  assert.equal(snap.truncado, true);
});

test("el detector de clones atrapa páginas que solo cambian la zona", () => {
  const a = textoUnico("defensa por fraude", 40, " en Iztapalapa");
  const b = textoUnico("defensa por fraude", 40, " en Coyoacán");
  const distinto = textoUnico("amparo contra orden de aprehension", 40, " en Iztapalapa");
  assert.ok(jaccard(tejas(a, 5, []), tejas(b, 5, [])) < 0.6, "sin enmascarar, el cambio de zona esconde el clon");
  assert.equal(jaccard(tejas(a, 5, ["iztapalapa", "coyoacan"]), tejas(b, 5, ["iztapalapa", "coyoacan"])), 1, "enmascarando, el clon es idéntico");
  assert.ok(jaccard(tejas(a), tejas(distinto)) < 0.1);
  const pares = paresParecidos([{ id: "a", texto: a }, { id: "b", texto: b }, { id: "c", texto: distinto }]);
  assert.deepEqual(pares.map((p) => [p.a, p.b, p.similitud]), [["a", "b", 1]]);
  assert.equal(enmascarar("Abogado en Gustavo A. Madero y en Iztapalapa", ["gustavo a madero", "iztapalapa"]), "abogado en lugar y en lugar");
});

test("la auditoría encuentra los problemas reales del sitio y no inventa otros", async () => {
  const s = sitioFalso();
  const snap = await rastrear({ inicio: s.origen, fetchImpl: s.fetchImpl, reloj: RELOJ });
  const perfil = validarPerfil(perfilBase({ dominio: s.origen }));
  const a = auditar(snap, { perfil });
  const ids = new Set(a.hallazgos.map((h) => h.id));
  for (const id of ["paginas_con_error", "enlaces_rotos", "cadenas_de_redireccion", "noindex_en_sitemap", "sitemap_sucio", "titulo_duplicado", "sin_canonical", "sin_h1", "contenido_casi_duplicado", "paginas_huerfanas", "telefono_inconsistente", "contenido_delgado"]) {
    assert.ok(ids.has(id), `detecta ${id}`);
  }
  assert.ok(!ids.has("sin_schema_negocio"), "el sitio sí trae LegalService");
  assert.ok(!ids.has("canonical_externo"));
  const huerfanas = a.hallazgos.find((h) => h.id === "paginas_huerfanas");
  assert.deepEqual(huerfanas.urls, ["https://sitio-prueba.mx/huerfana"]);
  const clon = a.hallazgos.find((h) => h.id === "contenido_casi_duplicado");
  assert.match(clon.urls[0], /fraude-coyoacan ≈ .*fraude-iztapalapa/);
  const tel = a.hallazgos.find((h) => h.id === "telefono_inconsistente");
  assert.match(tel.urls[0], /contacto/);
  assert.equal(a.hallazgos[0].severidad, "CRITICO", "lo crítico va primero");
  assert.ok(a.salud >= 0 && a.salud < 100);
  assert.match(a.auditoria_digest, /^sha256:/);
});

test("un sitio sano no recibe hallazgos críticos", () => {
  const O = "https://sano.mx";
  const cuerpo = (t) => textoUnico(t, 40);
  const negocio = { "@type": "LegalService", name: "Sano", telephone: "+525511112222" };
  const pagina = (ruta, titulo, enlaces) => ({ url: `${O}${ruta}`, ruta, en_sitemap: true, estado_http: 200, tipo: "text/html", redireccion_a: null, error: null, ...extraerPagina(html({ titulo, descripcion: `${titulo} descripción`, canonical: `${O}${ruta}`, h1: [titulo], cuerpo: cuerpo(titulo), enlaces, jsonld: negocio }), `${O}${ruta}`) });
  const snap = {
    origen: O,
    truncado: false,
    sitemap_urls: [`${O}/`, `${O}/a`, `${O}/b`],
    paginas: [pagina("/", "Inicio sano", ["/a", "/b"]), pagina("/a", "Página A distinta", ["/", "/b"]), pagina("/b", "Página B diferente", ["/", "/a"])],
  };
  const a = auditar(snap, { perfil: validarPerfil(perfilBase({ dominio: O })) });
  assert.equal(a.conteo.CRITICO, 0);
  assert.equal(a.conteo.ALTO, 0);
  assert.equal(a.salud, 100);
});
