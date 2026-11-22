/* global AdsApp, MailApp, SpreadsheetApp, DriveApp, Utilities, Logger */
const CONFIG = {
  MODO_PRUEBA: true,
  CORREO_REPORTES: "nexusbotstudio349@gmail.com",
  CPA_OBJETIVO: 250,
  PUJA_MIN: 8,
  PUJA_MAX: 28,
  MAX_NEGATIVAS_POR_DIA: 10,
  CUENTA: "173-219-7237",
  ZONA: "America/Mexico_City",
  MONEDA: "MXN",
  BITACORA: "Piloto Cano — Bitácora",
  CAMPANAS: {
    "23231143138": "CL | Leads-Search | PENAL",
    "24441409357": "CL | Amplia | PENAL"
  },
  GRUPOS: {
    "196630631948": "PENAL", "198820133422": "Me acusan",
    "199935531965": "Detenido", "200841963543": "Fraude",
    "202207553512": "Citatorio", "201650830957": "Orden de aprehensión",
    "201650834797": "Local", "202515478798": "Audiencia", "201713888293": "AMPLIA"
  },
  PRIORITARIOS: ["198820133422", "199935531965", "200841963543", "202207553512"],
  ACCIONES: ["WhatsApp - canopenal", "Clic telefono - canopenal", "Formulario web - canopenal",
    "Clicks to call", "Clics para llamar"],
  BASURA_SEGURA: [
    "robo de celular", "me robaron el celular", "me robaron mi celular", "robaron mi celular",
    "me asaltaron", "asalto a transeunte", "robo de cartera", "extorsion telefonica",
    "llamada de extorsion", "como denunciar un robo", "carta de no antecedentes",
    "constancia de no antecedentes", "antecedentes no penales", "telefono de la fiscalia",
    "horario de la fiscalia", "cita en la fiscalia", "denuncia en linea", "denuncia digital",
    "mp virtual", "constancia de extravio", "acta de extravio", "vacante", "empleo", "sueldo",
    "salario", "servicio social", "practicas profesionales", "tesis", "pdf", "examen", "maestria",
    "licenciatura en derecho", "universidad"
  ],
  PALABRAS_PROTEGIDAS: [
    "abogado", "abogados", "abogada", "penalista", "defensa", "defensor", "fraude", "despojo",
    "administracion fraudulenta", "abuso de confianza", "amparo", "orden de aprehension",
    "detenido", "detenida", "detuvieron", "citatorio", "violencia familiar", "me acusan",
    "acusado", "acusada", "me denunciaron", "denuncia en mi contra", "carpeta de investigacion",
    "audiencia", "vinculacion", "prision preventiva"
  ]
};

const DIA = 86400000;
const ENCABEZADOS = {
  Cambios: ["Fecha", "Tipo", "Campaña", "Grupo", "Término o entidad", "Antes", "Después", "Motivo", "Modo", "Estado"],
  Alertas: ["Fecha", "Tipo", "Estado"],
  Revisión: ["Fecha", "Campaña", "Búsqueda", "Clics", "Gasto MXN", "Motivo", "Modo"]
};
const AVISO_MEDICION = "Posible falla en el sitio o en la medición: revisar WhatsApp, teléfono y formulario de canopenal.com";
const CAMPOS_TRAFICO = "metrics.clicks, metrics.cost_micros";
const CAMPOS_CONTACTO = "segments.conversion_action_name, metrics.all_conversions";
const acciones = new Map(CONFIG.ACCIONES.map(a => [a.toLowerCase(), a]));

function fecha(d) { return Utilities.formatDate(d, CONFIG.ZONA, "yyyy-MM-dd"); }
function dia(c, offset) {
  // Aritmética sobre fechas civiles. La zona del servidor nunca decide qué día se consulta.
  return new Date(Date.parse(c.hoy + "T00:00:00Z") + offset * DIA).toISOString().slice(0, 10);
}
function periodo(c, inicio, fin) {
  return "segments.date BETWEEN '" + dia(c, inicio) + "' AND '" + dia(c, fin) + "'";
}
function importe(n) { return "$" + n.toLocaleString("es-MX", {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function cantidad(n) { return n.toLocaleString("es-MX", {maximumFractionDigits: 4}); }
function costoContacto(m) { return m.contactos > 0 ? importe(m.gasto / m.contactos) : "Sin contactos"; }
function limpio(s) { return String(s).normalize("NFC").toLowerCase().trim().replace(/\s+/gu, " "); }
function normal(s) { return limpio(s).normalize("NFD").replace(/[\u0300-\u036f]/gu, ""); }
// Un signo ignorado por Google no debe quitar la protección de un término con contactos.
function claveDeProteccion(s) { return normal(s).replace(/[^\p{L}\p{N}]+/gu, ""); }
function html(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function tabla(titulos, filas) {
  if (!filas.length) return "<p>Sin registros.</p>";
  return '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>' +
    titulos.map(t => "<th>" + html(t) + "</th>").join("") + "</tr></thead><tbody>" +
    filas.map(f => "<tr>" + f.map(v => "<td>" + html(v) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table>";
}
function escribir(hoja, fila, datos) {
  // Los términos de búsqueda son texto externo y jamás deben convertirse en fórmulas.
  const seguras = datos.map(r => r.map(v => typeof v === "string" && /^\s*[=+@-]/u.test(v) ? "'" + v : v));
  const faltan = fila + datos.length - 1 - hoja.getMaxRows();
  if (faltan > 0) hoja.insertRowsAfter(hoja.getMaxRows(), Math.max(faltan, 100));
  hoja.getRange(fila, 1, datos.length, datos[0].length).setValues(seguras);
}
function anexar(hoja, registro) {
  const fila = hoja.getLastRow() + 1;
  escribir(hoja, fila, [registro]);
  SpreadsheetApp.flush();
  return fila;
}
function abrirBitacora(c) {
  const it = DriveApp.getFilesByName(CONFIG.BITACORA);
  let id;
  while (it.hasNext()) {
    const f = it.next();
    if (f.getMimeType() !== "application/vnd.google-apps.spreadsheet" || f.isTrashed()) continue;
    if (id) throw new Error("Hay dos hojas con el nombre de la bitácora. Identifica la correcta.");
    id = f.getId();
  }
  const libro = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create(CONFIG.BITACORA);
  c.url = libro.getUrl();
  if (!id) {
    libro.setSpreadsheetTimeZone(CONFIG.ZONA);
    libro.getSheets()[0].setName("Cambios");
  }
  for (const [nombre, titulos] of Object.entries(ENCABEZADOS)) {
    const hoja = libro.getSheetByName(nombre) || libro.insertSheet(nombre);
    if (hoja.getLastRow() === 0) escribir(hoja, 1, [titulos]);
    else if (hoja.getRange(1, 1, 1, titulos.length).getDisplayValues()[0].join("|") !== titulos.join("|")) {
      throw new Error("Revisa los encabezados de la pestaña " + nombre);
    }
    c.hojas[nombre] = hoja;
  }
  return !id;
}
function recientes(hoja, desde, hasta = hoja.getLastRow()) {
  // Lee de atrás hacia delante. Las tres pestañas son cronológicas y se anexan al final.
  const registros = [];
  for (let fin = hasta; fin >= 2;) {
    const ini = Math.max(2, fin - 199);
    const bloque = hoja.getRange(ini, 1, fin - ini + 1, hoja.getLastColumn()).getValues();
    for (let i = bloque.length - 1; i >= 0; i--) {
      if (!(bloque[i][0] instanceof Date)) throw new Error("Fecha inválida en " + hoja.getName());
      if (bloque[i][0].getTime() < desde) return registros;
      registros.push(bloque[i]);
    }
    fin = ini - 1;
  }
  return registros;
}
function enviar(c, asunto, cuerpo) {
  const enlace = c.url || "https://drive.google.com/drive/u/0/search?q=" + encodeURIComponent(CONFIG.BITACORA);
  const etiqueta = c.url ? "Abrir bitácora" : "Buscar bitácora en Drive";
  MailApp.sendEmail({
    to: CONFIG.CORREO_REPORTES, subject: asunto,
    body: cuerpo.replace(/<\/tr>/g, "\n").replace(/<\/td>/g, "  ").replace(/<[^>]+>/g, " ") + "\n" + enlace,
    htmlBody: "<p>EDUARDO CANO | ESTRATEGIA PENAL · " + html(c.modo) + " · " + html(c.hoy) +
      "</p>" + cuerpo + '<p><a href="' + html(enlace) + '">' + etiqueta + "</a></p>"
  });
}
function fallo(c, tarea, error) {
  const mensaje = tarea + " — " + String(error.message || error);
  c.errores.push(mensaje);
  Logger.log(mensaje);
  const movimientos = c.cambios.filter(r => r[0].getTime() >= c.inicio.getTime());
  const detalle = movimientos.length ? "<h3>Movimientos de esta ejecución</h3>" +
    tabla(["Campaña", "Entidad", "Antes", "Después", "Estado"], movimientos.map(r =>
      [CONFIG.CAMPANAS[r[2]], r[4], r[5], r[6], r[9]])) : "";
  try { enviar(c, "Piloto Cano — error en " + tarea, "<p>" + html(mensaje) + "</p>" + detalle); }
  catch (otro) { Logger.log("No se pudo enviar el aviso de error: " + otro); }
}
function tarea(c, nombre, fn) {
  try { return fn(); } catch (e) { fallo(c, nombre, e); }
}
function tiempo(c) {
  if (Date.now() >= c.limite || AdsApp.getExecutionInfo().getRemainingTime() < 100) {
    throw new Error("Se agotó el tiempo reservado para procesar datos. Revisa las filas ya registradas.");
  }
}
function consultar(c, campos, recurso, filtro, leer, ids = Object.keys(CONFIG.CAMPANAS)) {
  if (!ids.length || !ids.every(id => /^\d+$/.test(id) && Object.keys(CONFIG.CAMPANAS).includes(id))) throw new Error("ID de campaña inválido");
  const query = "SELECT " + campos + " FROM " + recurso + " WHERE campaign.id IN (" + ids.join(",") +
    ")" + (filtro ? " AND " + filtro : "");
  leerFilas(c, query, leer);
}
function numero(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) throw new Error("Google devolvió un valor incompleto.");
  return Number(n);
}
function metrica() { return {clics: 0, gasto: 0, contactos: 0, acciones: new Map()}; }
function trafico(m, fila) {
  m.clics += numero(fila.metrics.clicks);
  m.gasto += numero(fila.metrics.costMicros) / 1000000;
}
function contacto(m, accion, n) {
  m.contactos += n;
  m.acciones.set(accion, (m.acciones.get(accion) || 0) + n);
}
function accionDe(r) { return acciones.get(String(r.segments.conversionActionName).toLowerCase()); }
function obtener(mapa, llave, crear) {
  if (!mapa.has(llave)) mapa.set(llave, crear());
  return mapa.get(llave);
}

function alertarUnaVez(c, tipo, mensaje) {
  if (c.preview) return; // La alerta aparece en el informe de vista previa.
  const hoja = c.hojas.Alertas;
  const recientesDelDia = recientes(hoja, c.inicio.getTime() - DIA);
  if (recientesDelDia.some(r => fecha(r[0]) === c.hoy && r[1] === tipo)) return;
  // Reservar primero impide un segundo envío si el servicio acepta el correo y después falla.
  const marca = "Envío pendiente de confirmar " + Utilities.getUuid();
  hoja.appendRow([new Date(), tipo, marca]);
  SpreadsheetApp.flush();
  const celda = hoja.createTextFinder(marca).matchEntireCell(true).findNext();
  if (!celda) throw new Error("No se pudo confirmar la reserva del aviso de " + tipo);
  enviar(c, "Piloto Cano — " + tipo, "<p>" + html(mensaje) + "</p>");
  celda.setValue("Enviada");
}
function alertaDeGasto(gastoMicros, presupuestoMicros) { return 2 * gastoMicros >= 3 * presupuestoMicros; }
function alertaDeMedicion(clics, contactos) { return clics >= 50 && contactos === 0; }
function soloSimular(prueba, preview) { return prueba !== false || preview !== false; }

function guardian(c) {
  const presupuestos = new Map();
  const vistas = new Set();
  consultar(c, "campaign.id, campaign.advertising_channel_type, campaign_budget.id, campaign_budget.amount_micros",
    "campaign", "campaign.status != REMOVED", r => {
      if (r.campaign.advertisingChannelType !== "SEARCH") throw new Error("La campaña ya no es de búsqueda.");
      vistas.add(String(r.campaign.id));
      presupuestos.set(String(r.campaignBudget.id), numero(r.campaignBudget.amountMicros));
    });
  if (vistas.size !== Object.keys(CONFIG.CAMPANAS).length) throw new Error("Falta una campaña para leer su presupuesto.");
  const base = [...presupuestos.values()].reduce((a, b) => a + b, 0);
  if (base <= 0) throw new Error("No se pudo determinar el presupuesto diario.");
  let gasto = 0;
  consultar(c, "metrics.cost_micros", "campaign", periodo(c, 0, 0), r => { gasto += numero(r.metrics.costMicros); });
  if (alertaDeGasto(gasto, base)) {
    const msg = "El gasto de hoy es " + importe(gasto / 1000000) + " y el presupuesto diario conjunto es " + importe(base / 1000000) + ".";
    c.activas.push(msg);
    alertarUnaVez(c, "Alerta de gasto", msg);
  }
}
function medicion(c, avisar) {
  let clics = 0, contactos = 0;
  const rango = periodo(c, -1, 0);
  consultar(c, "metrics.clicks", "campaign", rango, r => { clics += numero(r.metrics.clicks); });
  consultar(c, CAMPOS_CONTACTO, "campaign", rango, r => { if (accionDe(r)) contactos += numero(r.metrics.allConversions); });
  if (alertaDeMedicion(clics, contactos)) {
    c.activas.push(AVISO_MEDICION);
    if (avisar) alertarUnaVez(c, "Alerta de medición", AVISO_MEDICION);
  }
}

function rendimiento(c, recurso) {
  if (c.series.has(recurso)) return c.series.get(recurso);
  const grupo = recurso === "ad_group";
  const campos = "campaign.id, segments.date, " + (grupo ? "ad_group.id, ad_group.name, " : "");
  const rango = periodo(c, -14, -1);
  const mapa = new Map();
  function destino(r) {
    const camp = String(r.campaign.id);
    const id = grupo ? String(r.adGroup.id) : camp;
    const nombre = grupo ? (CONFIG.GRUPOS[id] || r.adGroup.name) : CONFIG.CAMPANAS[id];
    const entidad = obtener(mapa, id, () => ({nombre, camp, dias: new Map()}));
    return obtener(entidad.dias, r.segments.date, metrica);
  }
  consultar(c, campos + CAMPOS_TRAFICO, recurso, rango, r => trafico(destino(r), r));
  consultar(c, campos + CAMPOS_CONTACTO, recurso, rango, r => {
    const a = accionDe(r);
    if (a) contacto(destino(r), a, numero(r.metrics.allConversions));
  });
  for (const [id, nombre] of Object.entries(grupo ? CONFIG.GRUPOS : CONFIG.CAMPANAS)) {
    obtener(mapa, id, () => ({nombre, dias: new Map()}));
  }
  c.series.set(recurso, mapa);
  return mapa;
}
function sumar(entidades, inicio, fin) {
  const total = metrica();
  for (const e of entidades) {
    for (const [d, m] of e.dias) {
      if (d < inicio || d > fin) continue;
      total.clics += m.clics;
      total.gasto += m.gasto;
      for (const [a, n] of m.acciones) contacto(total, a, n);
    }
  }
  return total;
}
// La tolerancia sólo absorbe ruido de suma entre números positivos. Cero es exacto.
function mismaCantidad(a, b) {
  return a === b || (a > 0 && b > 0 && Math.abs(a - b) <= 16 * Number.EPSILON * Math.max(a, b));
}
function sumaTerminos(terminos) {
  let n = 0;
  for (const v of terminos.values()) n += v;
  return n;
}
function fuenteCompleta(total, fuente, contraste) {
  if (fuente.has("") || !mismaCantidad(sumaTerminos(fuente), total)) return false;
  const sumaContraste = sumaTerminos(contraste);
  if (sumaContraste > total && !mismaCantidad(sumaContraste, total)) return false;
  for (const [texto, n] of contraste) {
    const otro = fuente.get(texto) || 0;
    if (texto && otro < n && !mismaCantidad(otro, n)) return false;
  }
  return true;
}
function resolverCobertura(b) {
  // Una sola fuente debe explicar el total e incluir todos los contactos con nombre
  // que ya se vieron en la otra. Nunca sumar las dos vistas ni compensar días o acciones.
  if (b.ajusteNegativo) return null;
  if (fuenteCompleta(b.total, b.detalle, b.campaña)) return "detalle";
  if (b.leyoCampaña && fuenteCompleta(b.total, b.campaña, b.detalle)) return "campaña";
  return null;
}
function contactosBusqueda(c) {
  if (c.busquedas) return c.busquedas;
  const bloques = new Map(), protegidas = new Set(), mejores = new Map();
  const rango = periodo(c, -89, 0) + " AND metrics.all_conversions != 0";
  const campos = "campaign.id, segments.date, segments.conversion_action, " + CAMPOS_CONTACTO;
  function incorporar(r, fuente, texto) {
    const accion = accionDe(r);
    if (!accion) return;
    const camp = String(r.campaign.id), diaFila = r.segments.date, id = r.segments.conversionAction;
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(diaFila)) throw new Error("Falta la fecha o el identificador de un contacto.");
    const b = obtener(bloques, [camp, diaFila, id].join("|"), () => ({
      camp, fecha: diaFila, accion, total: 0, detalle: new Map(), campaña: new Map()
    }));
    const n = numero(r.metrics.allConversions);
    if (n < 0) b.ajusteNegativo = true;
    if (fuente === "total") { b.total += n; return; }
    const termino = limpio(texto || "");
    b[fuente].set(termino, (b[fuente].get(termino) || 0) + n);
    if (termino && n > 0) protegidas.add(claveDeProteccion(termino));
  }
  consultar(c, campos + ", search_term_view.search_term", "search_term_view", rango,
    r => incorporar(r, "detalle", r.searchTermView.searchTerm));
  consultar(c, campos, "campaign", rango, r => incorporar(r, "total"));
  const necesitan = new Set([...bloques.values()].filter(b => !resolverCobertura(b)).map(b => b.camp));
  if (necesitan.size) {
    // El informe por campaña agrega los grupos. Puede identificar contactos que el
    // informe por grupo no muestra. Un error de lectura deja la limpieza en revisión.
    const leido = tarea(c, "contraste de búsquedas por campaña", () => {
      consultar(c, campos + ", campaign_search_term_view.search_term", "campaign_search_term_view", rango,
        r => incorporar(r, "campaña", r.campaignSearchTermView.searchTerm), [...necesitan]);
      return true;
    });
    for (const b of bloques.values()) b.leyoCampaña = Boolean(leido) && necesitan.has(b.camp);
  }
  const pendientes = new Map(), desde30 = dia(c, -30);
  let recuperados = 0;
  for (const b of bloques.values()) {
    const fuente = resolverCobertura(b);
    if (!fuente) {
      const detalle = obtener(pendientes, b.camp + "|" + b.accion, () => ({
        camp: b.camp, accion: b.accion, dias: new Set(), total: 0, visibles: 0
      }));
      detalle.dias.add(b.fecha);
      detalle.total += b.total;
      detalle.visibles += sumaTerminos(b.detalle) - (b.detalle.get("") || 0);
    } else if (fuente === "campaña") recuperados++;
    if (b.fecha < desde30 || b.fecha >= c.hoy) continue;
    // Con datos incompletos el ranking sólo presenta cifras visibles del informe por grupo.
    for (const [original, n] of b[fuente || "detalle"]) {
      if (original) obtener(mejores, normal(original), () => ({original, n: 0})).n += n;
    }
  }
  c.busquedas = {protegidas, mejores, pendientes, recuperados, completo: pendientes.size === 0};
  return c.busquedas;
}
function terminosConClics(c) {
  const mapa = new Map();
  consultar(c, "campaign.id, search_term_view.search_term, " + CAMPOS_TRAFICO, "search_term_view",
    periodo(c, -30, -1) + " AND metrics.clicks > 0 AND campaign.status != REMOVED AND campaign.advertising_channel_type = SEARCH", r => {
      const camp = String(r.campaign.id), original = limpio(r.searchTermView.searchTerm), k = normal(original);
      const item = obtener(mapa, camp + "|" + k, () => ({camp, k, original, clics: 0, gasto: 0}));
      if (original !== k) item.original = original;
      trafico(item, r);
    });
  return [...mapa.values()].sort((a, b) => b.gasto - a.gasto || b.clics - a.clics || a.k.localeCompare(b.k));
}
function formasGenericas(basura = CONFIG.BASURA_SEGURA) {
  // Sólo se completa la búsqueda con expresiones genéricas conocidas. Cualquier texto
  // adicional podría ser un nombre propio o un despacho, incluso sin la palabra «abogado».
  const ortografia = {
    "asalto a transeunte": "asalto a transeúnte", "extorsion telefonica": "extorsión telefónica",
    "llamada de extorsion": "llamada de extorsión", "como denunciar un robo": "cómo denunciar un robo",
    "telefono de la fiscalia": "teléfono de la fiscalía", "horario de la fiscalia": "horario de la fiscalía",
    "cita en la fiscalia": "cita en la fiscalía", "denuncia en linea": "denuncia en línea",
    "constancia de extravio": "constancia de extravío", "acta de extravio": "acta de extravío",
    "practicas profesionales": "prácticas profesionales", "maestria": "maestría"
  };
  const mapa = new Map();
  for (const frase of basura) {
    const texto = ortografia[normal(frase)] || limpio(frase);
    for (const sufijo of ["", " cdmx", " en cdmx", " en ciudad de méxico", " en línea", " gratis"]) {
      mapa.set(normal(texto + sufijo), texto + sufijo);
    }
  }
  return mapa;
}
function leerFilas(c, query, leer) {
  tiempo(c);
  const it = AdsApp.search(query);
  let i = 0;
  while (it.hasNext()) {
    if (i++ % 250 === 0) tiempo(c);
    leer(it.next());
  }
}
function indiceNegativas() { return {exactas: new Set(), frases: new Set(), amplias: new Map()}; }
function indexarNegativa(indice, texto, tipo) {
  const t = limpio(texto);
  if (tipo === "EXACT") indice.exactas.add(t);
  else if (tipo === "PHRASE") indice.frases.add(t);
  else if (tipo === "BROAD") {
    const palabras = t.split(" ");
    obtener(indice.amplias, palabras[0], () => []).push(palabras);
  } else throw new Error("Google devolvió una concordancia negativa desconocida.");
}
function yaExcluida(indice, texto) {
  if (indice.exactas.has(texto)) return true;
  const partes = texto.split(" ");
  for (let i = 0; i < partes.length; i++) {
    for (let j = i + 1; j <= partes.length; j++) {
      if (indice.frases.has(partes.slice(i, j).join(" "))) return true;
    }
    const amplias = indice.amplias.get(partes[i]) || [];
    if (amplias.some(palabras => palabras.every(p => partes.includes(p)))) return true;
  }
  return false;
}
function negativasExistentes(c) {
  const ids = Object.keys(CONFIG.CAMPANAS);
  const indice = new Map(ids.map(id => [id, indiceNegativas()]));
  consultar(c, "campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type", "campaign_criterion",
    "campaign_criterion.negative = TRUE AND campaign_criterion.type = KEYWORD AND campaign_criterion.status != REMOVED",
    r => indexarNegativa(indice.get(String(r.campaign.id)), r.campaignCriterion.keyword.text, r.campaignCriterion.keyword.matchType));
  const listas = new Map();
  consultar(c, "campaign.id, campaign_shared_set.shared_set", "campaign_shared_set",
    "campaign_shared_set.status = ENABLED", r => {
      obtener(listas, r.campaignSharedSet.sharedSet, () => new Set()).add(String(r.campaign.id));
    });
  leerFilas(c, "SELECT customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion " +
    "WHERE customer_negative_criterion.type = NEGATIVE_KEYWORD_LIST", r => {
    listas.set(r.customerNegativeCriterion.negativeKeywordList.sharedSet, new Set(ids));
  });
  const recursos = [...listas.keys()];
  for (let i = 0; i < recursos.length; i += 50) {
    const lote = recursos.slice(i, i + 50);
    if (!lote.every(x => /^customers\/\d+\/sharedSets\/\d+$/.test(x))) throw new Error("Lista negativa sin identificador válido.");
    leerFilas(c, "SELECT shared_criterion.shared_set, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion " +
      "WHERE shared_criterion.type = KEYWORD AND shared_criterion.shared_set IN (" + lote.map(x => "'" + x + "'").join(",") + ")", r => {
      const camps = listas.get(r.sharedCriterion.sharedSet);
      if (camps) for (const id of camps) indexarNegativa(indice.get(id), r.sharedCriterion.keyword.text, r.sharedCriterion.keyword.matchType);
    });
  }
  return indice;
}
function cambio(c, tipo, camp, grupo, entidad, antes, despues, motivo, aplicar) {
  tiempo(c);
  if (!Object.keys(CONFIG.CAMPANAS).includes(camp)) throw new Error("Campaña fuera de alcance.");
  if (grupo && !Object.keys(CONFIG.GRUPOS).includes(grupo)) throw new Error("Grupo fuera de alcance.");
  const prueba = c.modo !== "REAL" || c.preview !== false || soloSimular(CONFIG.MODO_PRUEBA, AdsApp.getExecutionInfo().isPreview());
  if (!prueba && MailApp.getRemainingDailyQuota() < 1) throw new Error("No queda cupo de correo para informar el cambio.");
  const reg = [new Date(), tipo, camp, grupo, entidad, antes, despues, motivo, prueba ? "PRUEBA" : "REAL",
    prueba ? "Propuesto" : "Por confirmar"];
  if (c.preview) {
    c.cambios.push(reg); // La simulación de instalación existe sólo en este informe.
    return reg[9];
  }
  const fila = anexar(c.hojas.Cambios, reg);
  c.cambios.push(reg);
  if (!prueba) {
    // Si se interrumpe la llamada, la reserva permanece y evita una segunda modificación.
    const estado = aplicar() || "Aplicado";
    c.hojas.Cambios.getRange(fila, 10).setValue(estado);
    SpreadsheetApp.flush();
    reg[9] = estado;
  }
  return reg[9];
}
function agregarExacta(camp, texto) {
  const op = {campaignCriterionOperation: {create: {
    campaign: "customers/" + CONFIG.CUENTA.replace(/-/g, "") + "/campaigns/" + camp,
    negative: true, keyword: {text: texto, matchType: "EXACT"}
  }}};
  const duplicada = s => /DUPLICATE_KEYWORD|DUPLICATE_CRITERION|CRITERION_ALREADY_EXISTS|KEYWORD_ALREADY_EXISTS|RESOURCE_ALREADY_EXISTS|duplicate keyword|(?:criterion|keyword|resource) already exists|criterion is duplicated|ya existe|negativa duplicada/i.test(s);
  let res;
  try { res = AdsApp.mutate(op); }
  catch (e) { if (duplicada(String(e))) return "Ya existía"; throw e; }
  if (res.isSuccessful()) return "Aplicado";
  const errores = res.getErrorMessages();
  if (errores.length && errores.every(duplicada)) return "Ya existía";
  throw new Error("Google no confirmó la negativa [" + texto + "]: " + errores.join(" · "));
}
function evaluarBusqueda(t, datos, formas, palabras, existentes, reservadas, libres) {
  if (datos.protegidas.has(claveDeProteccion(t.k))) return {contacto: true, agregar: []};
  if (palabras.some(p => t.k.includes(p))) return {motivo: "Contiene una expresión protegida.", agregar: []};
  if (!datos.completo) return {motivo: "Hay contactos cuyo origen no se pudo confirmar.", agregar: []};
  if (!formas.has(t.k)) return {motivo: "Revisar intención o posible nombre de abogado o despacho.", agregar: []};
  const variantes = new Set([formas.get(t.k), t.original, t.k]);
  const agregar = [...variantes].filter(v => !yaExcluida(existentes, v) && !reservadas.has(t.camp + "|" + v));
  if (agregar.length > libres) return {motivo: "Límite diario. Las variantes se reservan juntas.", agregar: []};
  return {motivo: "Ya existe una negativa que cubre la búsqueda o hay una reserva en la bitácora.", agregar};
}
function limpiar(c) {
  const datos = contactosBusqueda(c), formas = formasGenericas();
  const terminos = terminosConClics(c), existentes = negativasExistentes(c);
  const registros = c.cambios.filter(r => fecha(r[0]) === c.hoy && r[1] === "Negativa" &&
    (r[8] === "REAL" || r[8] === c.modo) && r[9] !== "Ya existía");
  const reservadas = new Set(registros.map(r => r[2] + "|" + r[4]));
  const hechas = new Set(registros.filter(r => ["Aplicado", "Propuesto"].includes(r[9])).map(r => r[2] + "|" + normal(r[4])));
  let libres = Math.max(0, CONFIG.MAX_NEGATIVAS_POR_DIA - reservadas.size);
  if (!datos.completo) c.activas.push("Los informes de contactos no cuadran. Revisa la comprobación de 90 días.");
  const revision = [];
  const palabras = CONFIG.PALABRAS_PROTEGIDAS.map(normal);
  for (const [i, t] of terminos.entries()) {
    if (i % 250 === 0) tiempo(c);
    const indice = existentes.get(t.camp);
    const plan = evaluarBusqueda(t, datos, formas, palabras, indice, reservadas, libres);
    if (plan.contacto) continue;
    for (const v of plan.agregar) {
      const estado = cambio(c, "Negativa", t.camp, "", v, "Sin negativa exacta", "[" + v + "]",
        "Búsqueda genérica sin contactos en 90 días.", () => agregarExacta(t.camp, v));
      indexarNegativa(indice, v, "EXACT");
      if (estado !== "Ya existía") {
        libres--;
        reservadas.add(t.camp + "|" + v);
        hechas.add(t.camp + "|" + t.k);
      }
    }
    if (t.clics >= 3 && revision.length < 20 && !hechas.has(t.camp + "|" + t.k)) {
      revision.push([new Date(), t.camp, t.original, t.clics, t.gasto, plan.motivo, c.modo]);
    }
  }
  c.revision = revision;
  if (c.preview) return;
  // Una segunda ejecución programada el mismo día actualiza la lista de ese modo.
  const hoja = c.hojas.Revisión;
  const previas = recientes(hoja, c.inicio.getTime() - 2 * DIA);
  let fila = hoja.getLastRow();
  for (const r of previas) {
    if (fecha(r[0]) === c.hoy && r[6] === c.modo) hoja.deleteRow(fila);
    fila--;
  }
  if (revision.length) escribir(hoja, hoja.getLastRow() + 1, revision);
}

function reglaPuja(m, prioridad, objetivo) {
  if (m.clics < 20) return null;
  const cpa = m.contactos > 0 ? m.gasto / m.contactos : null;
  if (m.contactos >= 3 && cpa <= 0.60 * objetivo)
    return {porcentaje: 115, motivo: "Al menos 3 contactos a un costo de hasta 60% del objetivo."};
  if (m.contactos >= 2 && cpa <= 0.80 * objetivo)
    return {porcentaje: 110, motivo: "Al menos 2 contactos a un costo de hasta 80% del objetivo."};
  if (!(m.contactos === 0 && m.clics >= 30) && !(cpa !== null && cpa >= 1.60 * objetivo)) return null;
  if (prioridad) return {revisar: true, motivo: "Es prioritario."};
  return {porcentaje: 90, motivo: m.contactos === 0 ? "30 clics o más sin contactos." : "Costo de al menos 160% del objetivo."};
}
function calcularPuja(micros, porcentaje, min, max) {
  const antes = micros / 1000000;
  // El porcentaje entero conserva el medio centavo antes del redondeo.
  const centavos = Math.round(micros * porcentaje / 1000000);
  const despues = Math.max(Math.round(min * 100), Math.min(Math.round(max * 100), centavos)) / 100;
  if ((porcentaje > 100 && despues <= antes) || (porcentaje < 100 && despues >= antes)) return null;
  return despues;
}
function enEspera(r, id, ahora, inicioDia, modo) {
  if (r[1] !== "Puja" || String(r[3]) !== id) return false;
  if (r[8] === "REAL") return r[9] !== "Omitido" && ahora - r[0].getTime() < 7 * DIA;
  return r[8] === "PRUEBA" && modo === "PRUEBA" && r[0].getTime() >= inicioDia && r[0].getTime() <= ahora;
}
function ajustarPujas(c) {
  const series = rendimiento(c, "ad_group"), ids = Object.keys(CONFIG.GRUPOS);
  const inicioDia = Utilities.parseDate(c.hoy, CONFIG.ZONA, "yyyy-MM-dd").getTime();
  if (!ids.every(id => /^\d+$/.test(id))) throw new Error("ID de grupo inválido.");
  const grupos = [];
  consultar(c, "campaign.id, campaign.advertising_channel_type, campaign.bidding_strategy_type, " +
    "ad_group.id, ad_group.cpc_bid_micros", "ad_group",
    "ad_group.id IN (" + ids.join(",") + ") AND ad_group.status != REMOVED AND campaign.status != REMOVED", r => grupos.push(r));
  for (const r of grupos) {
    const id = String(r.adGroup.id), camp = String(r.campaign.id);
    const m = sumar([series.get(id)], dia(c, -14), dia(c, -1));
    const regla = reglaPuja(m, CONFIG.PRIORITARIOS.includes(id), CONFIG.CPA_OBJETIVO);
    if (!regla) continue;
    if (regla.revisar) {
      c.revisarPujas.push(CONFIG.GRUPOS[id] + " — revisar. " + regla.motivo);
      continue;
    }
    const ahora = Date.now();
    if (c.cambios.some(f => enEspera(f, id, ahora, inicioDia, c.modo))) continue;
    if (r.campaign.advertisingChannelType !== "SEARCH" || r.campaign.biddingStrategyType !== "MANUAL_CPC" ||
        !(Number(r.adGroup.cpcBidMicros) > 0)) {
      c.revisarPujas.push(CONFIG.GRUPOS[id] + " — revisar la estrategia o la puja actual.");
      continue;
    }
    const micros = numero(r.adGroup.cpcBidMicros), antes = micros / 1000000;
    const despues = calcularPuja(micros, regla.porcentaje, CONFIG.PUJA_MIN, CONFIG.PUJA_MAX);
    if (despues === null) continue;
    cambio(c, "Puja", camp, id, CONFIG.GRUPOS[id], antes, despues, regla.motivo, () => {
      const it = AdsApp.adGroups().withIds([Number(id)]).get();
      if (!it.hasNext()) throw new Error("El grupo ya no está disponible: " + id);
      const grupo = it.next();
      if (String(grupo.getCampaign().getId()) !== camp) throw new Error("Cambió la campaña del grupo " + id);
      const puja = grupo.bidding();
      if (puja.getStrategyType() !== "MANUAL_CPC" || Number(puja.getCpc()) !== antes) {
        c.revisarPujas.push(CONFIG.GRUPOS[id] + " — revisar. La puja o estrategia cambió durante la consulta.");
        return "Omitido";
      }
      grupo.bidding().setCpc(despues);
      if (Number(grupo.bidding().getCpc()) !== despues) throw new Error("Verifica la puja de " + CONFIG.GRUPOS[id] + " en el historial.");
      return "Aplicado";
    });
  }
}

function diferenciasDeTotales(campaña, grupos, nombres) {
  const diferencias = [];
  if (campaña.clics !== grupos.clics) diferencias.push("clics");
  if (Math.round(campaña.gasto * 1000000) !== Math.round(grupos.gasto * 1000000)) diferencias.push("gasto");
  for (const a of nombres) {
    if (!mismaCantidad(campaña.acciones.get(a) || 0, grupos.acciones.get(a) || 0)) diferencias.push(a);
  }
  return diferencias;
}
function filaMetricas(nombre, m) { return [nombre, importe(m.gasto), m.clics, cantidad(m.contactos), costoContacto(m)]; }
function reporte(c, semanal) {
  const campañas = rendimiento(c, "campaign"), grupos = rendimiento(c, "ad_group");
  const ayer = dia(c, -1), inicio7 = dia(c, -7);
  const semana = sumar(campañas.values(), inicio7, ayer);
  const previa = sumar(campañas.values(), dia(c, -14), dia(c, -8));
  const delDia = sumar(campañas.values(), ayer, ayer);
  const titulos = ["Periodo", "Gasto MXN", "Clics", "Contactos", "Costo por contacto"];
  let s = "<h2>" + (c.preview ? "Vista previa de todas las tareas" : semanal ? "Resumen semanal" : "Reporte diario") + "</h2>" +
    (c.preview ? "<p>Simulación con datos hasta hoy. Se evaluaron también las reglas del lunes y de las 18:00. " +
      "Las propuestas figuran sólo en este correo. Comprobaciones internas superadas: " + c.pruebas + ".</p>" : "") +
    "<p>Ayer: " + ayer + ". Semana: " + inicio7 + " al " + ayer + ".</p>" +
    tabla(titulos, [filaMetricas("Ayer", delDia), filaMetricas("7 días", semana)]) +
    "<h3>Cómo llegaron los contactos</h3>" + tabla(["Acción", "Ayer", "7 días"], CONFIG.ACCIONES.map(a =>
      [a, cantidad(delDia.acciones.get(a) || 0), cantidad(semana.acciones.get(a) || 0)]));
  if (c.preview) {
    const verificacion = [];
    for (const [id, camp] of campañas) {
      const entidades = [...grupos.values()].filter(g => g.camp === id);
      for (const [periodo, inicio] of [["Ayer", ayer], ["7 días", inicio7], ["14 días", dia(c, -14)]]) {
        const m = sumar([camp], inicio, ayer), porGrupo = sumar(entidades, inicio, ayer);
        const diferencias = diferenciasDeTotales(m, porGrupo, CONFIG.ACCIONES);
        const estado = diferencias.length ? "Revisar: " + diferencias.join(", ") :
          (m.clics || m.gasto || m.contactos ? "Cuadra" : "Sin actividad");
        verificacion.push([camp.nombre, periodo, estado]);
      }
    }
    s += "<h3>Comprobación de campañas contra la suma de sus grupos</h3>" +
      tabla(["Campaña", "Periodo", "Gasto, clics y cada acción"], verificacion);
  }
  for (const [titulo, mapa] of [["Campañas", campañas], ["Grupos de anuncios", grupos]]) {
    const filas = [];
    for (const e of mapa.values()) {
      filas.push(filaMetricas(e.nombre + " · ayer", sumar([e], ayer, ayer)),
        filaMetricas(e.nombre + " · 7 días", sumar([e], inicio7, ayer)));
    }
    s += "<h3>" + titulo + "</h3>" + tabla(["Nombre y periodo", ...titulos.slice(1)], filas);
  }
  s += "<h3>Las 10 búsquedas con más contactos en 30 días</h3>";
  if (c.busquedas) {
    const top = [...c.busquedas.mejores.values()].filter(t => t.n > 0).sort((a, b) => b.n - a.n || a.original.localeCompare(b.original)).slice(0, 10);
    s += tabla(["Búsqueda", "Contactos"], top.map(t => [t.original, cantidad(t.n)]));
    const {pendientes, recuperados} = c.busquedas;
    s += "<h3>Comprobación de los últimos 90 días</h3><p>" +
      (pendientes.size ? "Hay cifras pendientes de aclarar. Las negativas quedan en revisión." :
        "Los contactos por búsqueda cuadran con los totales de campaña.") + "</p>";
    if (recuperados) s += "<p>El informe por campaña permitió cuadrar " + recuperados +
      " combinaciones de campaña, día y acción de contacto.</p>";
    if (pendientes.size) s += tabla(["Campaña", "Acción", "Días afectados", "Contactos de campaña en esos días",
      "Contactos con búsqueda visible por grupo"], [...pendientes.values()].map(d =>
      [CONFIG.CAMPANAS[d.camp], d.accion, d.dias.size, cantidad(d.total), cantidad(d.visibles)]));
  } else s += "<p>Datos de búsquedas no disponibles.</p>";
  const hoy = c.cambios.filter(r => fecha(r[0]) === c.hoy && r[8] === c.modo);
  const negativas = hoy.filter(r => r[1] === "Negativa" && r[9] !== "Ya existía");
  s += "<h3>" + (c.modo === "PRUEBA" ? "Negativas que se agregarían" : "Negativas de hoy") + "</h3>" +
    tabla(["Campaña", "Negativa exacta", "Estado"], negativas.map(r => [CONFIG.CAMPANAS[r[2]], r[6], r[9]]));
  s += "<h3>Búsquedas para revisión</h3>" + (c.revision ? tabla(["Campaña", "Búsqueda", "Clics", "Gasto MXN", "Motivo"],
    c.revision.map(r => [CONFIG.CAMPANAS[r[1]], r[2], r[3], importe(r[4]), r[5]])) : "<p>Lista no disponible.</p>");
  s += "<h3>Alertas activas</h3>" + (c.activas.length || c.errores.length ?
    [...c.activas, ...c.errores].map(x => "<p>" + html(x) + "</p>").join("") : "<p>Ninguna.</p>");
  if (semanal) {
    const pujas = hoy.filter(r => r[1] === "Puja");
    s += "<h3>" + (c.preview ? "Simulación de las pujas del lunes" : "Pujas del lunes") + "</h3>" + tabla(["Grupo", "Antes", "Después", "Motivo", "Estado"],
      pujas.map(r => [r[4], importe(r[5]), importe(r[6]), r[7], r[9]])) +
      c.revisarPujas.map(x => "<p>" + html(x) + "</p>").join("");
    const ajustados = pujas.filter(r => ["Aplicado", "Propuesto"].includes(r[9])).map(r =>
      r[4] + " de " + importe(r[5]) + " a " + importe(r[6]));
    const n = negativas.filter(r => ["Propuesto", "Aplicado"].includes(r[9])).length;
    const comparacion = semana.contactos > 0 ? "Cada contacto costó " + costoContacto(semana) + " en promedio." :
      "Esta semana no se pudo calcular el costo por contacto.";
    s += "<h3>Para el licenciado</h3><p>En los últimos siete días registramos " + cantidad(semana.contactos) +
      " contactos. " + comparacion + " " + (previa.contactos ? "La semana anterior el promedio fue " + costoContacto(previa) +
      "." : "La semana anterior no hubo contactos para comparar.") + " " +
      (c.modo === "PRUEBA" ? "La simulación propone" : "El registro de hoy confirma") + " " + n +
      " negativas exactas y " + ajustados.length + " ajustes de puja" +
      (ajustados.length ? " (" + html(ajustados.join(", ")) + ")" : "") + "." +
      (c.errores.length ? " Hay tareas pendientes de verificación." : "") + "</p>";
  }
  enviar(c, "Piloto Cano — " + (c.preview ? "vista previa del " : semanal ? "resumen semanal del " : "reporte del ") + c.hoy, s);
}

// Casos de aceptación sobre las mismas funciones de decisión que usa el piloto.
// No hacen consultas, no envían correos y no escriben en Ads ni en la bitácora.
function comprobarReglas() {
  let casos = 0;
  function igual(caso, observado, esperado) {
    if (observado !== esperado) throw new Error("Falló la comprobación: " + caso);
    casos++;
  }
  function cobertura(total, detalle, campaña, ajusteNegativo = false) {
    return resolverCobertura({total, detalle: new Map(detalle), campaña: new Map(campaña),
      leyoCampaña: true, ajusteNegativo});
  }
  const una = [["consulta uno", 1]], dos = [...una, ["consulta dos", 1]];
  igual("dos informes del mismo contacto", cobertura(1, una, una), "detalle");
  igual("la segunda vista identifica el faltante", cobertura(2, una, dos), "campaña");
  igual("la segunda vista aclara una fila sin texto", cobertura(2, [...una, ["", 1]], dos), "campaña");
  igual("falta un contacto en ambas vistas", cobertura(3, una, dos), null);
  igual("dos vistas parciales no se suman", cobertura(2, una, [["consulta dos", 1]]), null);
  igual("coincide la suma pero cambió el término", cobertura(1, una, [["otro", 1]]), null);
  igual("el contraste excede el total", cobertura(1, una, dos), null);
  igual("cero y una fracción pequeña son distintos", cobertura(0.0000001, [], []), null);
  igual("redondeo al sumar fracciones", cobertura(0.3, [["a", 0.1], ["b", 0.2]], []), "detalle");
  igual("hay un ajuste negativo", cobertura(1, una, una, true), null);

  const formas = formasGenericas(["denuncia en linea", "empleo", "robo de celular"]);
  const indice = indiceNegativas(), reservadas = new Set(), protegidas = new Set();
  function plan(texto, libres = 10, completo = true) {
    return evaluarBusqueda({original: limpio(texto), k: normal(texto), camp: "A"}, {completo, protegidas},
      formas, ["me acusan", "fraude", "abogado"], indice, reservadas, libres);
  }
  igual("acentos y mayúsculas", plan("DENUNCIA EN LÍNEA").agregar.join("|"), "denuncia en línea|denuncia en linea");
  igual("caben exactamente dos variantes", plan("denuncia en linea", 2).agregar.length, 2);
  igual("un cupo no alcanza para dos", plan("denuncia en linea", 1).agregar.length, 0);
  igual("tope alcanzado", plan("empleo", 0).agregar.length, 0);
  igual("nombre de despacho", plan("Empleo García y Asociados").agregar.length, 0);
  igual("expresión protegida", plan("me acusan de robo de celular").motivo, "Contiene una expresión protegida.");
  igual("contacto pendiente de identificar", plan("empleo", 10, false).agregar.length, 0);
  protegidas.add(claveDeProteccion("EMPLEO."));
  igual("contacto en otra campaña con puntuación", plan("empleo").contacto, true);
  reservadas.add("A|denuncia en línea");
  igual("reserva de hoy", plan("denuncia en linea", 1).agregar.join("|"), "denuncia en linea");
  indexarNegativa(indice, "denuncia en linea", "EXACT");
  igual("negativa exacta ya existente", plan("denuncia en linea").agregar.length, 0);
  indexarNegativa(indice, "robo de celular", "PHRASE");
  igual("negativa de frase existente", plan("robo de celular en cdmx").agregar.length, 0);
  indexarNegativa(indice, "cdmx denuncia", "BROAD");
  igual("negativa amplia con orden distinto", plan("denuncia en linea cdmx").agregar.length, 0);

  function puja(clics, gasto, contactos, prioridad = false) {
    const r = reglaPuja({clics, gasto, contactos}, prioridad, 250);
    return r ? (r.revisar ? "revisar" : r.porcentaje) : null;
  }
  igual("19 clics", puja(19, 450, 3), null);
  igual("20 clics y CPA de 150", puja(20, 450, 3), 115);
  igual("por encima de 150 aplica la siguiente regla", puja(20, 450.03, 3), 110);
  igual("CPA de 200", puja(20, 400, 2), 110);
  igual("por encima de 200", puja(20, 400.02, 2), null);
  igual("29 clics sin contacto", puja(29, 850, 0), null);
  igual("30 clics sin contacto", puja(30, 850, 0), 90);
  igual("CPA de 400", puja(20, 400, 1), 90);
  igual("un grupo prioritario no baja", puja(30, 850, 0, true), "revisar");
  igual("un grupo prioritario puede subir", puja(20, 450, 3, true), 115);
  igual("redondeo a centavos", calcularPuja(13900000, 115, 8, 28), 15.99);
  igual("techo de puja", calcularPuja(27000000, 115, 8, 28), 28);
  igual("piso de puja", calcularPuja(8500000, 90, 8, 28), 8);
  igual("una subida no se convierte en bajada", calcularPuja(29000000, 115, 8, 28), null);
  const base = Date.UTC(2026, 0, 1);
  const reg = [new Date(base), "Puja", "A", "G", "", 10, 11, "", "REAL", "Por confirmar"];
  igual("faltan milisegundos para siete días", enEspera(reg, "G", base + 7 * DIA - 1, base, "REAL"), true);
  igual("siete días cumplidos", enEspera(reg, "G", base + 7 * DIA, base, "REAL"), false);
  reg[8] = "PRUEBA";
  igual("una propuesta no frena la puja real", enEspera(reg, "G", base, base, "REAL"), false);
  igual("otra prueba programada el mismo día", enEspera(reg, "G", base, base, "PRUEBA"), true);
  const camp = {clics: 20, gasto: 30.25, acciones: new Map([["WhatsApp", 2], ["Teléfono", 1]])};
  const porGrupo = {clics: 20, gasto: 30.25, acciones: new Map([["WhatsApp", 1], ["Teléfono", 2]])};
  igual("la misma suma con otra distribución por acción", diferenciasDeTotales(camp, porGrupo, ["WhatsApp", "Teléfono"]).length, 2);
  igual("gasto hasta el micro y clics exactos", diferenciasDeTotales(camp, {...camp, gasto: 30.250001, clics: 19}, []).length, 2);
  igual("gasto un micro por debajo del umbral", alertaDeGasto(149999999, 100000000), false);
  igual("gasto exactamente al 150%", alertaDeGasto(150000000, 100000000), true);
  igual("49 clics sin contacto", alertaDeMedicion(49, 0), false);
  igual("50 clics sin contacto", alertaDeMedicion(50, 0), true);
  igual("un contacto fraccionario descarta la alarma", alertaDeMedicion(50, 0.01), false);
  igual("vista previa con modo real configurado", soloSimular(false, true), true);
  igual("programación en modo de prueba", soloSimular(true, false), true);
  igual("configuración ambigua", soloSimular("false", false), true);
  igual("estado de vista previa desconocido", soloSimular(false, undefined), true);
  igual("modo real explícito fuera de vista previa", soloSimular(false, false), false);
  return casos;
}

// Google Ads llama a main por nombre al iniciar la secuencia.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function main() {
  const inicio = new Date();
  const c = {inicio, hoy: fecha(inicio), limite: inicio.getTime() + 26 * 60000, modo: "PRUEBA",
    hojas: {}, series: new Map(), cambios: [], activas: [], revisarPujas: [], errores: []};
  let lock;
  try {
    const cuenta = AdsApp.currentAccount();
    if (cuenta.getCustomerId() !== CONFIG.CUENTA || cuenta.getCurrencyCode() !== CONFIG.MONEDA ||
        cuenta.getTimeZone() !== CONFIG.ZONA) throw new Error("Comprueba el ID, la moneda y la zona horaria de la cuenta.");
    const limites = [CONFIG.PUJA_MIN, CONFIG.PUJA_MAX];
    if (!limites.every(n => Number.isFinite(n) && n > 0 && Number(n.toFixed(2)) === n) ||
        !Number.isFinite(CONFIG.CPA_OBJETIVO) || CONFIG.CPA_OBJETIVO <= 0 || CONFIG.PUJA_MAX < CONFIG.PUJA_MIN ||
        !Number.isInteger(CONFIG.MAX_NEGATIVAS_POR_DIA) || CONFIG.MAX_NEGATIVAS_POR_DIA < 0) {
      throw new Error("Revisa el objetivo, el intervalo de pujas y el límite diario de negativas.");
    }
    c.preview = AdsApp.getExecutionInfo().isPreview();
    c.modo = soloSimular(CONFIG.MODO_PRUEBA, c.preview) ? "PRUEBA" : "REAL";
    // VERIFICAR en la vista previa del instalador la disponibilidad de LockService en su entorno.
    // Evita dos envíos o dos pujas simultáneas al abrir una vista previa durante el horario.
    // Si el servicio no está disponible, la coordinación se realiza en la hoja de Alertas.
    /* global LockService */
    if (typeof LockService !== "undefined") {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) {
        if (c.preview) throw new Error("La ejecución programada está en curso. Repite la vista previa cuando termine.");
        Logger.log("Ya hay una ejecución en curso.");
        return;
      }
    }
    const libroNuevo = abrirBitacora(c);
    if (libroNuevo && !lock && c.modo === "REAL") {
      c.modo = "PRUEBA";
      c.activas.push("Se abrió una bitácora nueva sin historial. Esta primera ejecución sólo simula los cambios.");
    }
    if (c.preview && lock) {
      SpreadsheetApp.flush();
      lock.releaseLock();
      lock = null;
    }
    if (!c.preview && !lock && !reservarTurno(c)) { Logger.log("Ya hay una ejecución en curso."); return; }
    if (c.preview) c.pruebas = comprobarReglas();
    const hora = Number(Utilities.formatDate(inicio, CONFIG.ZONA, "H"));
    const lunes = new Date(c.hoy + "T00:00:00Z").getUTCDay() === 1;
    tarea(c, "guardián de gasto", () => guardian(c));
    if (hora === 18 && !c.preview) tarea(c, "medición", () => medicion(c, true));
    if (hora === 7 || c.preview) {
      tarea(c, "estado de la medición", () => medicion(c, false));
      const historial = tarea(c, "lectura de cambios", () => recientes(c.hojas.Cambios, inicio.getTime() - 8 * DIA));
      // Una vista previa parte de lo que realmente se pidió a Ads, incluidas las reservas inciertas.
      if (historial) c.cambios = c.preview ? historial.filter(r => r[8] === "REAL") : historial;
      tarea(c, "contactos por búsqueda", () => contactosBusqueda(c));
      if (historial && c.busquedas) tarea(c, "limpieza de búsquedas", () => limpiar(c));
      if ((lunes || c.preview) && historial) tarea(c, "ajuste de pujas", () => ajustarPujas(c));
      if (!c.preview) tarea(c, "reporte diario", () => reporte(c, false));
      if (lunes || c.preview) tarea(c, c.preview ? "vista previa" : "resumen semanal", () => reporte(c, true));
    }
  } catch (e) { fallo(c, "preparación del piloto", e); }
  finally {
    try {
      if (c.filaTurno) c.hojas.Alertas.getRange(c.filaTurno, 3).setValue("Terminado");
      SpreadsheetApp.flush();
    } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
  }
}
function reservarTurno(c) {
  // appendRow adjudica una fila en el servidor. Sólo la primera ejecución aún activa
  // continúa; un turno abandonado caduca después del límite de 30 minutos de Google.
  const hoja = c.hojas.Alertas, tipo = "Turno " + Utilities.getUuid();
  hoja.appendRow([new Date(), tipo, "En curso"]);
  SpreadsheetApp.flush();
  const marca = hoja.createTextFinder(tipo).matchEntireCell(true).findNext();
  if (!marca) throw new Error("No se pudo confirmar el turno de la bitácora.");
  c.filaTurno = marca.getRow();
  const anteriores = recientes(hoja, Date.now() - 31 * 60000, c.filaTurno - 1);
  return !anteriores.some(r => String(r[1]).startsWith("Turno ") && r[2] === "En curso");
}
