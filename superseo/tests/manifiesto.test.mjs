import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifiesto = JSON.parse(readFileSync(join(RAIZ, "superseo", "manifiesto.json"), "utf8"));

test("el manifiesto no promete lo que no existe", () => {
  const ids = manifiesto.componentes.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids únicos");
  for (const c of manifiesto.componentes) {
    assert.ok(c.estado in manifiesto.estados, `${c.id}: estado válido`);
    if (c.estado === "POR_CONSTRUIR") {
      assert.equal(c.ruta, undefined, `${c.id}: lo que no existe no declara ruta`);
    } else {
      assert.ok(c.ruta && existsSync(join(RAIZ, c.ruta)), `${c.id}: ${c.ruta} existe`);
    }
    for (const extra of ["puente", "base", "sitio"]) if (c[extra]) assert.ok(existsSync(join(RAIZ, c[extra])), `${c.id}: ${extra} existe`);
  }
});

test("todo módulo CONECTADO de superseo tiene pruebas que lo importan", () => {
  const dir = join(RAIZ, "superseo", "tests");
  const pruebas = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  for (const c of manifiesto.componentes.filter((x) => x.estado === "CONECTADO")) {
    const modulo = c.puente ?? c.ruta;
    if (!modulo.startsWith("superseo/") || !modulo.endsWith(".mjs")) continue;
    const archivo = modulo.replace(/^superseo\//, "../");
    assert.ok(pruebas.includes(`"${archivo}"`), `${c.id}: alguna prueba importa ${archivo}`);
  }
});

test("los workflows de SUPERSEO existen y el panel escribe en el repo", () => {
  for (const f of ["superseo.yml", "superseo-panel.yml", "superseo-forja.yml", "superseo-observatorio.yml"]) {
    assert.ok(existsSync(join(RAIZ, ".github", "workflows", f)), f);
  }
  const panel = readFileSync(join(RAIZ, ".github", "workflows", "superseo-panel.yml"), "utf8");
  assert.match(panel, /contents: write/);
  assert.match(panel, /node superseo\/cli\.mjs publicar "\$CLIENTE"/);
  // Los inputs del usuario solo entran por variables de entorno, nunca interpolados dentro de un script.
  for (const f of ["superseo.yml", "superseo-panel.yml", "superseo-forja.yml", "superseo-observatorio.yml"]) {
    const lineas = readFileSync(join(RAIZ, ".github", "workflows", f), "utf8").split("\n").filter((l) => l.includes("${{ inputs."));
    for (const l of lineas) assert.match(l, /^\s+[A-Z_]+:\s*\$\{\{\s*inputs\.[a-z_]+(\s*\|\|\s*'[^']*')?\s*\}\}\s*$/, `${f}: ${l.trim()}`);
  }
});
