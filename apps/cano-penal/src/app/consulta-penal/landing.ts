import { site } from "../content";

/**
 * Copy for /consulta-penal, the Google Ads landing page. Every claim here already appears on the
 * home page or in the live ads (20 años exclusivamente en penal, 700+ casos, fuero común y federal,
 * ex Director de Investigaciones, atención a cualquier hora, diagnóstico de $2,500 sin tiempo
 * límite). Nothing promises an outcome. The lawyer speaks in first person, as on the rest of the site.
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
    copy: "Revisemos tu situación antes de que des el siguiente paso.",
    message: "Hola, tengo un citatorio o una orden de aprehensión y necesito orientación.",
  },
  {
    id: "me-acusan",
    title: "Me acusan de un delito",
    copy: "Entendemos la acusación y definimos tu estrategia.",
    message: "Hola, me acusan de un delito y quiero saber qué hacer.",
  },
  {
    id: "victima",
    title: "Fui víctima de un delito",
    copy: "Asesoría, representación y protección a tus derechos.",
    message: "Hola, fui víctima de un delito y necesito asesoría.",
  },
  {
    id: "otro",
    title: "Otro asunto penal",
    copy: "Cuéntame en general qué pasó y te oriento.",
    message: "Hola, tengo un asunto penal y quiero orientación.",
  },
] as const;

export const CONSULTA_STEPS = [
  ["Me escribes o me llamas.", "Cuéntame en general qué pasó. No hace falta compartir datos sensibles por escrito."],
  ["Nos vemos en el despacho.", "La asesoría presencial de diagnóstico y estrategia cuesta $2,500 y no tiene tiempo límite, porque los problemas penales son complejos."],
  ["Llevo tu defensa personalmente.", "Sin intermediarios, en cada diligencia y en cada audiencia."],
] as const;

export const CONSULTA_MAPS_URL = "https://maps.app.goo.gl/zMjF2TQZvfMchowx8";

/** Phone number as it is read aloud in Mexico, without the country code: "55 6050 1901". */
export const CONSULTA_PHONE_LABEL = site.phoneDisplay.replace(/^\+52\s*/u, "");

export const whatsappWith = (message: string) => `${site.whatsapp}?text=${encodeURIComponent(message)}`;
