// La Forja: convierte un candidato del Demand Miner en una página Torre.
// 1) planifica (estructura, preguntas, enlaces), 2) un redactor escribe con el
// conocimiento del cliente, 3) los candados revisan calidad, cifras sin fuente,
// promesas prohibidas y clones, 4) en rubros sensibles queda en borrador hasta
// que un revisor humano la apruebe.
import { SuperSeoError, sha256 } from "../core/canonical.mjs";
import { nombreDeZona } from "../core/catalogo.mjs";
import { esYmyl } from "../core/perfil.mjs";
import { SITUACIONES } from "../core/situaciones.mjs";
import { tejas, jaccard } from "../core/similitud.mjs";
import { AVISO_YMYL, contarPalabras, digestContenido, normalizarContenido, textoCompleto } from "./pagina.mjs";

const SECCIONES = {
  GUIA_SITUACION: ["Qué significa y por qué importa", "Qué hacer en las primeras horas", "Qué conviene no hacer", "Cómo sigue el proceso", "Cuándo buscar a un abogado"],
  SERVICIO_SITUACION: ["Qué está pasando", "Lo particular de este tipo de asunto", "Primeros pasos", "Errores comunes", "Cómo se construye la defensa"],
  TORRE_ZONA: ["Lo que dicen los datos de {zona}", "Si detienen a alguien en {zona}", "Qué hacer en las primeras horas", "Cómo se atiende un caso de {zona}", "Preguntas que hacen las familias"],
};

export const LIMITES = Object.freeze({
  titulo: [15, 65],
  descripcion: [70, 165],
  respuesta_rapida: [3, 6],
  secciones: [3, 7],
  faq: [3, 8],
  palabras: [600, 2600],
  similitud_maxima: 0.45,
  datos_locales_torre: 3,
});

const PROHIBIDAS = [
  [/garantiz/i, "promete resultados (\"garantiza\")"],
  [/\b100\s?%/i, "promete resultados (\"100%\")"],
  [/siempre gan/i, "promete resultados (\"siempre ganamos\")"],
  [/nunca perd/i, "promete resultados (\"nunca perdemos\")"],
  [/el mejor abogado|los mejores abogados/i, "superlativo no comprobable"],
  [/n[uú]mero uno/i, "superlativo no comprobable"],
  [/sin riesgo/i, "promete ausencia de riesgo"],
  [/libertad (asegurada|garantizada|segura)/i, "promete la libertad"],
  [/resultados? asegurad/i, "promete resultados"],
  [/éxito asegurado|exito asegurado/i, "promete resultados"],
];

function sustituirZona(t, zona) {
  return t.replaceAll("{zona}", nombreDeZona(zona));
}

function enlacesSugeridos(candidato, perfil, existentes) {
  const out = [];
  const servicio = perfil.servicios.find((s) => s.slug === candidato.servicio);
  if (servicio) out.push({ ruta: servicio.ruta, texto: servicio.nombre });
  const situacion = SITUACIONES[perfil.rubro].find((s) => s.slug === candidato.situacion);
  for (const sv of situacion?.servicios ?? []) {
    const s = perfil.servicios.find((x) => x.slug === sv);
    if (s && !out.some((o) => o.ruta === s.ruta)) out.push({ ruta: s.ruta, texto: s.nombre });
  }
  if (candidato.tipo === "TORRE_ZONA") {
    for (const slug of ["detenciones", "audiencia-inicial", "orden-aprehension"]) {
      const s = perfil.servicios.find((x) => x.slug === slug);
      if (s && !out.some((o) => o.ruta === s.ruta)) out.push({ ruta: s.ruta, texto: s.nombre });
    }
  }
  // Toda página necesita enlaces hacia servicios reales del cliente: completa hasta 3.
  for (const s of perfil.servicios) {
    if (out.length >= 3) break;
    if (!out.some((o) => o.ruta === s.ruta) && (!existentes.length || existentes.includes(s.ruta))) out.push({ ruta: s.ruta, texto: s.nombre });
  }
  if ((existentes.includes("/") || !existentes.length) && !out.some((o) => o.ruta === "/")) out.push({ ruta: "/", texto: perfil.nombre });
  return out.slice(0, 5);
}

export function planificarPagina(candidato, perfil, { existentes = [], datosLocales = [] } = {}) {
  if (candidato.cobertura !== "NUEVA") throw new SuperSeoError("CANDIDATO_YA_CUBIERTO", `${candidato.id} lo cubre ${candidato.cubierta_por}`);
  const secciones = (SECCIONES[candidato.tipo] ?? SECCIONES.GUIA_SITUACION).map((s) => sustituirZona(s, candidato.zona));
  const preguntas = candidato.consultas
    .filter((q) => /^(que|como|cuando|cuanto|donde|me |mi |si )/.test(q))
    .map((q) => q.charAt(0).toUpperCase() + q.slice(1) + "?");
  const brief = {
    id: candidato.id,
    ruta: candidato.ruta,
    tipo: candidato.tipo,
    servicio: candidato.servicio,
    zona: candidato.zona,
    zona_nombre: nombreDeZona(candidato.zona),
    situacion: candidato.situacion,
    titulo_sugerido: candidato.titulo,
    consultas_objetivo: candidato.consultas,
    secciones_requeridas: secciones,
    preguntas_sugeridas: preguntas,
    enlaces: enlacesSugeridos(candidato, perfil, existentes),
    datos_locales: datosLocales,
    cliente: { nombre: perfil.nombre, rubro: perfil.rubro, ymyl: esYmyl(perfil), telefono: perfil.contacto.telefono, direccion: perfil.contacto.direccion },
  };
  return { ...brief, brief_digest: sha256(brief) };
}

function numerosDe(texto) {
  return [...String(texto).matchAll(/\d[\d.,]*/g)].map((m) => m[0].replace(/[.,]$/, "").replace(/,/g, "")).filter((n) => n.length >= 2 || Number(n) >= 10);
}

// Candados de calidad. Devuelve { ok, motivos, palabras, similitud_max, parecida_a }.
export function revisarPagina(pagina, { conocimiento = "", rutas = [], textos = [], hermanas = [], perfil = null } = {}) {
  const motivos = [];
  const rango = (n, [min, max], etiqueta) => { if (n < min || n > max) motivos.push(`${etiqueta}: ${n} (debe estar entre ${min} y ${max})`); };
  rango(pagina.titulo.length, LIMITES.titulo, "título con caracteres fuera de rango");
  rango(pagina.descripcion.length, LIMITES.descripcion, "descripción con caracteres fuera de rango");
  rango(pagina.respuesta_rapida.length, LIMITES.respuesta_rapida, "pasos de respuesta rápida");
  rango(pagina.secciones.length, LIMITES.secciones, "secciones");
  rango(pagina.faq.length, LIMITES.faq, "preguntas frecuentes");
  if (pagina.secciones.some((s) => !s.parrafos.length)) motivos.push("hay secciones sin párrafos");
  if (pagina.respuesta_rapida.some((p) => p.length > 240)) motivos.push("pasos de respuesta rápida demasiado largos (máx. 240 caracteres)");

  const texto = textoCompleto(pagina);
  const palabras = contarPalabras(texto);
  rango(palabras, LIMITES.palabras, "palabras");

  for (const [patron, motivo] of PROHIBIDAS) if (patron.test(texto) || patron.test(pagina.titulo) || patron.test(pagina.descripcion)) motivos.push(`texto prohibido: ${motivo}`);

  const fuentes = `${conocimiento} ${(pagina.datos_locales ?? []).map((d) => d.dato).join(" ")} ${pagina.ruta}`;
  const permitidos = new Set(numerosDe(fuentes));
  const sinFuente = [...new Set(numerosDe(texto))].filter((n) => !permitidos.has(n));
  if (sinFuente.length) motivos.push(`cifras sin fuente en el conocimiento del cliente: ${sinFuente.slice(0, 8).join(", ")}`);

  const rutasValidas = new Set([...rutas, ...hermanas.map((h) => h.ruta)]);
  const malos = (pagina.enlaces ?? []).filter((e) => typeof e.ruta !== "string" || !e.ruta.startsWith("/") || (rutasValidas.size && !rutasValidas.has(e.ruta)));
  if ((pagina.enlaces ?? []).length < 2) motivos.push("menos de 2 enlaces internos");
  if (malos.length) motivos.push(`enlaces a rutas que no existen: ${malos.map((e) => e.ruta).join(", ")}`);

  if (pagina.tipo === "TORRE_ZONA") {
    const datos = pagina.datos_locales ?? [];
    if (datos.length < LIMITES.datos_locales_torre) motivos.push(`una Torre por zona necesita al menos ${LIMITES.datos_locales_torre} datos locales verificados (tiene ${datos.length})`);
    if (datos.some((d) => !d.fuente)) motivos.push("datos locales sin fuente");
  }

  const mias = tejas(texto);
  let similitud_max = 0;
  let parecida_a = null;
  for (const otra of [...textos, ...hermanas.map((h) => ({ ruta: h.ruta, texto: textoCompleto(h) }))]) {
    if (!otra?.texto || otra.ruta === pagina.ruta) continue;
    const s = jaccard(mias, tejas(otra.texto));
    if (s > similitud_max) { similitud_max = s; parecida_a = otra.ruta; }
  }
  similitud_max = Math.round(similitud_max * 1000) / 1000;
  if (similitud_max > LIMITES.similitud_maxima) motivos.push(`demasiado parecida a ${parecida_a} (${Math.round(similitud_max * 100)}%)`);

  if (perfil && esYmyl(perfil) && pagina.aviso !== AVISO_YMYL) motivos.push("falta el aviso de orientación general");
  return { ok: motivos.length === 0, motivos, palabras, similitud_max, parecida_a };
}

/**
 * Forja una página completa.
 * @param redactor async (brief, conocimiento) => contenido { titulo, descripcion, h1, respuesta_rapida, secciones, faq }
 * @param contexto.textosExistentes [{ ruta, texto }] páginas actuales del sitio (para el candado anti-clones)
 * @param contexto.hermanas páginas SUPERSEO ya forjadas del mismo cliente
 */
export async function forjarPagina(candidato, perfil, { redactor, conocimiento = "", existentes = [], textosExistentes = [], hermanas = [], datosLocales = [], ahora = new Date() } = {}) {
  if (typeof redactor !== "function") throw new SuperSeoError("SIN_REDACTOR");
  const brief = planificarPagina(candidato, perfil, { existentes, datosLocales });
  const crudo = await redactor(brief, conocimiento);
  const contenido = normalizarContenido(crudo);
  const pagina = {
    schema_version: 1,
    id: candidato.id,
    cliente: perfil.id,
    ruta: candidato.ruta,
    tipo: candidato.tipo,
    servicio: candidato.servicio,
    zona: candidato.zona,
    situacion: candidato.situacion,
    ...contenido,
    enlaces: brief.enlaces,
    datos_locales: datosLocales,
    aviso: esYmyl(perfil) ? AVISO_YMYL : null,
  };
  const candados = revisarPagina(pagina, { conocimiento, rutas: existentes, textos: textosExistentes, hermanas, perfil });
  const ymyl = esYmyl(perfil);
  const estado = !candados.ok ? "RECHAZADA" : (ymyl ? "BORRADOR" : "APROBADA");
  const contenido_digest = digestContenido(pagina);
  return {
    ...pagina,
    estado,
    contenido_digest,
    aprobacion: !candados.ok || ymyl ? null : { revisor: "CANDADO_AVENGERS", por: "SUPERSEO", en: ahora.toISOString().replace(/\.\d{3}Z$/, "Z"), contenido_digest },
    candados,
    origen: { redactor: crudo?._redactor ?? "desconocido", brief_digest: brief.brief_digest, generado_en: ahora.toISOString().replace(/\.\d{3}Z$/, "Z") },
  };
}

// Vuelve a pasar los candados (por ejemplo, después de editar la página a mano).
export function revalidar(pagina, perfil, { conocimiento = "", existentes = [], textosExistentes = [], hermanas = [] } = {}) {
  const candados = revisarPagina(pagina, { conocimiento, rutas: existentes, textos: textosExistentes, hermanas, perfil });
  const contenido_digest = digestContenido(pagina);
  const sigueAprobada = pagina.aprobacion?.contenido_digest === contenido_digest && candados.ok;
  return {
    ...pagina,
    candados,
    contenido_digest,
    estado: !candados.ok ? "RECHAZADA" : (sigueAprobada ? "APROBADA" : (esYmyl(perfil) ? "BORRADOR" : "APROBADA")),
    aprobacion: sigueAprobada ? pagina.aprobacion : (candados.ok && !esYmyl(perfil) ? { revisor: "CANDADO_AVENGERS", por: "SUPERSEO", en: pagina.origen?.generado_en ?? null, contenido_digest } : null),
  };
}
