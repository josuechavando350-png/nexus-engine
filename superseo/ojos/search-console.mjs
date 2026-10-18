// Conector de Google Search Console con cuenta de servicio (sin librerías).
// El cliente agrega el correo de la cuenta de servicio como usuario de su propiedad
// en Search Console; las credenciales viven en un secreto (GSC_SERVICE_ACCOUNT_JSON).
// Sin credenciales, el conector queda NO_DISPONIBLE y nada se inventa.
import { createSign } from "node:crypto";
import { SuperSeoError } from "../core/canonical.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALCANCE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3/sites";
const FILAS_POR_PAGINA = 25_000;

function b64url(texto) {
  return Buffer.from(texto).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function leerCredenciales(raw) {
  let c;
  try { c = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new SuperSeoError("CREDENCIALES_INVALIDAS", "no es JSON"); }
  if (!c || c.type !== "service_account" || typeof c.client_email !== "string" || typeof c.private_key !== "string") {
    throw new SuperSeoError("CREDENCIALES_INVALIDAS", "se espera la llave JSON de una cuenta de servicio");
  }
  return { client_email: c.client_email, private_key: c.private_key };
}

export function firmarAsercion(credenciales, ahora = new Date()) {
  const iat = Math.floor(ahora.getTime() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({ iss: credenciales.client_email, scope: ALCANCE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const firma = createSign("RSA-SHA256").update(`${cabecera}.${cuerpo}`).sign(credenciales.private_key, "base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${cabecera}.${cuerpo}.${firma}`;
}

export async function obtenerToken(credenciales, { fetchImpl = globalThis.fetch, ahora = new Date() } = {}) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: firmarAsercion(credenciales, ahora) }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") throw new SuperSeoError("TOKEN_FALLO", `${res.status} ${data.error ?? ""}`.trim());
  return data.access_token;
}

export async function consultarSearchAnalytics({ propiedad, inicio, fin, token, dimensiones = ["query", "page"], fetchImpl = globalThis.fetch, maxFilas = 100_000 }) {
  const filas = [];
  for (let startRow = 0; startRow < maxFilas; startRow += FILAS_POR_PAGINA) {
    const res = await fetchImpl(`${API}/${encodeURIComponent(propiedad)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: inicio, endDate: fin, dimensions: dimensiones, rowLimit: FILAS_POR_PAGINA, startRow, dataState: "final" }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SuperSeoError("SEARCH_CONSOLE_FALLO", `${res.status} ${data.error?.message ?? ""}`.trim());
    const lote = Array.isArray(data.rows) ? data.rows : [];
    filas.push(...lote);
    if (lote.length < FILAS_POR_PAGINA) break;
  }
  return filas;
}

// Convierte filas de Search Console al contrato de evidencia de Avengers (enteros).
export function aRegistrosAvengers(filas, origen) {
  const out = [];
  for (const f of filas) {
    const [query, pagina] = f.keys ?? [];
    if (!query || !pagina) continue;
    let ruta;
    try {
      const u = new URL(pagina, origen);
      if (u.hostname.replace(/^www\./, "") !== new URL(origen).hostname.replace(/^www\./, "")) continue;
      ruta = u.pathname;
    } catch { continue; }
    const clicks = Math.round(Number(f.clicks));
    const impressions = Math.round(Number(f.impressions));
    const position = Number(f.position);
    if (![clicks, impressions, position].every(Number.isFinite) || impressions < 0 || clicks < 0) continue;
    out.push({ query, page_url: ruta, clicks, impressions, average_position_milli: Math.max(1000, Math.round(position * 1000)) });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query) || a.page_url.localeCompare(b.page_url));
}

function fecha(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Lee los últimos `dias` días cerrados de Search Console del cliente.
 * @returns { estado: "OK" | "NO_DISPONIBLE", ... }
 */
export async function leerSearchConsole(perfil, { env = process.env, fetchImpl = globalThis.fetch, ahora = new Date(), dias = 28 } = {}) {
  const raw = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return { estado: "NO_DISPONIBLE", motivo: "falta el secreto GSC_SERVICE_ACCOUNT_JSON (cuenta de servicio con acceso a la propiedad)" };
  const credenciales = leerCredenciales(raw);
  const propiedad = env.GSC_PROPIEDAD || `sc-domain:${new URL(perfil.dominio).hostname.replace(/^www\./, "")}`;
  // Search Console publica datos finales con unos días de retraso.
  const fin = new Date(ahora.getTime() - 3 * 86_400_000);
  const inicio = new Date(fin.getTime() - (dias - 1) * 86_400_000);
  const token = await obtenerToken(credenciales, { fetchImpl, ahora });
  const filas = await consultarSearchAnalytics({ propiedad, inicio: fecha(inicio), fin: fecha(fin), token, fetchImpl });
  const registros = aRegistrosAvengers(filas, perfil.dominio);
  return {
    estado: "OK",
    propiedad,
    ventana: { inicio: fecha(inicio), fin: fecha(fin) },
    cuenta: credenciales.client_email,
    filas: filas.length,
    registros,
    totales: {
      clics: registros.reduce((s, r) => s + r.clicks, 0),
      impresiones: registros.reduce((s, r) => s + r.impressions, 0),
      consultas: new Set(registros.map((r) => r.query)).size,
    },
    nota: "Search Console no garantiza todas las filas: devuelve las principales dentro de sus límites.",
  };
}
