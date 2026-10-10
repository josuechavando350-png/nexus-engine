// Situaciones: lo que vive la persona cuando busca ayuda. El Demand Miner las
// cruza con servicios y zonas para proponer páginas que respondan búsquedas reales.
// "{zona}" se reemplaza por el nombre de la zona; "{servicio}" por el servicio.
// "cruce": solo las situaciones con cruce se combinan con cada tipo de delito.
import { deepFreeze } from "./canonical.mjs";

const PENAL = [
  { slug: "detencion", nombre: "Detuvieron a un familiar", intencion: "URGENTE", servicios: ["detenciones", "audiencia-inicial"], consultas: ["abogado para detenido en {zona}", "que hacer si detienen a un familiar en {zona}", "abogado penalista urgente {zona}"] },
  { slug: "citatorio", nombre: "Llegó un citatorio del Ministerio Público", intencion: "URGENTE", servicios: ["citatorios"], consultas: ["citatorio ministerio publico {zona}", "que hacer si me llega un citatorio de la fiscalia", "me citaron a declarar en la fiscalia"] },
  { slug: "orden-aprehension", nombre: "Hay una orden de aprehensión", intencion: "URGENTE", servicios: ["orden-aprehension", "amparo-penal"], consultas: ["orden de aprehension abogado {zona}", "como saber si tengo orden de aprehension", "amparo contra orden de aprehension"] },
  { slug: "audiencia-inicial", nombre: "Viene la audiencia inicial", intencion: "URGENTE", servicios: ["audiencia-inicial", "detenciones"], consultas: ["audiencia inicial {zona}", "que pasa en la audiencia inicial", "control de detencion audiencia"] },
  { slug: "carpeta-investigacion", nombre: "Abrieron una carpeta de investigación", cruce: "Carpeta de investigación por {servicio}", intencion: "COMERCIAL", servicios: ["*"], consultas: ["carpeta de investigacion en mi contra", "como consultar una carpeta de investigacion {zona}", "abogado carpeta de investigacion {zona}"] },
  { slug: "acusacion-falsa", nombre: "Me acusan de algo que no hice", cruce: "Acusación falsa por {servicio}", intencion: "COMERCIAL", servicios: ["*"], consultas: ["me acusan falsamente de un delito", "denuncia falsa que hacer", "abogado acusacion falsa {zona}"] },
  { slug: "denuncia", nombre: "Quiero denunciar un delito", titulo: "Cómo denunciar un delito en {zona}", intencion: "COMERCIAL", servicios: ["despojo-victimas", "delitos-patrimoniales-fraude"], consultas: ["como presentar una denuncia penal en {zona}", "abogado para victimas de delito {zona}", "asesor juridico de victima"] },
  { slug: "costo", nombre: "Cuánto cuesta la defensa", titulo: "Cuánto cuesta un abogado penalista en {zona}", intencion: "COMERCIAL", servicios: ["*"], consultas: ["cuanto cuesta un abogado penalista en {zona}", "honorarios abogado penal {zona}"] },
];

const GENERICAS = [
  { slug: "precio", nombre: "Cuánto cuesta", titulo: "Cuánto cuesta en {zona}", intencion: "COMERCIAL", servicios: ["*"], consultas: ["{servicio} precio {zona}", "cuanto cuesta {servicio} en {zona}"] },
  { slug: "cerca", nombre: "Cerca de mí", titulo: "Atención en {zona}", intencion: "COMERCIAL", servicios: ["*"], consultas: ["{servicio} en {zona}", "{servicio} cerca de mi"] },
  { slug: "urgente", nombre: "Lo necesito hoy", titulo: "Atención urgente en {zona}", intencion: "URGENTE", servicios: ["*"], consultas: ["{servicio} urgente {zona}", "{servicio} hoy {zona}"] },
];

export const SITUACIONES = deepFreeze({
  abogados_penal: PENAL,
  abogados_migratorio: GENERICAS,
  abogados_familiar: GENERICAS,
  abogados_general: GENERICAS,
  salud_dental: GENERICAS,
  salud_clinica: GENERICAS,
  inmobiliaria: GENERICAS,
  restaurante: GENERICAS,
  construccion: GENERICAS,
  comercio: GENERICAS,
});

export const PESO_INTENCION = deepFreeze({ URGENTE: 10, COMERCIAL: 7, INFORMATIVA: 4 });
