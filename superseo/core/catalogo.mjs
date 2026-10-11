// Catálogo de rubros, planes, estados y zonas que SUPERSEO entiende.
// YMYL ("Your Money or Your Life"): rubros donde un dato equivocado puede dañar
// a quien lo lee. En ellos el contenido sensible exige revisión humana.
import { deepFreeze } from "./canonical.mjs";

export const RUBROS = deepFreeze({
  abogados_penal: {
    nombre: "Abogados penales",
    torre: { slug: "abogado-penal", titulo: "Abogado penalista en {zona}" },
    ymyl: true,
    arma: "observatorio-delito",
    comerciales: ["abogado", "abogado penalista", "defensa", "consulta", "despacho"],
    urgencia: ["urgente", "inmediato", "hoy", "24 horas"],
  },
  abogados_migratorio: {
    nombre: "Abogados migratorios",
    ymyl: true,
    arma: "guia-viva-tramites",
    comerciales: ["abogado", "abogado migratorio", "asesoria", "consulta", "tramite"],
    urgencia: ["urgente", "rapido", "hoy"],
  },
  abogados_familiar: {
    nombre: "Abogados familiares",
    ymyl: true,
    arma: "guia-viva-tramites",
    comerciales: ["abogado", "abogado familiar", "asesoria", "consulta", "despacho"],
    urgencia: ["urgente", "rapido", "hoy"],
  },
  abogados_general: {
    nombre: "Abogados (general)",
    ymyl: true,
    arma: "guia-viva-tramites",
    comerciales: ["abogado", "abogados", "asesoria legal", "consulta", "despacho"],
    urgencia: ["urgente", "rapido", "hoy"],
  },
  salud_dental: {
    nombre: "Clínicas dentales",
    ymyl: true,
    arma: "guia-tratamientos-costos",
    comerciales: ["dentista", "clinica dental", "consulta", "tratamiento", "precio"],
    urgencia: ["urgencia", "urgente", "hoy", "dolor"],
  },
  salud_clinica: {
    nombre: "Clínicas y salud",
    ymyl: true,
    arma: "guia-tratamientos-costos",
    comerciales: ["clinica", "doctor", "consulta", "tratamiento", "precio"],
    urgencia: ["urgencia", "urgente", "hoy"],
  },
  inmobiliaria: {
    nombre: "Inmobiliarias",
    ymyl: false,
    arma: "observatorio-precios",
    comerciales: ["casa", "departamento", "renta", "venta", "precio"],
    urgencia: ["disponible", "inmediato"],
  },
  restaurante: {
    nombre: "Restaurantes",
    ymyl: false,
    arma: "guia-gastronomica",
    comerciales: ["restaurante", "comida", "menu", "reservar", "precio"],
    urgencia: ["abierto ahora", "hoy", "a domicilio"],
  },
  construccion: {
    nombre: "Construcción y acabados",
    ymyl: false,
    arma: "calculadoras-obra",
    comerciales: ["presupuesto", "precio", "contratista", "instalacion", "cotizacion"],
    urgencia: ["urgente", "rapido"],
  },
  comercio: {
    nombre: "Tiendas y comercio",
    ymyl: false,
    arma: "guia-compra",
    comerciales: ["comprar", "precio", "tienda", "envio", "original"],
    urgencia: ["hoy", "envio rapido"],
  },
  // Agencias (Nexus Bot Studio). Sin Torres por alcaldía: una agencia no tiene datos
  // locales propios por zona, así que esas páginas serían clones con otro nombre.
  // Sus páginas salen de un portafolio curado (clientes/<id>/portafolio.json).
  agencia_web: {
    nombre: "Agencias web y tecnología",
    torre: false,
    ymyl: false,
    arma: "analizador-web",
    comerciales: ["pagina web", "diseno web", "chatbot", "google ads", "agencia", "cotizacion"],
    urgencia: ["rapido", "urgente", "esta semana"],
  },
});

export const PLANES = deepFreeze({
  BASE: { nombre: "Base", lote_inicial: 50, por_mes: 20, tope: 120 },
  TOTAL: { nombre: "Total", lote_inicial: 50, por_mes: 50, tope: 200 },
});

// OFF: sitio normal NEXUS. PREPARACION: se construye y se mide, nada nuevo se
// publica. ON: DOMINIO publica y corre el ciclo mensual.
export const ESTADOS = deepFreeze(["OFF", "PREPARACION", "ON"]);

export const INSUMOS = deepFreeze({
  search_console: { nombre: "Acceso a Search Console", peso: 25 },
  notas_voz: { nombre: "Notas de voz del cliente", peso: 20 },
  perfil_google: { nombre: "Acceso al perfil de Google", peso: 15 },
  videos: { nombre: "Videos para el sitio", peso: 15 },
  revisor: { nombre: "Revisor de contenido sensible", peso: 15 },
  terminos_ads: { nombre: "Términos de búsqueda de Ads", peso: 10 },
});

export const REVISORES = deepFreeze(["CLIENTE", "NEXUS"]);

// Zonas jerárquicas por prefijo: "cdmx" contiene a "cdmx-iztapalapa"; "mx" contiene todo.
export const ZONAS = deepFreeze({
  mx: ["mexico"],
  cdmx: ["cdmx", "ciudad de mexico"],
  edomex: ["estado de mexico", "edomex"],
  "cdmx-alvaro-obregon": ["alvaro obregon"],
  "cdmx-azcapotzalco": ["azcapotzalco"],
  "cdmx-benito-juarez": ["benito juarez"],
  "cdmx-coyoacan": ["coyoacan"],
  "cdmx-cuajimalpa": ["cuajimalpa"],
  "cdmx-cuauhtemoc": ["cuauhtemoc"],
  "cdmx-gustavo-a-madero": ["gustavo a madero", "gam"],
  "cdmx-iztacalco": ["iztacalco"],
  "cdmx-iztapalapa": ["iztapalapa"],
  "cdmx-magdalena-contreras": ["magdalena contreras"],
  "cdmx-miguel-hidalgo": ["miguel hidalgo", "polanco"],
  "cdmx-milpa-alta": ["milpa alta"],
  "cdmx-tlahuac": ["tlahuac"],
  "cdmx-tlalpan": ["tlalpan"],
  "cdmx-venustiano-carranza": ["venustiano carranza"],
  "cdmx-xochimilco": ["xochimilco"],
});

// Nombre con acentos para mostrar al lector.
export const NOMBRES_ZONA = deepFreeze({
  mx: "México",
  cdmx: "CDMX",
  edomex: "Estado de México",
  "cdmx-alvaro-obregon": "Álvaro Obregón",
  "cdmx-azcapotzalco": "Azcapotzalco",
  "cdmx-benito-juarez": "Benito Juárez",
  "cdmx-coyoacan": "Coyoacán",
  "cdmx-cuajimalpa": "Cuajimalpa",
  "cdmx-cuauhtemoc": "Cuauhtémoc",
  "cdmx-gustavo-a-madero": "Gustavo A. Madero",
  "cdmx-iztacalco": "Iztacalco",
  "cdmx-iztapalapa": "Iztapalapa",
  "cdmx-magdalena-contreras": "La Magdalena Contreras",
  "cdmx-miguel-hidalgo": "Miguel Hidalgo",
  "cdmx-milpa-alta": "Milpa Alta",
  "cdmx-tlahuac": "Tláhuac",
  "cdmx-tlalpan": "Tlalpan",
  "cdmx-venustiano-carranza": "Venustiano Carranza",
  "cdmx-xochimilco": "Xochimilco",
});

export function nombreDeZona(zona) {
  return NOMBRES_ZONA[zona] ?? zona.replace(/^[a-z]+-/, "").split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

// Subzonas conocidas de una zona (cdmx → sus 16 alcaldías). Sin subzonas, la zona misma.
export function subzonas(zona) {
  const hijas = Object.keys(ZONAS).filter((z) => z.startsWith(`${zona}-`));
  return hijas.length ? hijas : [zona];
}

export function terminosDeZona(zona) {
  return ZONAS[zona] ?? [zona.replace(/^[a-z]+-/, "").replace(/-/g, " ")];
}

export function zonasSeTraslapan(a, b) {
  if (a === b || a === "mx" || b === "mx") return true;
  return a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}
