import { site } from "../content";

/**
 * Copy for /consulta-penal, the Google Ads landing page. Every claim here already appears on the
 * home page or in the live ads; nothing promises an outcome.
 */
export const CONSULTA_PATH = "/consulta-penal";

export const CONSULTA_SITUATIONS = [
  {
    id: "detenido",
    title: "Detuvieron a un familiar",
    copy: "Las primeras horas son las que más pesan.",
    message: "Hola, detuvieron a un familiar y necesito ayuda.",
  },
  {
    id: "citatorio-orden",
    title: "Tengo un citatorio o una orden de aprehensión",
    copy: "Lo que se hace antes de la primera audiencia define el resto del caso.",
    message: "Hola, tengo un citatorio o una orden de aprehensión y necesito orientación.",
  },
  {
    id: "me-acusan",
    title: "Me acusan de un delito",
    copy: "Revisamos tu situación y defines la estrategia de tu caso.",
    message: "Hola, me acusan de un delito y quiero saber qué hacer.",
  },
  {
    id: "otro",
    title: "Otro asunto penal",
    copy: "Cuéntame en general qué pasó y te oriento.",
    message: "Hola, tengo un asunto penal y quiero orientación.",
  },
] as const;

export const CONSULTA_PROOF = [
  ["20", "años ejerciendo exclusivamente en penal"],
  ["700+", "casos atendidos"],
  ["Común y federal", "defensa en ambos fueros"],
] as const;

export const CONSULTA_STEPS = [
  ["Me escribes o me llamas", "Cuéntame en general qué pasó. No es necesario compartir datos sensibles por escrito."],
  ["Revisamos tu situación", "Asesoría presencial de diagnóstico y estrategia por $2,500, sin tiempo límite, porque los problemas penales son complejos."],
  ["Defines tu estrategia", "Atiendo tu caso personalmente, sin intermediarios, en diligencias y audiencias."],
] as const;

/** Phone number as it is read aloud in Mexico, without the country code: "55 6050 1901". */
export const CONSULTA_PHONE_LABEL = site.phoneDisplay.replace(/^\+52\s*/u, "");

export const whatsappWith = (message: string) => `${site.whatsapp}?text=${encodeURIComponent(message)}`;
