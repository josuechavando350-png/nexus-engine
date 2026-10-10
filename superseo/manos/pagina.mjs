// Documento de página SUPERSEO: estructura, digest de contenido y aprobación.
// La aprobación se liga al digest del contenido exacto: si alguien cambia una coma
// después de aprobar, la aprobación deja de valer y la página vuelve a borrador.
import { SuperSeoError, sha256 } from "../core/canonical.mjs";

export const ESTADOS_PAGINA = Object.freeze(["RECHAZADA", "BORRADOR", "APROBADA"]);
export const AVISO_YMYL = "Esta página es orientación general y no sustituye la revisión de un abogado sobre su caso concreto.";

const CAMPOS_CONTENIDO = ["ruta", "titulo", "descripcion", "h1", "respuesta_rapida", "secciones", "faq", "enlaces", "datos_locales"];

export function contenidoDe(pagina) {
  return Object.fromEntries(CAMPOS_CONTENIDO.map((k) => [k, pagina[k]]));
}

export function digestContenido(pagina) {
  return sha256(contenidoDe(pagina));
}

export function textoCompleto(pagina) {
  return [
    pagina.h1,
    ...(pagina.respuesta_rapida ?? []),
    ...(pagina.secciones ?? []).flatMap((s) => [s.titulo, ...(s.parrafos ?? [])]),
    ...(pagina.faq ?? []).flatMap((f) => [f.pregunta, f.respuesta]),
    ...(pagina.datos_locales ?? []).map((d) => d.dato),
  ].filter(Boolean).join(" ");
}

export function contarPalabras(texto) {
  const t = String(texto).trim();
  return t ? t.split(/\s+/).length : 0;
}

// Estado efectivo: una APROBADA cuyo contenido cambió vuelve a BORRADOR.
export function estadoEfectivo(pagina) {
  if (pagina.estado !== "APROBADA") return pagina.estado;
  return pagina.aprobacion?.contenido_digest === digestContenido(pagina) ? "APROBADA" : "BORRADOR";
}

function comoTexto(v, campo) {
  if (typeof v !== "string" || !v.trim()) throw new SuperSeoError("PAGINA_INVALIDA", `${campo} vacío`);
  return v.trim();
}

// Normaliza la salida de un redactor a la forma de página, sin aceptar campos extraños.
export function normalizarContenido(raw) {
  if (!raw || typeof raw !== "object") throw new SuperSeoError("PAGINA_INVALIDA", "contenido no es objeto");
  const lista = (v, campo) => { if (!Array.isArray(v)) throw new SuperSeoError("PAGINA_INVALIDA", `${campo} no es lista`); return v; };
  return {
    titulo: comoTexto(raw.titulo, "titulo"),
    descripcion: comoTexto(raw.descripcion, "descripcion"),
    h1: comoTexto(raw.h1, "h1"),
    respuesta_rapida: lista(raw.respuesta_rapida, "respuesta_rapida").map((p, i) => comoTexto(p, `respuesta_rapida[${i}]`)),
    secciones: lista(raw.secciones, "secciones").map((s, i) => ({
      titulo: comoTexto(s?.titulo, `secciones[${i}].titulo`),
      parrafos: lista(s?.parrafos, `secciones[${i}].parrafos`).map((p, j) => comoTexto(p, `secciones[${i}].parrafos[${j}]`)),
    })),
    faq: lista(raw.faq, "faq").map((f, i) => ({ pregunta: comoTexto(f?.pregunta, `faq[${i}].pregunta`), respuesta: comoTexto(f?.respuesta, `faq[${i}].respuesta`) })),
  };
}

export function aprobar(pagina, { revisor, por, ahora = new Date() }) {
  if (!["CLIENTE", "NEXUS"].includes(revisor)) throw new SuperSeoError("REVISOR_INVALIDO", String(revisor));
  if (typeof por !== "string" || por.trim().length < 2) throw new SuperSeoError("APROBADOR_INVALIDO", "falta quién aprueba");
  if (!pagina.candados?.ok) throw new SuperSeoError("CANDADOS_PENDIENTES", (pagina.candados?.motivos ?? []).join("; ") || "sin validar");
  const actual = digestContenido(pagina);
  if (pagina.contenido_digest !== actual) throw new SuperSeoError("CONTENIDO_CAMBIO", "vuelve a validar la página antes de aprobarla");
  return {
    ...pagina,
    estado: "APROBADA",
    aprobacion: { revisor, por: por.trim(), en: ahora.toISOString().replace(/\.\d{3}Z$/, "Z"), contenido_digest: actual },
  };
}
