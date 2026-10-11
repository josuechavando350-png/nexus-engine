// Perfil de cliente SUPERSEO: validación estricta (fail-closed).
// Un campo desconocido, un tipo equivocado o un valor fuera de catálogo detiene
// todo: nunca se "adivina" un perfil a medias.
import { SuperSeoError, deepFreeze } from "./canonical.mjs";
import { ESTADOS, INSUMOS, PLANES, REVISORES, RUBROS } from "./catalogo.mjs";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ZONA = /^[a-z]{2,8}(?:-[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TELEFONO = /^\+\d{10,15}$/;

const CAMPOS = [
  "schema_version", "id", "nombre", "dominio", "rubro", "plan", "estado",
  "territorio", "servicios", "marca", "contacto", "insumos", "historial",
];

function falla(campo, detalle) {
  throw new SuperSeoError("PERFIL_INVALIDO", `${campo}: ${detalle}`);
}

function exactas(obj, claves, campo) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) falla(campo, "debe ser objeto");
  const sobran = Object.keys(obj).filter((k) => !claves.includes(k));
  const faltan = claves.filter((k) => !(k in obj));
  if (sobran.length) falla(campo, `campos desconocidos ${sobran.join(", ")}`);
  if (faltan.length) falla(campo, `faltan ${faltan.join(", ")}`);
}

function texto(valor, campo, min = 1, max = 200) {
  if (typeof valor !== "string") falla(campo, "debe ser texto");
  const t = valor.trim();
  if (t.length < min || t.length > max) falla(campo, `longitud fuera de ${min}-${max}`);
  return t;
}

function lista(valor, campo, { min = 0, max = 200 } = {}) {
  if (!Array.isArray(valor)) falla(campo, "debe ser lista");
  if (valor.length < min || valor.length > max) falla(campo, `debe tener entre ${min} y ${max} elementos`);
  return valor;
}

function unicos(valores, campo) {
  if (new Set(valores).size !== valores.length) falla(campo, "tiene repetidos");
  return valores;
}

function dominio(valor) {
  const raw = texto(valor, "dominio", 8, 120);
  let url;
  try { url = new URL(raw); } catch { falla("dominio", "no es URL"); }
  if (url.protocol !== "https:") falla("dominio", "debe usar https");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    falla("dominio", "solo origen, sin ruta");
  }
  return url.origin;
}

export function validarPerfil(raw) {
  exactas(raw, CAMPOS, "perfil");
  if (raw.schema_version !== 1) falla("schema_version", "debe ser 1");
  if (typeof raw.id !== "string" || !SLUG.test(raw.id)) falla("id", "slug inválido");
  if (!(raw.rubro in RUBROS)) falla("rubro", `desconocido (${raw.rubro})`);
  if (!(raw.plan in PLANES)) falla("plan", "debe ser BASE o TOTAL");
  if (!ESTADOS.includes(raw.estado)) falla("estado", "debe ser OFF, PREPARACION u ON");

  exactas(raw.territorio, ["especialidades", "zonas", "exclusivo"], "territorio");
  const especialidades = unicos(lista(raw.territorio.especialidades, "territorio.especialidades", { min: 1, max: 40 }), "territorio.especialidades");
  especialidades.forEach((e, i) => { if (typeof e !== "string" || !SLUG.test(e)) falla(`territorio.especialidades[${i}]`, "slug inválido"); });
  const zonas = unicos(lista(raw.territorio.zonas, "territorio.zonas", { min: 1, max: 40 }), "territorio.zonas");
  zonas.forEach((z, i) => { if (typeof z !== "string" || !ZONA.test(z)) falla(`territorio.zonas[${i}]`, "zona inválida"); });
  if (typeof raw.territorio.exclusivo !== "boolean") falla("territorio.exclusivo", "debe ser true/false");

  const servicios = lista(raw.servicios, "servicios", { max: 120 }).map((s, i) => {
    exactas(s, ["slug", "nombre", "ruta"], `servicios[${i}]`);
    if (typeof s.slug !== "string" || !SLUG.test(s.slug)) falla(`servicios[${i}].slug`, "slug inválido");
    const ruta = texto(s.ruta, `servicios[${i}].ruta`, 1, 160);
    if (!ruta.startsWith("/") || ruta.includes("..") || /\s/.test(ruta)) falla(`servicios[${i}].ruta`, "ruta inválida");
    return { slug: s.slug, nombre: texto(s.nombre, `servicios[${i}].nombre`, 2, 120), ruta };
  });
  unicos(servicios.map((s) => s.slug), "servicios.slug");

  exactas(raw.marca, ["terminos"], "marca");
  const terminos = lista(raw.marca.terminos, "marca.terminos", { min: 1, max: 20 }).map((t, i) => texto(t, `marca.terminos[${i}]`, 2, 80));

  exactas(raw.contacto, ["telefono", "whatsapp", "direccion"], "contacto");
  const { telefono, whatsapp, direccion } = raw.contacto;
  if (telefono !== null && (typeof telefono !== "string" || !TELEFONO.test(telefono))) falla("contacto.telefono", "formato +521234567890 o null");
  if (whatsapp !== null) {
    let u; try { u = new URL(whatsapp); } catch { falla("contacto.whatsapp", "no es URL"); }
    if (u.protocol !== "https:") falla("contacto.whatsapp", "debe usar https");
  }
  if (direccion !== null) texto(direccion, "contacto.direccion", 5, 300);

  exactas(raw.insumos, Object.keys(INSUMOS), "insumos");
  for (const clave of Object.keys(INSUMOS)) {
    const v = raw.insumos[clave];
    if (clave === "revisor") {
      if (v !== null && !REVISORES.includes(v)) falla("insumos.revisor", "CLIENTE, NEXUS o null");
    } else if (typeof v !== "boolean") {
      falla(`insumos.${clave}`, "debe ser true/false");
    }
  }

  const historial = lista(raw.historial, "historial", { max: 2000 }).map((h, i) => {
    exactas(h, ["en", "accion", "detalle"], `historial[${i}]`);
    if (typeof h.en !== "string" || !ISO.test(h.en)) falla(`historial[${i}].en`, "fecha ISO UTC");
    return { en: h.en, accion: texto(h.accion, `historial[${i}].accion`, 2, 40), detalle: texto(h.detalle, `historial[${i}].detalle`, 0, 300) };
  });

  return deepFreeze({
    schema_version: 1,
    id: raw.id,
    nombre: texto(raw.nombre, "nombre", 2, 120),
    dominio: dominio(raw.dominio),
    rubro: raw.rubro,
    plan: raw.plan,
    estado: raw.estado,
    territorio: { especialidades: [...especialidades], zonas: [...zonas], exclusivo: raw.territorio.exclusivo },
    servicios,
    marca: { terminos },
    contacto: { telefono, whatsapp, direccion: direccion === null ? null : direccion.trim() },
    insumos: { ...raw.insumos },
    historial,
  });
}

export function esYmyl(perfil) {
  return RUBROS[perfil.rubro].ymyl === true;
}
