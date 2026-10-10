// Cartera: los perfiles de clientes viven como JSON versionado en superseo/clientes.
// Es el registro central v1: cada cambio queda en git y en el historial del perfil.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperSeoError } from "./canonical.mjs";
import { validarPerfil } from "./perfil.mjs";

export const DIR_CLIENTES = join(dirname(fileURLToPath(import.meta.url)), "..", "clientes");

export function cargarCartera(dir = DIR_CLIENTES) {
  const archivos = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const perfiles = archivos.map((f) => {
    const perfil = validarPerfil(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (`${perfil.id}.json` !== f) throw new SuperSeoError("ARCHIVO_NO_COINCIDE", `${f} contiene el id ${perfil.id}`);
    return perfil;
  });
  const ids = perfiles.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new SuperSeoError("IDS_REPETIDOS");
  return perfiles;
}

export function buscarCliente(cartera, id) {
  const p = cartera.find((c) => c.id === id);
  if (!p) throw new SuperSeoError("CLIENTE_NO_EXISTE", `${id}. Clientes: ${cartera.map((c) => c.id).join(", ") || "ninguno"}`);
  return p;
}

export function guardarPerfil(perfil, dir = DIR_CLIENTES) {
  const validado = validarPerfil(perfil);
  writeFileSync(join(dir, `${validado.id}.json`), `${JSON.stringify(validado, null, 2)}\n`);
  return validado;
}
