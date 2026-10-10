// Almacén por cliente: conocimiento, páginas forjadas y configuración del sitio.
// superseo/clientes/<id>/conocimiento/*.md   lo que el cliente sabe y aprobó
// superseo/clientes/<id>/paginas/<pagina>.json  páginas forjadas
// superseo/clientes/<id>/sitio.json            app del repo y llave de IndexNow
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SuperSeoError } from "./canonical.mjs";
import { DIR_CLIENTES } from "./cartera.mjs";
import { estadoEfectivo, ESTADOS_PAGINA } from "../manos/pagina.mjs";

const ID_PAGINA = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export function dirCliente(id, base = DIR_CLIENTES) {
  return join(base, id);
}

export function cargarConocimiento(id, base = DIR_CLIENTES) {
  const dir = join(dirCliente(id, base), "conocimiento");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
}

export function validarDocumentoPagina(p) {
  if (!p || typeof p !== "object" || p.schema_version !== 1) throw new SuperSeoError("PAGINA_INVALIDA", "schema_version");
  if (typeof p.id !== "string" || !ID_PAGINA.test(p.id)) throw new SuperSeoError("PAGINA_INVALIDA", `id ${p.id}`);
  if (p.ruta !== `/${p.id}`) throw new SuperSeoError("PAGINA_INVALIDA", `${p.id}: la ruta debe ser /${p.id}`);
  if (!ESTADOS_PAGINA.includes(p.estado)) throw new SuperSeoError("PAGINA_INVALIDA", `${p.id}: estado ${p.estado}`);
  return p;
}

export function cargarPaginas(id, base = DIR_CLIENTES) {
  const dir = join(dirCliente(id, base), "paginas");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const p = validarDocumentoPagina(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (`${p.id}.json` !== f) throw new SuperSeoError("PAGINA_INVALIDA", `${f} contiene ${p.id}`);
    return { ...p, estado: estadoEfectivo(p) };
  });
}

export function guardarPagina(id, pagina, base = DIR_CLIENTES) {
  validarDocumentoPagina(pagina);
  const dir = join(dirCliente(id, base), "paginas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pagina.id}.json`), `${JSON.stringify(pagina, null, 2)}\n`);
  return pagina;
}

export function cargarSitio(id, base = DIR_CLIENTES) {
  const archivo = join(dirCliente(id, base), "sitio.json");
  if (!existsSync(archivo)) return null;
  const s = JSON.parse(readFileSync(archivo, "utf8"));
  if (typeof s.app !== "string" || !/^apps\/[a-z0-9-]+$/.test(s.app)) throw new SuperSeoError("SITIO_INVALIDO", "app debe ser apps/<nombre>");
  if (s.indexnow_key !== null && !/^[a-f0-9]{32}$/.test(s.indexnow_key ?? "")) throw new SuperSeoError("SITIO_INVALIDO", "indexnow_key: 32 hex o null");
  return s;
}
