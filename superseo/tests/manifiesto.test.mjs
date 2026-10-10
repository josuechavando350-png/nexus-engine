import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    if (c.puente) assert.ok(existsSync(join(RAIZ, c.puente)), `${c.id}: puente existe`);
    if (c.base) assert.ok(existsSync(join(RAIZ, c.base)), `${c.id}: base existe`);
  }
});

test("todo lo CONECTADO dentro de superseo tiene pruebas que lo importan", () => {
  const pruebas = ["nucleo", "ojos", "cerebro"].map((f) => readFileSync(join(RAIZ, "superseo", "tests", `${f}.test.mjs`), "utf8")).join("\n");
  for (const c of manifiesto.componentes.filter((x) => x.estado === "CONECTADO")) {
    const archivo = (c.puente ?? c.ruta).replace(/^superseo\//, "../");
    assert.ok(pruebas.includes(archivo), `${c.id}: alguna prueba importa ${archivo}`);
  }
});
