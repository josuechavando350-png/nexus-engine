import test from "node:test";
import assert from "node:assert/strict";
import { ParserCsv, detectarColumnas, procesarTextoCsv, datosLocalesDe, zonaDeAlcaldia, resolverRecurso, descargarYProcesar } from "../arma/observatorio.mjs";

function csvSintetico() {
  const filas = ["anio_hecho,mes_hecho,fecha_hecho,delito,colonia_hecho,alcaldia_hecho"];
  const delitos = ["ROBO A TRANSEUNTE EN VIA PUBLICA CON VIOLENCIA", "FRAUDE", "VIOLENCIA FAMILIAR", "AMENAZAS"];
  const colonias = ["\"SAN LORENZO, LA\"", "CENTRO", "SANTA MARTHA ACATITLA", "DESARROLLO URBANO QUETZALCOATL"];
  for (let y = 2024; y <= 2026; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      if (y === 2026 && m > 10) break;
      const extra = y === 2026 ? 2 : 0;
      for (let i = 0; i < 10 + extra; i += 1) {
        filas.push(`${y},${m},${y}-${String(m).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")},${delitos[i % 4]},${colonias[i % 4]},IZTAPALAPA`);
      }
      filas.push(`${y},${m},${y}-${String(m).padStart(2, "0")}-05,FRAUDE,CENTRO,"GUSTAVO A. MADERO"`);
      filas.push(`${y},${m},,ROBO,CENTRO,FUERA DE CDMX`);
    }
  }
  return `﻿${filas.join("\r\n")}\r\n`;
}

test("el parser CSV maneja comillas, comas, saltos de línea y comillas escapadas", () => {
  const filas = [];
  const p = new ParserCsv((f) => filas.push(f));
  p.empujar("a,\"b, c\",\"d \"\"e\"\"\"\n1,\"multi");
  p.empujar("\nlínea\",3\r\n");
  p.terminar();
  assert.deepEqual(filas, [["a", "b, c", "d \"e\""], ["1", "multi\nlínea", "3"]]);
});

test("detecta columnas de distintas versiones del dataset y falla cerrado si faltan", () => {
  assert.equal(detectarColumnas(["ao_hechos", "mes_hechos", "delito", "alcaldia_hechos"]).anio, 0);
  assert.equal(detectarColumnas(["Fecha_Hecho", "Delito", "Alcaldia_Catalogo"]).alcaldia, 2);
  assert.throws(() => detectarColumnas(["fecha_hecho", "delito"]), /alcaldía/);
  assert.throws(() => detectarColumnas(["alcaldia_hecho", "delito"]), /fecha/);
});

test("normaliza alcaldías con variantes reales de escritura", () => {
  assert.equal(zonaDeAlcaldia("GUSTAVO A. MADERO"), "cdmx-gustavo-a-madero");
  assert.equal(zonaDeAlcaldia("CUAJIMALPA DE MORELOS"), "cdmx-cuajimalpa");
  assert.equal(zonaDeAlcaldia("LA MAGDALENA CONTRERAS"), "cdmx-magdalena-contreras");
  assert.equal(zonaDeAlcaldia("Álvaro Obregón"), "cdmx-alvaro-obregon");
  assert.equal(zonaDeAlcaldia("TLALNEPANTLA"), null);
});

test("agrega por alcaldía, mes, delito y colonia, y se verifica a sí mismo", () => {
  const o = procesarTextoCsv(csvSintetico());
  assert.equal(o.corte, "2026-09", "el último mes del archivo se considera incompleto");
  assert.deepEqual(o.ventana, { desde: "2025-10", hasta: "2026-09" });
  assert.equal(o.verificacion.ok, true);
  const izt = o.zonas["cdmx-iztapalapa"];
  // oct-dic 2025: 3 meses × 10 + ene-sep 2026: 9 meses × 12 = 138
  assert.equal(izt.total_12_meses, 138);
  // oct 2024 - sep 2025: 12 meses × 10 = 120
  assert.equal(izt.total_12_meses_previos, 120);
  assert.equal(izt.cambio_pct, 15);
  assert.equal(izt.top_colonias[0].nombre.includes("SAN LORENZO, LA") || izt.top_colonias.some((c) => c.nombre === "SAN LORENZO, LA"), true);
  assert.equal(o.zonas["cdmx-gustavo-a-madero"].total_12_meses, 12);
  assert.equal(o.total_ciudad_12_meses, 150);
  assert.equal(o.filas_sin_fecha, 0);
  assert.ok(o.filas_fuera_de_catalogo > 0);
  assert.deepEqual(o.ranking.map((r) => r.zona), ["cdmx-iztapalapa", "cdmx-gustavo-a-madero"]);
  assert.equal(procesarTextoCsv(csvSintetico()).observatorio_digest, o.observatorio_digest, "determinista");
});

test("los datos locales salen con fuente, redacción neutral y cifras que el candado reconoce", () => {
  const o = procesarTextoCsv(csvSintetico());
  const datos = datosLocalesDe(o, "cdmx-iztapalapa");
  assert.equal(datos.length, 5);
  assert.match(datos[0].dato, /^Entre octubre de 2025 y septiembre de 2026, la Fiscalía General de Justicia de la Ciudad de México abrió 138 carpetas de investigación por hechos ocurridos en Iztapalapa\.$/);
  assert.match(datos[3].dato, /aumentaron 15%/);
  assert.match(datos[4].dato, /Iztapalapa concentró el 92% de las carpetas/);
  assert.ok(datos.every((d) => /FGJ CDMX.*corte septiembre de 2026/.test(d.fuente)));
  assert.ok(datos.every((d) => !/peligros|insegur|evita/i.test(d.dato)), "no estigmatiza");
  assert.deepEqual(datosLocalesDe(o, "cdmx-tlalpan"), [], "sin datos no inventa");
  assert.deepEqual(datosLocalesDe({ ...o, verificacion: { ok: false } }, "cdmx-iztapalapa"), [], "sin verificación no hay datos");
});

test("resuelve el CSV más reciente desde CKAN y procesa la descarga en streaming", async () => {
  const csv = csvSintetico();
  const fetchFalso = async (url) => {
    if (url.includes("package_show")) {
      return Response.json({ result: { resources: [
        { name: "viejo", format: "CSV", url: "https://datos/viejo.csv", last_modified: "2024-01-01T00:00:00" },
        { name: "diccionario", format: "PDF", url: "https://datos/d.pdf", last_modified: "2026-10-01T00:00:00" },
        { name: "actual", format: "CSV", url: "https://datos/actual.csv", last_modified: "2026-10-05T00:00:00" },
      ] } });
    }
    const bytes = new TextEncoder().encode(csv);
    const trozos = [bytes.slice(0, 777), bytes.slice(777, 5000), bytes.slice(5000)];
    return new Response(new ReadableStream({ start(c) { for (const t of trozos) c.enqueue(t); c.close(); } }));
  };
  const r = await resolverRecurso({ fetchImpl: fetchFalso });
  assert.equal(r.url, "https://datos/actual.csv");
  const o = await descargarYProcesar({ url: r.url, fetchImpl: fetchFalso, recurso: r });
  assert.equal(o.verificacion.ok, true);
  assert.equal(o.zonas["cdmx-iztapalapa"].total_12_meses, 138);
  assert.equal(o.recurso.nombre, "actual");
});
