// Lector del paquete SUPERSEO. El archivo paginas.json lo genera
// `node superseo/cli.mjs publicar cano`; nunca se edita a mano.
// Falla cerrado: una página con forma inválida simplemente no se publica.
import paquete from "./paginas.json";

export type SuperseoSeccion = Readonly<{ titulo: string; parrafos: readonly string[] }>;
export type SuperseoFaq = Readonly<{ pregunta: string; respuesta: string }>;
export type SuperseoEnlace = Readonly<{ ruta: string; texto: string }>;
export type SuperseoDato = Readonly<{ dato: string; fuente: string }>;
export type SuperseoPagina = Readonly<{
  id: string;
  ruta: string;
  tipo: string;
  zona_nombre: string | null;
  titulo: string;
  descripcion: string;
  h1: string;
  respuesta_rapida: readonly string[];
  secciones: readonly SuperseoSeccion[];
  faq: readonly SuperseoFaq[];
  enlaces: readonly SuperseoEnlace[];
  datos_locales: readonly SuperseoDato[];
  aviso: string | null;
  actualizado: string | null;
}>;

const SEGMENTO = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

function esTexto(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

function esListaDe<T>(valor: unknown, prueba: (x: unknown) => x is T): valor is T[] {
  return Array.isArray(valor) && valor.every(prueba);
}

function esSeccion(x: unknown): x is SuperseoSeccion {
  const s = x as Record<string, unknown> | null;
  return !!s && esTexto(s.titulo) && esListaDe(s.parrafos, esTexto);
}

function esFaq(x: unknown): x is SuperseoFaq {
  const f = x as Record<string, unknown> | null;
  return !!f && esTexto(f.pregunta) && esTexto(f.respuesta);
}

function esEnlace(x: unknown): x is SuperseoEnlace {
  const e = x as Record<string, unknown> | null;
  return !!e && esTexto(e.ruta) && e.ruta.startsWith("/") && !e.ruta.startsWith("//") && esTexto(e.texto);
}

function esDato(x: unknown): x is SuperseoDato {
  const d = x as Record<string, unknown> | null;
  return !!d && esTexto(d.dato) && esTexto(d.fuente);
}

function esPagina(x: unknown): x is SuperseoPagina {
  const p = x as Record<string, unknown> | null;
  return !!p
    && esTexto(p.id) && SEGMENTO.test(p.id) && p.ruta === `/${p.id}`
    && esTexto(p.tipo) && esTexto(p.titulo) && esTexto(p.descripcion) && esTexto(p.h1)
    && esListaDe(p.respuesta_rapida, esTexto) && esListaDe(p.secciones, esSeccion)
    && esListaDe(p.faq, esFaq) && esListaDe(p.enlaces, esEnlace) && esListaDe(p.datos_locales, esDato)
    && (p.aviso === null || esTexto(p.aviso))
    && (p.zona_nombre === null || esTexto(p.zona_nombre))
    && (p.actualizado === null || esTexto(p.actualizado));
}

type Redireccion = Readonly<{ desde: string; hacia: string }>;

function esRedireccion(x: unknown): x is Redireccion {
  const r = x as Record<string, unknown> | null;
  return !!r && esTexto(r.desde) && esTexto(r.hacia) && SEGMENTO.test(r.desde.slice(1)) && r.hacia.startsWith("/") && !r.hacia.startsWith("//") && r.desde !== r.hacia;
}

const crudo = paquete as unknown as { cliente?: unknown; estado?: unknown; publicadas?: unknown; redirecciones?: unknown };
const valido = crudo.cliente === "cano";
const publicadas: readonly SuperseoPagina[] = valido && crudo.estado === "ON" && Array.isArray(crudo.publicadas) ? crudo.publicadas.filter(esPagina) : [];
const redirecciones: readonly Redireccion[] = valido && crudo.estado !== "ON" && Array.isArray(crudo.redirecciones) ? crudo.redirecciones.filter(esRedireccion) : [];

export function superseoPaginas(): readonly SuperseoPagina[] {
  return publicadas;
}

export function superseoPagina(slug: string): SuperseoPagina | null {
  return publicadas.find((p) => p.id === slug) ?? null;
}

export function superseoRedireccion(slug: string): string | null {
  return redirecciones.find((r) => r.desde === `/${slug}`)?.hacia ?? null;
}

export function superseoSlugs(): string[] {
  return [...publicadas.map((p) => p.id), ...redirecciones.map((r) => r.desde.slice(1))];
}
