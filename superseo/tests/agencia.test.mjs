// Pruebas del modo agencia: rubro agencia_web, portafolio curado, entrega por ZIP,
// enlaces declarados por página y el candado contra promesas de posición.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esYmyl, validarPerfil } from "../core/perfil.mjs";
import { minarDemanda, validarPortafolio } from "../ojos/demanda.mjs";
import { forjarPagina, planificarPagina } from "../manos/forja.mjs";
import { construirPaquete, escribirPaquete } from "../manos/publicar.mjs";
import { cargarCartera, buscarCliente } from "../core/cartera.mjs";
import { cargarPaginas, cargarPortafolio, cargarSitio } from "../core/almacen.mjs";
import { perfilBase, textoUnico } from "./fixtures.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AHORA = new Date("2026-10-11T12:00:00Z");

const agencia = () => validarPerfil(perfilBase({
  id: "agencia-prueba",
  nombre: "Agencia de Prueba",
  dominio: "https://agencia-prueba.mx",
  rubro: "agencia_web",
  territorio: { especialidades: ["diseno-web"], zonas: ["mx"], exclusivo: false },
  servicios: [
    { slug: "web", nombre: "Páginas web", ruta: "/web" },
    { slug: "ia", nombre: "Agentes de IA", ruta: "/ia" },
  ],
  contacto: { telefono: "+525500000000", whatsapp: "https://wa.me/525500000000", direccion: null },
}));

const spec = (cambios = {}) => ({
  id: "pagina-web-para-dentistas",
  tipo: "GIRO",
  grupo: "Salud",
  titulo: "Página web para dentistas",
  intencion: "COMERCIAL",
  consultas: ["pagina web para dentistas", "diseño web dental"],
  servicio: "web",
  enlaces: ["/web", "/ia"],
  ...cambios,
});

function redactor({ extra = "" } = {}) {
  return async (brief) => ({
    titulo: brief.titulo_sugerido,
    descripcion: `Guía clara para entender ${brief.titulo_sugerido.toLowerCase()} y decidir el siguiente paso con calma y sin presión.`.slice(0, 160),
    h1: brief.titulo_sugerido,
    respuesta_rapida: ["Define qué buscan tus pacientes.", "Haz fácil agendar por WhatsApp.", "Mide los contactos de cada página."],
    secciones: ["Qué necesita", "Cómo se construye", "Qué medir"].map((t, i) => ({ titulo: t, parrafos: [textoUnico(`${brief.id}-${i}`, 22) + (i === 0 ? extra : "")] })),
    faq: [1, 2, 3].map((n) => ({ pregunta: `¿Pregunta ${n}?`, respuesta: textoUnico(`${brief.id}-f${n}`, 2) })),
    _redactor: "prueba",
  });
}

test("agencia_web no es sensible y no genera Torres por zona: solo lo que declara el portafolio", () => {
  const p = agencia();
  assert.equal(esYmyl(p), false);
  const { candidatos } = minarDemanda(p, { portafolio: [spec(), spec({ id: "chatbot-para-dentistas", tipo: "AGENTE_IA", titulo: "Chatbot de WhatsApp para dentistas", servicio: "ia" })] });
  assert.deepEqual(candidatos.map((c) => c.id).sort(), ["chatbot-para-dentistas", "pagina-web-para-dentistas"]);
  assert.ok(candidatos.every((c) => c.tipo !== "TORRE_ZONA"));
  assert.equal(candidatos.find((c) => c.id === "pagina-web-para-dentistas").grupo, "Salud");
});

test("el portafolio falla cerrado: id repetido, tipo inventado, enlace a sí misma o sin grupo", () => {
  for (const malo of [
    [spec(), spec()],
    [spec({ tipo: "TORRE_ZONA" })],
    [spec({ enlaces: ["/pagina-web-para-dentistas"] })],
    [spec({ enlaces: ["https://otro.com"] })],
    [spec({ grupo: "" })],
    [spec({ consultas: [] })],
    [spec({ intencion: "INVENTADA" })],
  ]) {
    assert.throws(() => validarPortafolio(malo), /PORTAFOLIO_INVALIDO/);
  }
});

test("los enlaces del portafolio van primero y nunca se repiten", () => {
  const p = agencia();
  const [c] = minarDemanda(p, { portafolio: [spec({ enlaces: ["/web", "/ia", "/web"] })] }).candidatos;
  const brief = planificarPagina(c, p, { existentes: ["/", "/web", "/ia"] });
  const rutas = brief.enlaces.map((e) => e.ruta);
  assert.deepEqual(rutas.slice(0, 2), ["/web", "/ia"]);
  assert.equal(new Set(rutas).size, rutas.length, `sin duplicados: ${rutas.join(", ")}`);
  assert.equal(brief.enlaces[0].texto, "Páginas web", "el texto viene del servicio del cliente");
});

test("una página de agencia que pasa los candados queda aprobada y conserva su grupo", async () => {
  const p = agencia();
  const [c] = minarDemanda(p, { portafolio: [spec()] }).candidatos;
  const pag = await forjarPagina(c, p, { redactor: redactor(), existentes: ["/", "/web", "/ia"], ahora: AHORA });
  assert.equal(pag.estado, "APROBADA", pag.candados.motivos.join("; "));
  assert.equal(pag.grupo, "Salud");
  const paquete = construirPaquete({ ...p, estado: "ON" }, [pag]);
  assert.equal(paquete.publicadas[0].grupo, "Salud");
});

test("prometer el primer lugar en Google se rechaza", async () => {
  const p = agencia();
  const [c] = minarDemanda(p, { portafolio: [spec()] }).candidatos;
  for (const frase of [" Te ponemos en primer lugar en Google.", " Llega a la primera posición de Google.", " Top 1 en Google en un mes."]) {
    const pag = await forjarPagina(c, p, { redactor: redactor({ extra: frase }), existentes: ["/", "/web", "/ia"], ahora: AHORA });
    assert.equal(pag.estado, "RECHAZADA", frase);
    assert.ok(pag.candados.motivos.some((m) => /posición en Google/.test(m)), frase);
  }
});

test("entrega por ZIP: sitio.json se valida y el paquete queda junto al cliente", () => {
  const base = mkdtempSync(join(tmpdir(), "superseo-zip-"));
  try {
    const escribir = (id, sitio) => {
      mkdirSync(join(base, id), { recursive: true });
      writeFileSync(join(base, id, "sitio.json"), JSON.stringify(sitio));
    };
    escribir("ok", { app: null, entrega: "ZIP", indexnow_key: null, rutas: { "/": "Inicio", "/web": "Web" } });
    assert.equal(cargarSitio("ok", base).entrega, "ZIP");
    escribir("sin-entrega", { app: null, indexnow_key: null, rutas: {} });
    assert.throws(() => cargarSitio("sin-entrega", base), /SITIO_INVALIDO/);
    escribir("ruta-mala", { app: null, entrega: "ZIP", indexnow_key: null, rutas: { "web": "Web" } });
    assert.throws(() => cargarSitio("ruta-mala", base), /SITIO_INVALIDO/);
    const destino = escribirPaquete({ cliente: "ok", publicadas: [] }, cargarSitio("ok", base), base);
    assert.equal(destino, join(base, "superseo", "clientes", "ok", "entrega", "paginas.json"));
    assert.deepEqual(JSON.parse(readFileSync(destino, "utf8")), { cliente: "ok", publicadas: [] });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Nexus: portafolio válido, todas sus páginas aprobadas y el paquete del ZIP sincronizado", () => {
  const perfil = buscarCliente(cargarCartera(), "nexus");
  assert.equal(perfil.rubro, "agencia_web");
  const portafolio = validarPortafolio(cargarPortafolio("nexus"));
  const paginas = cargarPaginas("nexus");
  assert.equal(paginas.length, portafolio.length);
  assert.ok(paginas.every((p) => p.estado === "APROBADA"), "todas aprobadas");
  const sitio = cargarSitio("nexus");
  assert.equal(sitio.entrega, "ZIP");
  const esperado = construirPaquete(perfil, paginas);
  const enRepo = JSON.parse(readFileSync(join(RAIZ, "superseo", "clientes", "nexus", "entrega", "paginas.json"), "utf8"));
  assert.deepEqual(enRepo, esperado, "corre: node superseo/cli.mjs publicar nexus");
  const vivas = new Set(esperado.publicadas.map((p) => p.ruta));
  for (const p of esperado.publicadas) {
    assert.equal(new Set(p.enlaces.map((e) => e.ruta)).size, p.enlaces.length, `${p.ruta} sin enlaces repetidos`);
    for (const e of p.enlaces) assert.ok(vivas.has(e.ruta) || e.ruta in sitio.rutas, `${p.ruta} enlaza a ${e.ruta}, que no existe`);
  }
});
