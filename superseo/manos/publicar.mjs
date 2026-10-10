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
  const publicadas = encendido ? aprobadas.map(paraSitio) : [];
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
  if (!sitio?.app) throw new SuperSeoError("SITIO_NO_CONFIGURADO", `falta superseo/clientes/${paquete.cliente}/sitio.json`);
  const destino = join(raiz, sitio.app, ARCHIVO_PAQUETE);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(paquete, null, 2)}\n`);
  return destino;
}
