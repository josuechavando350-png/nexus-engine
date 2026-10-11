import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validarPerfil } from "../core/perfil.mjs";
import { cambiarEstado } from "../core/interruptor.mjs";
import { minarDemanda, leerKeywordPlanner } from "../ojos/demanda.mjs";
import { priorizarLote, OPERADOR_GAUSS } from "../cerebro/priorizar.mjs";
import { forjarPagina, planificarPagina, revisarPagina, revalidar } from "../manos/forja.mjs";
import { aprobar, digestContenido, estadoEfectivo, AVISO_YMYL } from "../manos/pagina.mjs";
import { instrucciones, mensajeUsuario, redactorAnthropic } from "../manos/redactores.mjs";
import { construirPaquete } from "../manos/publicar.mjs";
import { entradasSitemap, enviarIndexNow, planEnlacesInternos } from "../manos/indexacion.mjs";
import { cargarCartera, buscarCliente } from "../core/cartera.mjs";
import { cargarConocimiento, cargarPaginas } from "../core/almacen.mjs";
import { perfilBase, perfilCano, textoUnico } from "./fixtures.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AHORA = new Date("2026-10-11T12:00:00Z");
const cano = () => validarPerfil(perfilCano());

// Redactor de prueba: contenido único por página, sin cifras ni promesas.
function redactorFalso({ extra = "", cifra = null, prometer = false } = {}) {
  return async (brief) => ({
    titulo: `${brief.titulo_sugerido}`.slice(0, 60).padEnd(20, "."),
    descripcion: `Guía clara del despacho para entender ${brief.titulo_sugerido.toLowerCase()} y saber cuál es el siguiente paso con calma.`.slice(0, 160),
    h1: brief.titulo_sugerido,
    respuesta_rapida: ["Ubica a la autoridad que intervino.", "No firmes nada sin leerlo.", "Habla con el despacho cuanto antes."],
    secciones: brief.secciones_requeridas.map((t, i) => ({ titulo: t, parrafos: [textoUnico(`${brief.id}-${i}`, 14) + (i === 0 && cifra ? ` En total fueron ${cifra} casos.` : "") + (i === 0 && prometer ? " Resultado garantizado." : "") + (i === 0 ? extra : "")] })),
    faq: [
      { pregunta: "¿Qué hago primero?", respuesta: textoUnico(`${brief.id}-faq1`, 2) },
      { pregunta: "¿Puedo esperar?", respuesta: textoUnico(`${brief.id}-faq2`, 2) },
      { pregunta: "¿Cómo contacto al despacho?", respuesta: textoUnico(`${brief.id}-faq3`, 2) },
    ],
    _redactor: "prueba",
  });
}

test("Demand Miner: Torres por alcaldía, guías y cruces con sentido; lo existente no se duplica", () => {
  const d = minarDemanda(cano());
  assert.equal(d.fuente, "ESTIMADO");
  assert.match(d.nota, /no un volumen real/);
  const ids = d.candidatos.map((c) => c.id);
  assert.ok(ids.includes("abogado-penal-iztapalapa") && ids.includes("abogado-penal-xochimilco"));
  assert.equal(d.candidatos.filter((c) => c.tipo === "TORRE_ZONA").length, 16);
  const detencion = d.candidatos.find((c) => c.id === "detencion-cdmx");
  assert.equal(detencion.cobertura, "EXISTE");
  assert.equal(detencion.cubierta_por, "/detenido-cdmx");
  assert.ok(!ids.includes("acusacion-falsa-despojo-victimas"), "no cruza 'me acusan' con servicios de víctimas");
  assert.ok(d.candidatos.every((c) => c.ruta.length <= 81 && /^\/[a-z0-9-]+$/.test(c.ruta)));
  assert.ok(d.candidatos.every((c) => c.fuente_valor === "ESTIMADO"));
  assert.equal(minarDemanda(cano()).demanda_digest, d.demanda_digest, "determinista");
});

test("Demand Miner usa volúmenes reales de Keyword Planner cuando existen", () => {
  const csv = "Keyword Stats 2026-10-01\n\"Keyword\",\"Avg. monthly searches\"\nabogado penalista en Iztapalapa,1000\n\"como presentar una denuncia penal en cdmx\",100 – 1000\n";
  const vol = leerKeywordPlanner(csv);
  assert.deepEqual(vol, [{ consulta: "abogado penalista en Iztapalapa", volumen_mensual: 1000 }, { consulta: "como presentar una denuncia penal en cdmx", volumen_mensual: 550 }]);
  const d = minarDemanda(cano(), { volumenes: vol });
  const izt = d.candidatos.find((c) => c.id === "abogado-penal-iztapalapa");
  assert.equal(izt.fuente_valor, "VOLUMEN_REAL");
  assert.equal(izt.volumen, 1000);
  assert.ok(izt.valor > d.candidatos.find((c) => c.id === "abogado-penal-tlalpan").valor);
  assert.equal(d.fuente, "VOLUMEN_REAL_Y_ESTIMADO");
});

test("GAUSS elige el lote óptimo y sin Observatorio no deja entrar Torres", () => {
  const d = minarDemanda(cano());
  const sin = priorizarLote(d, { plan: "TOTAL" });
  assert.equal(sin.operador, OPERADOR_GAUSS);
  assert.equal(sin.optimo, true);
  assert.ok(sin.seleccion.length > 0 && sin.seleccion.every((c) => !c.requiere_datos_locales));
  assert.ok(sin.esfuerzo_total <= 40);
  const con = priorizarLote(d, { plan: "TOTAL", hayDatosLocales: true });
  assert.ok(con.seleccion.some((c) => c.tipo === "TORRE_ZONA"));
  // Verificación independiente: ningún subconjunto de los evaluados rinde más.
  const ev = con.evaluados;
  let mejor = 0;
  for (let mask = 0; mask < 1 << Math.min(ev.length, 16); mask += 1) {
    let peso = 0; let valor = 0;
    for (let i = 0; i < Math.min(ev.length, 16); i += 1) if (mask & (1 << i)) { peso += ev[i].esfuerzo; valor += ev[i].valor; }
    if (peso <= 40) mejor = Math.max(mejor, valor);
  }
  assert.ok(con.valor_total >= Math.round(mejor * 10) / 10);
  const excl = priorizarLote(d, { plan: "TOTAL", excluir: sin.seleccion.map((c) => c.id) });
  assert.ok(excl.seleccion.every((c) => !sin.seleccion.some((s) => s.id === c.id)), "no repite lo ya forjado");
});

test("el plan de página trae secciones, preguntas y enlaces que existen", () => {
  const p = cano();
  const d = minarDemanda(p);
  const c = d.candidatos.find((x) => x.id === "acusacion-falsa-cdmx");
  const brief = planificarPagina(c, p, { existentes: ["/"] });
  assert.equal(brief.secciones_requeridas.length, 5);
  assert.ok(brief.preguntas_sugeridas.some((q) => q.startsWith("Me acusan")));
  assert.ok(brief.enlaces.some((e) => e.ruta === "/"));
  assert.throws(() => planificarPagina(d.candidatos.find((x) => x.id === "detencion-cdmx"), p), /CANDIDATO_YA_CUBIERTO/);
  const sys = instrucciones(brief);
  assert.match(sys, /No escribas cifras/);
  assert.match(sys, /No prometas resultados/);
  assert.match(mensajeUsuario(brief, "CONOCIMIENTO X"), /CONOCIMIENTO DEL CLIENTE\nCONOCIMIENTO X/);
});

test("la Forja deja en borrador lo sensible y rechaza promesas, cifras sin fuente y clones", async () => {
  const p = cano();
  const d = minarDemanda(p);
  const c = d.candidatos.find((x) => x.id === "acusacion-falsa-cdmx");
  const conocimiento = cargarConocimiento("cano");
  const opciones = { conocimiento, existentes: ["/", ...p.servicios.map((s) => s.ruta)], ahora: AHORA };
  const buena = await forjarPagina(c, p, { redactor: redactorFalso(), ...opciones });
  assert.equal(buena.candados.ok, true, buena.candados.motivos.join("; "));
  assert.equal(buena.estado, "BORRADOR", "abogados: espera revisión humana");
  assert.equal(buena.aviso, AVISO_YMYL);
  assert.equal(buena.aprobacion, null);
  assert.equal(buena.contenido_digest, digestContenido(buena));

  const promesa = await forjarPagina(c, p, { redactor: redactorFalso({ prometer: true }), ...opciones });
  assert.equal(promesa.estado, "RECHAZADA");
  assert.ok(promesa.candados.motivos.some((m) => /promete resultados/.test(m)));

  const cifra = await forjarPagina(c, p, { redactor: redactorFalso({ cifra: 4537 }), ...opciones });
  assert.equal(cifra.estado, "RECHAZADA");
  assert.ok(cifra.candados.motivos.some((m) => /cifras sin fuente.*4537/.test(m)));

  const conTelefono = await forjarPagina(c, p, { redactor: redactorFalso({ extra: " Llama al 55 6050 1901." }), ...opciones });
  assert.equal(conTelefono.candados.ok, true, "el teléfono del conocimiento sí tiene fuente");

  const otro = d.candidatos.find((x) => x.id === "carpeta-investigacion-cdmx");
  const clon = await forjarPagina(otro, p, { redactor: async () => ({ ...(await redactorFalso()({ ...planificarPagina(c, p), id: c.id })), _redactor: "clon" }), ...opciones, hermanas: [buena] });
  assert.equal(clon.estado, "RECHAZADA");
  assert.ok(clon.candados.motivos.some((m) => /demasiado parecida a \/acusacion-falsa-cdmx/.test(m)));
});

test("una Torre sin datos locales verificados no pasa", async () => {
  const p = cano();
  const torre = minarDemanda(p).candidatos.find((x) => x.id === "abogado-penal-iztapalapa");
  const r = await forjarPagina(torre, p, { redactor: redactorFalso(), conocimiento: cargarConocimiento("cano"), existentes: ["/", ...p.servicios.map((s) => s.ruta)], ahora: AHORA });
  assert.equal(r.estado, "RECHAZADA");
  assert.ok(r.candados.motivos.some((m) => /al menos 3 datos locales/.test(m)));
});

test("la aprobación se liga al contenido exacto: una coma cambiada la anula", async () => {
  const p = cano();
  const c = minarDemanda(p).candidatos.find((x) => x.id === "acusacion-falsa-cdmx");
  const pag = await forjarPagina(c, p, { redactor: redactorFalso(), conocimiento: cargarConocimiento("cano"), existentes: ["/", ...p.servicios.map((s) => s.ruta)], ahora: AHORA });
  assert.throws(() => aprobar(pag, { revisor: "MAMA", por: "x" }), /REVISOR_INVALIDO/);
  assert.throws(() => aprobar(pag, { revisor: "CLIENTE", por: "" }), /APROBADOR_INVALIDO/);
  const ok = aprobar(pag, { revisor: "CLIENTE", por: "Eduardo Cano", ahora: AHORA });
  assert.equal(estadoEfectivo(ok), "APROBADA");
  assert.equal(ok.aprobacion.en, "2026-10-11T12:00:00Z");
  const editada = { ...ok, h1: `${ok.h1},` };
  assert.equal(estadoEfectivo(editada), "BORRADOR");
  assert.throws(() => aprobar(editada, { revisor: "CLIENTE", por: "Eduardo Cano" }), /CONTENIDO_CAMBIO/);
  const rev = revalidar(editada, p, { conocimiento: cargarConocimiento("cano"), existentes: ["/", ...p.servicios.map((s) => s.ruta)] });
  assert.equal(rev.estado, "BORRADOR");
  assert.equal(rev.aprobacion, null);
  const rechazada = { ...pag, candados: { ok: false, motivos: ["x"] } };
  assert.throws(() => aprobar(rechazada, { revisor: "CLIENTE", por: "Eduardo Cano" }), /CANDADOS_PENDIENTES/);
});

test("rubro no sensible: lo que pasa los candados queda aprobado sin esperar", async () => {
  const taqueria = validarPerfil(perfilBase({ id: "taqueria", rubro: "restaurante", servicios: [{ slug: "tacos", nombre: "Tacos al pastor", ruta: "/menu" }], territorio: { especialidades: ["tacos"], zonas: ["cdmx-tlalpan"], exclusivo: false } }));
  const c = minarDemanda(taqueria).candidatos.find((x) => x.tipo === "GUIA_SITUACION");
  const pag = await forjarPagina(c, taqueria, { redactor: redactorFalso(), existentes: ["/", "/menu"], ahora: AHORA });
  assert.equal(pag.candados.ok, true, pag.candados.motivos.join("; "));
  assert.equal(pag.estado, "APROBADA");
  assert.equal(pag.aprobacion.revisor, "CANDADO_AVENGERS");
  assert.equal(pag.aviso, null);
});

test("el redactor de Anthropic arma la petición correcta y falla cerrado", async () => {
  assert.throws(() => redactorAnthropic({ apiKey: "" }), /REDACTOR_NO_DISPONIBLE/);
  const p = cano();
  const brief = planificarPagina(minarDemanda(p).candidatos.find((x) => x.id === "acusacion-falsa-cdmx"), p, { existentes: ["/"] });
  let peticion;
  const fetchFalso = async (url, init) => {
    peticion = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "```json\n{\"titulo\":\"t\",\"descripcion\":\"d\",\"h1\":\"h\",\"respuesta_rapida\":[],\"secciones\":[],\"faq\":[]}\n```" }] }), { status: 200 });
  };
  const r = await redactorAnthropic({ apiKey: "k", modelo: "claude-opus-5-5", fetchImpl: fetchFalso })(brief, "conocimiento");
  assert.equal(peticion.url, "https://api.anthropic.com/v1/messages");
  assert.equal(peticion.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(peticion.body.model, "claude-opus-5-5");
  assert.equal(peticion.body.output_config.format.type, "json_schema");
  assert.equal(r.titulo, "t");
  assert.equal(r._redactor, "anthropic:claude-opus-5-5");
  const rechazo = async () => new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 });
  await assert.rejects(redactorAnthropic({ apiKey: "k", fetchImpl: rechazo })(brief, ""), /REDACTOR_RECHAZO/);
  const error = async () => new Response("mal", { status: 529 });
  await assert.rejects(redactorAnthropic({ apiKey: "k", fetchImpl: error })(brief, ""), /REDACTOR_HTTP: 529/);
});

test("publicar respeta el interruptor: solo encendido publica; apagado redirige sin romper", async () => {
  const p = cano();
  const c = minarDemanda(p).candidatos.find((x) => x.id === "acusacion-falsa-cdmx");
  const aprobada = aprobar(await forjarPagina(c, p, { redactor: redactorFalso(), conocimiento: cargarConocimiento("cano"), existentes: ["/", ...p.servicios.map((s) => s.ruta)], ahora: AHORA }), { revisor: "CLIENTE", por: "Eduardo Cano", ahora: AHORA });
  const borrador = { ...aprobada, id: "otra", ruta: "/otra", estado: "BORRADOR", aprobacion: null };

  const prep = construirPaquete(p, [aprobada, borrador]);
  assert.equal(prep.publicadas.length, 0);
  assert.deepEqual(prep.redirecciones, [{ desde: "/acusacion-falsa-cdmx", hacia: "/" }]);

  const on = cambiarEstado(p, "ON", { ahora: AHORA });
  const pub = construirPaquete(on, [aprobada, borrador]);
  assert.deepEqual(pub.publicadas.map((x) => x.ruta), ["/acusacion-falsa-cdmx"], "el borrador no se publica");
  assert.equal(pub.redirecciones.length, 0);
  assert.equal(pub.publicadas[0].actualizado, "2026-10-11T12:00:00Z");
  assert.deepEqual(entradasSitemap(pub), [{ url: "https://canopenal.com/acusacion-falsa-cdmx", lastModified: "2026-10-11T12:00:00Z" }]);
  assert.ok(planEnlacesInternos(pub).length > 0);

  const editada = { ...aprobada, h1: "cambiada" };
  assert.equal(construirPaquete(on, [editada]).publicadas.length, 0, "contenido cambiado tras aprobar no se publica");
});

test("IndexNow: sin llave no envía, con llave manda el protocolo correcto, nunca URLs ajenas", async () => {
  assert.equal((await enviarIndexNow({ origen: "https://canopenal.com", llave: null, urls: ["https://canopenal.com/a"] })).estado, "NO_DISPONIBLE");
  let enviado;
  const fetchFalso = async (url, init) => { enviado = { url, body: JSON.parse(init.body) }; return new Response(null, { status: 202 }); };
  const r = await enviarIndexNow({ origen: "https://canopenal.com", llave: "a".repeat(32), urls: ["https://canopenal.com/a"], fetchImpl: fetchFalso });
  assert.equal(r.estado, "ENVIADO");
  assert.equal(enviado.url, "https://api.indexnow.org/indexnow");
  assert.deepEqual(enviado.body, { host: "canopenal.com", key: "a".repeat(32), keyLocation: `https://canopenal.com/${"a".repeat(32)}.txt`, urlList: ["https://canopenal.com/a"] });
  await assert.rejects(enviarIndexNow({ origen: "https://canopenal.com", llave: "a".repeat(32), urls: ["https://otro.mx/a"], fetchImpl: fetchFalso }), /URL_DE_OTRO_DOMINIO/);
  const r403 = await enviarIndexNow({ origen: "https://canopenal.com", llave: "a".repeat(32), urls: ["https://canopenal.com/a"], fetchImpl: async () => new Response(null, { status: 403 }) });
  assert.equal(r403.estado, "FALLO");
  assert.match(r403.motivo, /llave/);
});

test("el paquete del sitio de Cano en el repo está sincronizado con SUPERSEO", () => {
  const perfil = buscarCliente(cargarCartera(), "cano");
  const esperado = construirPaquete(perfil, cargarPaginas("cano"));
  const enRepo = JSON.parse(readFileSync(join(RAIZ, "apps", "cano-penal", "src", "superseo", "paginas.json"), "utf8"));
  assert.deepEqual(enRepo, esperado, "corre: node superseo/cli.mjs publicar cano");
  const llave = JSON.parse(readFileSync(join(RAIZ, "superseo", "clientes", "cano", "sitio.json"), "utf8")).indexnow_key;
  assert.equal(readFileSync(join(RAIZ, "apps", "cano-penal", "public", `${llave}.txt`), "utf8"), llave, "la llave de IndexNow está publicada en el sitio");
});

test("los candados revisan longitudes y enlaces aunque el contenido venga a mano", () => {
  const p = cano();
  const r = revisarPagina({ ruta: "/x", tipo: "GUIA_SITUACION", titulo: "corto", descripcion: "breve", h1: "h", respuesta_rapida: ["a"], secciones: [{ titulo: "s", parrafos: [] }], faq: [], enlaces: [{ ruta: "/no-existe", texto: "x" }], datos_locales: [], aviso: null }, { rutas: ["/"], perfil: p });
  assert.equal(r.ok, false);
  for (const patron of [/título/, /descripción/, /respuesta rápida/, /secciones sin párrafos/, /preguntas frecuentes/, /palabras/, /menos de 2 enlaces/, /no existen: \/no-existe/, /aviso/]) {
    assert.ok(r.motivos.some((m) => patron.test(m)), `detecta ${patron}`);
  }
});
