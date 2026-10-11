import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { validarPerfil } from "../core/perfil.mjs";
import { leerSearchConsole, aRegistrosAvengers, leerCredenciales, firmarAsercion } from "../ojos/search-console.mjs";
import { grafoInterno } from "../ojos/grafo.mjs";
import { rastrear } from "../ojos/crawler.mjs";
import { resumirSitio, compararResumenes } from "../tercer-ojo/vigia.mjs";
import { leerFeed, detectarTemas } from "../tercer-ojo/oraculo.mjs";
import { perfilCano, sitioFalso } from "./fixtures.mjs";

const AHORA = new Date("2026-10-11T12:00:00Z");
const RELOJ = () => AHORA;

function cuentaDeServicio() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey,
    json: JSON.stringify({ type: "service_account", client_email: "superseo@proyecto.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
  };
}

test("Search Console sin credenciales queda NO_DISPONIBLE y no inventa nada", async () => {
  const r = await leerSearchConsole(validarPerfil(perfilCano()), { env: {} });
  assert.equal(r.estado, "NO_DISPONIBLE");
  assert.match(r.motivo, /GSC_SERVICE_ACCOUNT_JSON/);
  assert.throws(() => leerCredenciales("{\"type\":\"user\"}"), /cuenta de servicio/);
});

test("Search Console firma un JWT RS256 válido y convierte filas al contrato de Avengers", async () => {
  const { publicKey, json } = cuentaDeServicio();
  const asercion = firmarAsercion(leerCredenciales(json), AHORA);
  const [cab, cuerpo, firma] = asercion.split(".");
  const b64 = (s) => s.replace(/-/g, "+").replace(/_/g, "/");
  assert.ok(createVerify("RSA-SHA256").update(`${cab}.${cuerpo}`).verify(publicKey, Buffer.from(b64(firma), "base64")), "firma verificable con la llave pública");
  const claims = JSON.parse(Buffer.from(b64(cuerpo), "base64").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/webmasters.readonly");
  assert.equal(claims.exp - claims.iat, 3600);

  const llamadas = [];
  const fetchFalso = async (url, init) => {
    llamadas.push({ url, body: init.body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "tok" });
    assert.equal(init.headers.authorization, "Bearer tok");
    return Response.json({ rows: [
      { keys: ["abogado penalista cdmx", "https://canopenal.com/"], clicks: 12, impressions: 340, position: 7.25 },
      { keys: ["citatorio fiscalia", "https://www.canopenal.com/citatorio-ministerio-publico-cdmx"], clicks: 3, impressions: 90, position: 0.4 },
      { keys: ["otra", "https://otro.mx/x"], clicks: 1, impressions: 1, position: 1 },
    ] });
  };
  const r = await leerSearchConsole(validarPerfil(perfilCano()), { env: { GSC_SERVICE_ACCOUNT_JSON: json }, fetchImpl: fetchFalso, ahora: AHORA });
  assert.equal(r.estado, "OK");
  assert.equal(r.propiedad, "sc-domain:canopenal.com");
  assert.deepEqual(r.ventana, { inicio: "2026-09-11", fin: "2026-10-08" });
  assert.ok(llamadas[1].url.includes(encodeURIComponent("sc-domain:canopenal.com")));
  assert.deepEqual(r.registros, [
    { query: "abogado penalista cdmx", page_url: "/", clicks: 12, impressions: 340, average_position_milli: 7250 },
    { query: "citatorio fiscalia", page_url: "/citatorio-ministerio-publico-cdmx", clicks: 3, impressions: 90, average_position_milli: 1000 },
  ]);
  assert.deepEqual(r.totales, { clics: 15, impresiones: 430, consultas: 2 });
  assert.deepEqual(aRegistrosAvengers([{ keys: ["q"], clicks: 1, impressions: 1, position: 1 }], "https://canopenal.com"), []);
});

test("el grafo interno mide autoridad, profundidad y páginas inalcanzables", async () => {
  const s = sitioFalso();
  const snap = await rastrear({ inicio: s.origen, fetchImpl: s.fetchImpl, reloj: RELOJ });
  const g = grafoInterno(snap, { importantes: ["/contacto"] });
  assert.equal(g.nodos[0].ruta, "/", "el inicio concentra la autoridad");
  const huerfana = g.nodos.find((n) => n.ruta === "/huerfana");
  assert.equal(huerfana.entrantes, 0);
  assert.equal(huerfana.profundidad, null);
  assert.ok(g.recomendaciones.some((r) => r.ruta === "/huerfana" && r.tipo === "INALCANZABLE"));
  assert.ok(g.recomendaciones.some((r) => r.ruta === "/contacto" && r.tipo === "SERVICIO_DEBIL"));
  assert.ok(g.nodos.every((n) => n.rango_interno > 0 && n.rango_interno <= 1));
  assert.equal(grafoInterno(snap, { importantes: ["/contacto"] }).grafo_digest, g.grafo_digest);
});

test("el vigía detecta páginas nuevas, eliminadas y cambiadas", () => {
  const snap = (paginas) => ({ origen: "https://rival.mx", terminado_en: "2026-10-11T00:00:00.000Z", paginas: paginas.map(([ruta, titulo, texto]) => ({ ruta, titulo, h1: [titulo], texto, palabras: texto.split(" ").length, estado_http: 200, tipo: "text/html" })) });
  const antes = resumirSitio(snap([["/", "Inicio", "a b c"], ["/fraude", "Fraude", "texto uno"], ["/vieja", "Vieja", "x"]]));
  const primera = compararResumenes(null, antes);
  assert.equal(primera.primera_vez, true);
  const despues = resumirSitio(snap([["/", "Inicio", "a b c"], ["/fraude", "Fraude en CDMX", "texto uno más largo"], ["/iztapalapa", "Abogado en Iztapalapa", "nuevo"]]));
  const cmp = compararResumenes(antes, despues);
  assert.deepEqual(cmp.nuevas.map((n) => n.ruta), ["/iztapalapa"]);
  assert.deepEqual(cmp.eliminadas.map((n) => n.ruta), ["/vieja"]);
  assert.equal(cmp.cambiadas[0].ruta, "/fraude");
  assert.ok(cmp.cambiadas[0].cambios.some((c) => c.startsWith("título")));
  assert.equal(cmp.resumen, "1 páginas nuevas, 1 páginas cambiadas, 1 páginas eliminadas");
});

test("el oráculo lee RSS y Atom, puntúa por el rubro y no repite temas", () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Aprueban reforma al Código Nacional de Procedimientos Penales]]></title><link>https://n.mx/1</link><pubDate>Fri, 09 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Cambios en prisión preventiva&lt;/p&gt;</description></item>
    <item><title>Receta de pozole</title><link>https://n.mx/2</link><pubDate>Fri, 09 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Fiscalía CDMX abre carpeta</title><link>https://n.mx/3</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const atom = `<feed><entry><title>Suprema Corte resuelve amparo penal</title><link href="https://n.mx/4"/><updated>2026-10-10T08:00:00Z</updated><summary>Ciudad de México</summary></entry></feed>`;
  const items = [...leerFeed(rss, "rss"), ...leerFeed(atom, "atom")];
  assert.equal(items.length, 4);
  assert.equal(items[0].titulo, "Aprueban reforma al Código Nacional de Procedimientos Penales");
  assert.equal(items[0].resumen, "Cambios en prisión preventiva");
  assert.equal(items[3].enlace, "https://n.mx/4");
  const terminos = [{ termino: "código nacional de procedimientos penales", peso: 3 }, { termino: "prisión preventiva", peso: 2 }, { termino: "reforma", peso: 1 }, { termino: "amparo", peso: 1 }, { termino: "suprema corte", peso: 1 }, { termino: "fiscalía", peso: 1 }];
  const r = detectarTemas(items, { terminos, ahora: AHORA });
  assert.deepEqual(r.temas.map((t) => t.enlace), ["https://n.mx/1", "https://n.mx/4"], "sin pozole y sin noticias viejas");
  assert.equal(r.temas[0].puntaje, 6);
  const otraVez = detectarTemas(items, { terminos, ahora: AHORA, vistos: r.vistos });
  assert.equal(otraVez.total, 0, "lo ya visto no se repite");
});
