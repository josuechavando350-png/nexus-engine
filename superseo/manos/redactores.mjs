// Redactores de la Forja. Un redactor recibe el plan de la página y el conocimiento
// del cliente y devuelve el contenido. Ninguno publica: todo pasa por los candados
// y, en rubros sensibles, por la aprobación humana.
import { readFileSync } from "node:fs";
import { SuperSeoError } from "../core/canonical.mjs";
import { LIMITES } from "./forja.mjs";

export const MODELO_POR_DEFECTO = "claude-opus-5-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titulo", "descripcion", "h1", "respuesta_rapida", "secciones", "faq"],
  properties: {
    titulo: { type: "string" },
    descripcion: { type: "string" },
    h1: { type: "string" },
    respuesta_rapida: { type: "array", items: { type: "string" } },
    secciones: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["titulo", "parrafos"],
        properties: { titulo: { type: "string" }, parrafos: { type: "array", items: { type: "string" } } },
      },
    },
    faq: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pregunta", "respuesta"],
        properties: { pregunta: { type: "string" }, respuesta: { type: "string" } },
      },
    },
  },
};

export function instrucciones(brief) {
  const ymyl = brief.cliente.ymyl;
  return [
    `Escribes una página web en español de México para ${brief.cliente.nombre}.`,
    "Escribe con la voz y el criterio que aparecen en el CONOCIMIENTO DEL CLIENTE: si él habla en primera persona, tú también.",
    "Reglas que no se rompen:",
    "- Usa solo hechos que estén en el CONOCIMIENTO DEL CLIENTE o en los DATOS LOCALES. Si un dato no está ahí, no lo escribas.",
    "- No escribas cifras, plazos, artículos de ley, porcentajes ni números de casos que no aparezcan textualmente en esas fuentes.",
    "- No prometas resultados: nada de \"garantizado\", \"100%\", \"siempre ganamos\", \"el mejor\", \"sin riesgo\".",
    "- No inventes casos, clientes, reseñas, testimonios ni credenciales.",
    "- Cada página debe ser útil por sí sola y distinta de cualquier otra: responde la situación concreta del plan, no repitas texto genérico.",
    ymyl ? "- Es un tema sensible: explica con claridad y prudencia, y recomienda revisar el caso concreto con el despacho." : "",
    "Forma:",
    `- titulo: ${LIMITES.titulo[0]}–${LIMITES.titulo[1]} caracteres, con la búsqueda principal.`,
    `- descripcion: ${LIMITES.descripcion[0]}–${LIMITES.descripcion[1]} caracteres, que invite a leer.`,
    `- respuesta_rapida: ${LIMITES.respuesta_rapida[0]}–${LIMITES.respuesta_rapida[1]} pasos cortos de qué hacer ahora.`,
    "- secciones: usa las SECCIONES REQUERIDAS en ese orden, cada una con 1–4 párrafos.",
    `- faq: ${LIMITES.faq[0]}–${LIMITES.faq[1]} preguntas que la gente sí hace, con respuestas directas.`,
    `- Extensión total entre ${LIMITES.palabras[0] + 100} y ${LIMITES.palabras[1] - 600} palabras.`,
    "Devuelve solo el JSON pedido.",
  ].filter(Boolean).join("\n");
}

export function mensajeUsuario(brief, conocimiento) {
  return [
    `PLAN DE LA PÁGINA\n${JSON.stringify({
      ruta: brief.ruta,
      tipo: brief.tipo,
      zona: brief.zona_nombre,
      titulo_sugerido: brief.titulo_sugerido,
      busquedas_objetivo: brief.consultas_objetivo,
      secciones_requeridas: brief.secciones_requeridas,
      preguntas_sugeridas: brief.preguntas_sugeridas,
    }, null, 2)}`,
    `DATOS LOCALES (verificados, con fuente)\n${brief.datos_locales.length ? brief.datos_locales.map((d) => `- ${d.dato} (fuente: ${d.fuente})`).join("\n") : "(ninguno)"}`,
    `CONOCIMIENTO DEL CLIENTE\n${conocimiento || "(vacío)"}`,
  ].join("\n\n");
}

function extraerJson(texto) {
  const limpio = String(texto).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio < 0 || fin <= inicio) throw new SuperSeoError("REDACTOR_SIN_JSON");
  return JSON.parse(limpio.slice(inicio, fin + 1));
}

// Redactor con la API de Anthropic. Sin ANTHROPIC_API_KEY queda NO DISPONIBLE.
export function redactorAnthropic({ apiKey = process.env.ANTHROPIC_API_KEY, modelo = process.env.SUPERSEO_MODELO || MODELO_POR_DEFECTO, fetchImpl = globalThis.fetch, maxTokens = 8000, timeoutMs = 180_000 } = {}) {
  if (!apiKey) throw new SuperSeoError("REDACTOR_NO_DISPONIBLE", "falta ANTHROPIC_API_KEY");
  return async (brief, conocimiento) => {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        max_tokens: maxTokens,
        system: instrucciones(brief),
        messages: [{ role: "user", content: mensajeUsuario(brief, conocimiento) }],
        output_config: { format: { type: "json_schema", schema: ESQUEMA } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detalle = (await res.text().catch(() => "")).slice(0, 300);
      throw new SuperSeoError("REDACTOR_HTTP", `${res.status} ${detalle}`);
    }
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new SuperSeoError("REDACTOR_RECHAZO");
    if (data.stop_reason === "max_tokens") throw new SuperSeoError("REDACTOR_INCOMPLETO", "se agotó max_tokens");
    const texto = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { ...extraerJson(texto), _redactor: `anthropic:${modelo}` };
  };
}

// Redactor manual: contenido escrito por una persona en un JSON con la misma forma.
// El archivo puede traer una sola página o varias: { "paginas": { "<id>": contenido } }.
export function redactorManual(archivo) {
  const datos = JSON.parse(readFileSync(archivo, "utf8"));
  return async (brief) => {
    if (datos && typeof datos.paginas === "object" && !Array.isArray(datos.paginas)) {
      const contenido = datos.paginas[brief.id];
      if (!contenido) throw new SuperSeoError("SIN_CONTENIDO", `${archivo} no trae ${brief.id}`);
      return { ...contenido, _redactor: "manual" };
    }
    return { ...datos, _redactor: "manual" };
  };
}

// Ids de las páginas que trae un archivo manual con varias páginas (o null si es una sola).
export function idsDelArchivoManual(archivo) {
  const datos = JSON.parse(readFileSync(archivo, "utf8"));
  return datos && typeof datos.paginas === "object" && !Array.isArray(datos.paginas) ? Object.keys(datos.paginas) : null;
}
