// Publicación: arma el paquete que lee el sitio del cliente.
// Solo entran páginas APROBADAS con su contenido intacto, y solo si el cliente
// está ENCENDIDO. Apagado o en preparación, las páginas ya aprobadas redirigen a su
// servicio para que nunca quede una URL rota.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperSeoError, sha256 } from "../core/canonical.mjs";
import { nombreDeZona } from "../core/catalogo.mjs";
import { planDeApagado } from "../core/interruptor.mjs";
import { estadoEfectivo } from "./pagina.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ARCHIVO_PAQUETE = "src/superseo/paginas.json";

function paraSitio(p) {
  return {
    id: p.id,
    ruta: p.ruta,
    tipo: p.tipo,
    servicio: p.servicio,
    zona: p.zona,
    zona_nombre: p.zona ? nombreDeZona(p.zona) : null,
    grupo: p.grupo ?? null,
    titulo: p.titulo,
    descripcion: p.descripcion,
    h1: p.h1,
    respuesta_rapida: p.respuesta_rapida,
    secciones: p.secciones,
    faq: p.faq,
    enlaces: p.enlaces,
    datos_locales: p.datos_locales,
    aviso: p.aviso,
    actualizado: p.aprobacion?.en ?? null,
    contenido_digest: p.contenido_digest,
  };
}

export function construirPaquete(perfil, paginas) {
  const aprobadas = paginas.filter((p) => estadoEfectivo(p) === "APROBADA").sort((a, b) => a.id.localeCompare(b.id));
  const encendido = perfil.estado === "ON";
  // Un enlace hacia otra página SUPERSEO que no salió publicada se omite: nunca un enlace roto.
  const forjadas = new Set(paginas.map((p) => p.ruta));
  const vivas = new Set(encendido ? aprobadas.map((p) => p.ruta) : []);
  const publicadas = encendido
    ? aprobadas.map(paraSitio).map((p) => ({ ...p, enlaces: p.enlaces.filter((e) => !forjadas.has(e.ruta) || vivas.has(e.ruta)) }))
    : [];
  const redirecciones = encendido ? [] : planDeApagado(perfil, aprobadas.map((p) => ({ ruta: p.ruta, servicio: p.servicio }))).map(({ desde, hacia }) => ({ desde, hacia }));
  const relacionadas = {};
  for (const p of publicadas) {
    for (const e of p.enlaces) {
      if (e.ruta === "/" || e.ruta === p.ruta) continue;
      (relacionadas[e.ruta] ??= []).push({ ruta: p.ruta, titulo: p.h1 });
    }
  }
  const cuerpo = {
    schema_version: 1,
    cliente: perfil.id,
    origen: perfil.dominio,
    estado: perfil.estado,
    publicadas,
    redirecciones,
    relacionadas_por_ruta: relacionadas,
  };
  return { ...cuerpo, paquete_digest: sha256(cuerpo) };
}

export function escribirPaquete(paquete, sitio, raiz = RAIZ) {
  if (!sitio || (!sitio.app && sitio.entrega !== "ZIP")) throw new SuperSeoError("SITIO_NO_CONFIGURADO", `falta superseo/clientes/${paquete.cliente}/sitio.json`);
  // Entrega ZIP: el sitio vive fuera del repo; el paquete queda versionado junto al cliente
  // y se copia a src/superseo/paginas.json del ZIP.
  const destino = sitio.app
    ? join(raiz, sitio.app, ARCHIVO_PAQUETE)
    : join(raiz, "superseo", "clientes", paquete.cliente, "entrega", "paginas.json");
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(paquete, null, 2)}\n`);
  return destino;
}
