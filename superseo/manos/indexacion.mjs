// Motor de indexación: sitemap de SUPERSEO, enlaces internos e IndexNow.
// IndexNow avisa a Bing, Yandex y otros buscadores que adoptan el protocolo en cuanto
// una URL cambia. Google no lo usa: para Google cuentan el sitemap y los enlaces
// internos desde páginas que ya rastrea, y eso también lo resuelve este módulo.
import { randomBytes } from "node:crypto";
import { SuperSeoError } from "../core/canonical.mjs";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export function generarLlaveIndexNow() {
  return randomBytes(16).toString("hex");
}

export function entradasSitemap(paquete) {
  return paquete.publicadas.map((p) => ({
    url: new URL(p.ruta, paquete.origen).toString(),
    lastModified: p.actualizado,
  }));
}

// Qué páginas existentes deben enlazar a cada página nueva, para que Google la
// descubra desde páginas que ya conoce. Las huérfanas no rankean.
export function planEnlacesInternos(paquete) {
  return Object.entries(paquete.relacionadas_por_ruta)
    .map(([desde, hacia]) => ({ desde, hacia: hacia.map((h) => h.ruta).sort() }))
    .sort((a, b) => a.desde.localeCompare(b.desde));
}

export async function enviarIndexNow({ origen, llave, urls, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!llave) return { estado: "NO_DISPONIBLE", motivo: "sin llave de IndexNow en sitio.json" };
  if (!/^[a-f0-9]{32}$/.test(llave)) throw new SuperSeoError("LLAVE_INDEXNOW_INVALIDA");
  if (!urls.length) return { estado: "SIN_CAMBIOS", urls: 0 };
  const host = new URL(origen).host;
  const ajenas = urls.filter((u) => new URL(u).host !== host);
  if (ajenas.length) throw new SuperSeoError("URL_DE_OTRO_DOMINIO", ajenas[0]);
  const lote = urls.slice(0, 10_000);
  const res = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: llave, keyLocation: `${new URL(origen).origin}/${llave}.txt`, urlList: lote }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 200 y 202 son aceptación; 403 suele significar que la llave no está publicada en el sitio.
  return {
    estado: res.status === 200 || res.status === 202 ? "ENVIADO" : "FALLO",
    http: res.status,
    urls: lote.length,
    ...(res.status === 403 ? { motivo: "la llave no se encontró en el sitio; publica primero el archivo de la llave" } : {}),
  };
}
