// El Estratega: arma la estrategia de cada cliente con lo que haya entregado.
// Ningún insumo faltante bloquea el trabajo; cambia la fuente, el canal o la
// potencia. La única regla fija: en rubros YMYL el contenido sensible necesita
// un revisor humano antes de publicarse.
import { sha256, normalizarTexto, deepFreeze } from "./canonical.mjs";
import { INSUMOS, PLANES, RUBROS, terminosDeZona } from "./catalogo.mjs";
import { esYmyl } from "./perfil.mjs";
import { conflictosDe } from "./territorio.mjs";

function potencia(perfil) {
  const desglose = Object.entries(INSUMOS).map(([clave, def]) => {
    const presente = clave === "revisor" ? perfil.insumos.revisor !== null : perfil.insumos[clave] === true;
    return { insumo: clave, nombre: def.nombre, peso: def.peso, presente, puntos: presente ? def.peso : 0 };
  });
  const puntos = desglose.reduce((s, d) => s + d.puntos, 0);
  const nivel = puntos >= 90 ? "MAXIMA" : puntos >= 60 ? "ALTA" : puntos >= 30 ? "MEDIA" : "BAJA";
  return { puntos, max: 100, nivel, desglose };
}

function demanda(perfil) {
  if (perfil.insumos.search_console) {
    return {
      fuente: "PROPIA",
      fuentes: ["Search Console del cliente", "Keyword Planner", ...(perfil.insumos.terminos_ads ? ["Términos de búsqueda de Ads"] : [])],
      nota: "Las páginas se eligen con las búsquedas reales que ya ve Google en el sitio.",
    };
  }
  return {
    fuente: "PRESTADA",
    fuentes: ["Keyword Planner", "Sitios de la competencia (NEXUS Crawler)", "Autocompletado y preguntas relacionadas", ...(perfil.insumos.terminos_ads ? ["Términos de búsqueda de Ads"] : [])],
    nota: "Sin Search Console se arranca con demanda prestada; en cuanto llegue el acceso, los datos propios la reemplazan.",
  };
}

function voz(perfil) {
  return perfil.insumos.notas_voz
    ? { fuente: "CLIENTE", nota: "La Forja escribe con el criterio del cliente, transcrito de sus notas de voz." }
    : { fuente: "SITIO_Y_NEXUS", nota: "La Forja escribe desde lo que ya dice el sitio y lo que Nexus documente del cliente." };
}

function canales(perfil) {
  const total = perfil.plan === "TOTAL";
  const arma = RUBROS[perfil.rubro].arma;
  const c = (id, nombre, activo, motivo) => ({ id, nombre, activo, motivo });
  return [
    c("despertador", "Despertador de autoridad", true, "Siempre: recupera autoridad perdida y corrige errores técnicos."),
    c("paginas_torre", "Páginas Torre (Forja)", true, "Siempre: el motor principal de impresiones."),
    c("indexacion", "Motor de indexación", true, "Siempre: sitemaps, IndexNow y enlaces internos."),
    c("analitica", "Analítica propia", true, "Siempre: cuenta WhatsApp, llamadas y formularios por página."),
    c("videos", "Videos en página", perfil.insumos.videos, perfil.insumos.videos ? "El cliente entregó videos." : "Sin videos: las páginas salen sin video y se agregan cuando lleguen."),
    c("perfil_google", "Perfil de Google y reseñas", perfil.insumos.perfil_google, perfil.insumos.perfil_google ? "Hay acceso al perfil." : "Sin acceso al perfil: se trabaja solo el sitio."),
    c("noticias", "Noticias del rubro", total, total ? "Plan Total." : "Disponible en plan Total."),
    c("herramientas", "Herramientas que atraen enlaces", total, total ? "Plan Total." : "Disponible en plan Total."),
    c(`arma:${arma}`, `Arma de datos (${arma})`, total, total ? "Plan Total: el diferenciador que nadie más tiene." : "Disponible en plan Total."),
    c("tercer_ojo", "Tercer ojo (tendencias y competencia)", total, total ? "Plan Total." : "Disponible en plan Total."),
  ];
}

function publicacion(perfil) {
  if (!esYmyl(perfil)) {
    return {
      politica: "CANDADO_AVENGERS",
      revisor: perfil.insumos.revisor,
      sensible_en_borrador: false,
      nota: "Rubro no sensible: publica en cuanto pasa el candado de Avengers y WALLE.",
    };
  }
  const sinRevisor = perfil.insumos.revisor === null;
  return {
    politica: "REVISION_OBLIGATORIA",
    revisor: perfil.insumos.revisor,
    sensible_en_borrador: sinRevisor,
    nota: sinRevisor
      ? "Rubro sensible sin revisor asignado: el contenido legal o médico espera en borrador; arreglos técnicos, indexación, analítica y perfil avanzan sin esperar."
      : `Rubro sensible: el contenido legal o médico lo revisa ${perfil.insumos.revisor === "CLIENTE" ? "el cliente" : "Nexus"} antes de publicar.`,
  };
}

function siguientesPasos(pot) {
  return pot.desglose
    .filter((d) => !d.presente)
    .sort((a, b) => b.peso - a.peso)
    .map((d) => ({ insumo: d.insumo, pedir: d.nombre, suma_potencia: d.peso }));
}

// Términos para los Avengers, derivados solo de lo que el cliente declaró.
export function configAvengers(perfil) {
  const rubro = RUBROS[perfil.rubro];
  const n = (t) => normalizarTexto(t);
  const servicios = perfil.servicios.map((s) => n(s.nombre)).filter(Boolean);
  const zonas = perfil.territorio.zonas.flatMap((z) => terminosDeZona(z).map(n));
  const grupoServicios = Object.fromEntries(perfil.servicios.map((s) => [s.slug, [n(s.nombre)]]));
  const grupoZonas = Object.fromEntries(perfil.territorio.zonas.map((z) => [z, terminosDeZona(z).map(n)]));
  grupoZonas.cerca_de_mi = ["cerca de mi"];
  return {
    project_locale: "es-MX",
    local_brand_terms: perfil.marca.terminos.map(n),
    local_commercial_terms: rubro.comerciales.map(n),
    local_service_terms: servicios,
    local_location_terms: zonas,
    local_urgency_terms: rubro.urgencia.map(n),
    local_question_terms: ["que hacer", "como", "cuando", "cuanto cuesta", "donde"],
    local_verified_service_terms: servicios,
    local_verified_location_terms: zonas,
    local_service_groups: grupoServicios,
    local_location_groups: grupoZonas,
  };
}

export function construirEstrategia(perfil, { cartera = [] } = {}) {
  const pot = potencia(perfil);
  const plan = PLANES[perfil.plan];
  const conflictos = conflictosDe(perfil, cartera);
  const cuerpo = {
    schema_version: 1,
    cliente: perfil.id,
    nombre: perfil.nombre,
    rubro: { id: perfil.rubro, nombre: RUBROS[perfil.rubro].nombre, ymyl: esYmyl(perfil) },
    plan: { id: perfil.plan, ...plan },
    estado: perfil.estado,
    activa: perfil.estado !== "OFF",
    potencia: pot,
    demanda: demanda(perfil),
    voz: voz(perfil),
    canales: canales(perfil),
    publicacion: publicacion(perfil),
    territorio: {
      especialidades: perfil.territorio.especialidades,
      zonas: perfil.territorio.zonas,
      exclusivo: perfil.territorio.exclusivo,
      conflictos,
    },
    siguientes_pasos: siguientesPasos(pot),
    avengers_config: configAvengers(perfil),
    perfil_digest: sha256(perfil),
  };
  return deepFreeze({ ...cuerpo, estrategia_digest: sha256(cuerpo) });
}
