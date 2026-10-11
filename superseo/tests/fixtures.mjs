// Fixtures controladas para pruebas. No representan mediciones reales de ningún sitio.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));

export function perfilCano() {
  return JSON.parse(readFileSync(join(AQUI, "..", "clientes", "cano.json"), "utf8"));
}

export function perfilBase(cambios = {}) {
  return {
    schema_version: 1,
    id: "despacho-prueba",
    nombre: "Despacho de Prueba",
    dominio: "https://despacho-prueba.mx",
    rubro: "abogados_penal",
    plan: "BASE",
    estado: "OFF",
    territorio: { especialidades: ["penal-patrimonial"], zonas: ["cdmx-iztapalapa"], exclusivo: false },
    servicios: [{ slug: "fraude", nombre: "Defensa por fraude", ruta: "/fraude" }],
    marca: { terminos: ["despacho de prueba"] },
    contacto: { telefono: "+525511112222", whatsapp: "https://wa.me/525511112222", direccion: "Calle Uno 1, Iztapalapa, CDMX" },
    insumos: { search_console: false, notas_voz: false, perfil_google: false, videos: false, revisor: null, terminos_ads: false },
    historial: [],
    ...cambios,
  };
}

// Texto pseudoaleatorio determinista: cada tema produce vocabulario distinto.
const VOCABULARIO = "plazo fiscalia juez audiencia carpeta amparo pruebas testigo defensa citatorio ministerio detencion libertad medida cautelar recurso apelacion sentencia acuerdo reparacion victima denuncia querella peritaje contrato empresa contador socio patrimonio inmueble despojo fraude cheque cuenta transferencia factura auditoria requerimiento hacienda tribunal colegiado juicio oral etapa intermedia investigacion complementaria imputacion vinculacion suspension condicional procedimiento abreviado mecanismo alternativo mediacion conciliacion familia hijo esposa madre padre hermano vecino oficina horario llamada mensaje cita revision documento original copia firma notario registro".split(" ");

function semilla(texto) {
  let h = 2166136261;
  for (const c of texto) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h;
}

export function textoUnico(tema, n = 60, sufijo = "") {
  let s = semilla(tema);
  const siguiente = () => { s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0; s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0; return (s ^= s >>> 16) >>> 0; };
  return Array.from({ length: n }, () => Array.from({ length: 10 }, () => VOCABULARIO[siguiente() % VOCABULARIO.length]).join(" ") + sufijo).join(". ");
}

const parrafo = (tema, n = 60) => textoUnico(tema, n);

export function html({ titulo, descripcion, canonical, robots, h1 = [], cuerpo = "", enlaces = [], jsonld = null, tel = null }) {
  return `<!doctype html><html lang="es-MX"><head>
<meta charset="utf-8">
${titulo === undefined ? "" : `<title>${titulo}</title>`}
${descripcion ? `<meta content="${descripcion}" name="description">` : ""}
${robots ? `<meta name="robots" content="${robots}">` : ""}
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
${jsonld ? `<script type="application/ld+json">${typeof jsonld === "string" ? jsonld : JSON.stringify(jsonld)}</script>` : ""}
<style>.x{color:red}</style>
</head><body>
<nav>${enlaces.map((e) => `<a href="${e}">enlace</a>`).join(" ")}</nav>
${h1.map((h) => `<h1>${h}</h1>`).join("")}
<main><p>${cuerpo}</p>${tel ? `<a href="tel:${tel}">Llamar</a>` : ""}</main>
<script>var oculto = "no debe aparecer";</script>
</body></html>`;
}

// Un sitio falso con los problemas típicos: 404, redirección en cadena, noindex en
// sitemap, títulos repetidos, clon por cambio de zona y una página huérfana.
export function sitioFalso() {
  const O = "https://sitio-prueba.mx";
  const negocio = { "@context": "https://schema.org", "@type": "LegalService", name: "Despacho Prueba", telephone: "+52 55 1111 2222", address: { "@type": "PostalAddress", streetAddress: "Calle Uno 1", addressLocality: "CDMX" } };
  const clon = (zona) => textoUnico("defensa penal por fraude", 60, ` en ${zona}`);
  const paginas = {
    "/": html({ titulo: "Despacho Prueba | Abogados penales", descripcion: "Defensa penal en CDMX", canonical: `${O}/`, h1: ["Abogados penales"], cuerpo: parrafo("Defensa penal en la Ciudad de México"), enlaces: ["/fraude-iztapalapa", "/fraude-coyoacan", "/contacto", "/viejo", "/no-existe", "mailto:x@y.mx", "https://otro.mx/"], jsonld: negocio, tel: "+525511112222" }),
    "/fraude-iztapalapa": html({ titulo: "Fraude", descripcion: "Fraude", canonical: `${O}/fraude-iztapalapa`, h1: ["Fraude en Iztapalapa"], cuerpo: clon("Iztapalapa"), enlaces: ["/"] }),
    "/fraude-coyoacan": html({ titulo: "Fraude", descripcion: "Fraude", canonical: `${O}/fraude-coyoacan`, h1: ["Fraude en Coyoacán"], cuerpo: clon("Coyoacan"), enlaces: ["/"] }),
    "/contacto": html({ titulo: "Contacto", h1: [], cuerpo: "Escríbenos.", enlaces: ["/"], tel: "+525599998888" }),
    "/privada": html({ titulo: "Privada", descripcion: "x", canonical: `${O}/privada`, robots: "noindex, nofollow", h1: ["Privada"], cuerpo: parrafo("Privada") }),
    "/huerfana": html({ titulo: "Huérfana del sitio", descripcion: "Huérfana", canonical: `${O}/huerfana`, h1: ["Huérfana"], cuerpo: parrafo("Una guía que nadie enlaza") }),
    "/bloqueada": html({ titulo: "Bloqueada", h1: ["Bloqueada"], cuerpo: "No debe visitarse" }),
  };
  const redirecciones = { "/viejo": "/intermedio", "/intermedio": "/contacto" };
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>${O}/</loc></url><url><loc>${O}/privada</loc></url><url><loc>${O}/huerfana</loc></url><url><loc>${O}/viejo</loc></url></urlset>`;
  const robots = "User-agent: *\nDisallow: /bloqueada\nSitemap: https://sitio-prueba.mx/sitemap.xml\n";
  const visitas = [];
  async function fetchImpl(url, opciones = {}) {
    const u = new URL(url);
    visitas.push(u.pathname);
    if (opciones.redirect !== "manual") throw new Error("el crawler debe pedir redirect manual");
    const resp = (status, body, tipo, extra = {}) => new Response(body, { status, headers: { "content-type": tipo, ...extra } });
    if (u.pathname === "/robots.txt") return resp(200, robots, "text/plain");
    if (u.pathname === "/sitemap.xml") return resp(200, sitemap, "application/xml");
    if (redirecciones[u.pathname]) return new Response(null, { status: 301, headers: { location: redirecciones[u.pathname] } });
    if (paginas[u.pathname]) return resp(200, paginas[u.pathname], "text/html; charset=utf-8");
    return resp(404, "<html><body>No existe</body></html>", "text/html");
  }
  return { origen: O, fetchImpl, visitas };
}
