// Explicit neutral demo copy. This does not infer replacement text for unknown websites.
// node validation/daksh/prepare-demo.mjs CATALOG BASE_SITE PLAN_OUTPUT COVERAGE_OUTPUT
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "parse5";
import { format } from "prettier";
import { hash, json, save, saveJson } from "../../dist/src/common.js";
const [catalogPath, site, output, coverageOutput] = process.argv.slice(2);
if (!coverageOutput)
  throw new Error(
    "Provide catalog, original base site, plan and coverage outputs.",
  );
const catalog = await json(path.resolve(catalogPath));
const plan = await json(
  new URL("materialized-replacements.json", import.meta.url),
);
const index = await json(path.join(site, "routes.json"));
const rules = new Map(plan.replacements.map((r) => [r.from, r]));
const add = (id, from, to) => {
  if (!rules.has(from)) rules.set(from, { id, from, to });
};
const topics = [
  ["eigna", "DEMO01", "el catálogo de contenido", "EIGNA", "Eigna"],
  ["orbit", "DEMO02", "el movimiento de la interfaz", "ORBIT", "Orbit"],
  ["mealops", "DEMO03", "la adaptación entre tamaños", "MealOPS", "MEALOPS"],
  [
    "papertrail",
    "DEMO04",
    "la sustitución del contenido",
    "PAPERTRAIL",
    "Papertrail",
  ],
  ["scribe", "DEMO05", "la documentación de estilos", "SCRIBE", "Scribe"],
  [
    "crediflow",
    "DEMO06",
    "la verificación del resultado",
    "Crediflow",
    "CREDIFLOW",
  ],
];
const paragraphs = [
  "Es una maqueta de trabajo con texto provisional. Sirve para revisar la composición de esta página, sus espacios y la relación entre títulos, párrafos y gráficos. No representa un cliente real, un resultado comercial ni una funcionalidad nueva del producto. Antes de publicar, cada bloque debe recibir el contenido definitivo de su propietario.",
  "El punto de partida es una página observada en un tamaño y un estado concretos. La revisión conserva esa referencia para poder explicar cada cambio. Un bloque que todavía contiene información ajena sigue pendiente, aunque el encabezado ya tenga otro nombre. Esta demostración permite localizar esos pendientes sin presentarlos como un trabajo terminado.",
  "El texto se edita mediante reglas explícitas que indican el valor de origen y el valor de destino. Esas reglas se aplican a los formatos de entrega compatibles. Cambiar una frase requiere volver a generar la salida y comprobarla en el navegador. La edición conserva los elementos anidados que pueden participar en la composición y en las animaciones.",
  "La organización visual se mantiene como referencia de trabajo: un título presenta la sección, el texto desarrolla la idea y el siguiente bloque muestra una relación. Los gráficos todavía requieren una revisión propia. Un diagrama puede contener nombres, cifras o símbolos del sitio de origen que una búsqueda de texto no alcanza a identificar por sí sola.",
  "La lectura se revisa en escritorio y en una ventana móvil. Las palabras nuevas pueden ocupar un espacio distinto, desplazar el siguiente bloque o cambiar la longitud del recorrido. Por eso la comprobación incluye el navegador y no termina al escribir un archivo. Los tamaños, las rutas y los escenarios aprobados deben aparecer en la evidencia guardada.",
  "La navegación forma parte de la experiencia observada. Se comprueba la entrada a esta página, el regreso a la portada, el historial y la recarga. El contenido sustituido debe permanecer después de esas acciones. Si una respuesta requerida falta en la captura, el informe debe mostrarla; completar un recorrido no significa cubrir todas las interacciones posibles.",
  "El movimiento requiere una verificación independiente del contenido. Un trazo puede adaptarse a la posición de un título y cambiar cuando ese título ocupa más espacio. Las muestras comparadas deben utilizar condiciones equivalentes y una tolerancia declarada. Una firma reemplazada se valida como un gráfico nuevo; no se exige que conserve la forma de la firma anterior.",
  "Esta sección conserva un borrador editable y una lista de comprobaciones pendientes. El resultado útil es una salida que puede revisarse, reproducirse y corregirse con evidencia. Las etiquetas del proceso describen operaciones realizadas. No sustituyen la revisión visual ni demuestran que se haya eliminado toda la información de la referencia.",
  "El siguiente paso consiste en revisar los detalles que aún no tienen sustitución: etiquetas de ejemplos, cifras, imágenes y gráficos. Cada cambio debe tener un propósito claro y una comprobación acorde con ese propósito. La integración en Nexus requiere además sus pruebas globales; las pruebas aisladas de esta herramienta no permiten dar esa integración por concluida.",
  "Esta maqueta permanece identificada como demostración mientras el contenido sea provisional. Los datos mostrados por componentes sin revisar no deben interpretarse como información propia. El paquete conserva los informes para que otra persona pueda distinguir qué se cambió, qué se comprobó y qué necesita trabajo adicional antes de una publicación.",
];
const headings = [
  "Una demostración con contenido editable.",
  "Definir el alcance antes de comprobarlo.",
  "Cambios explícitos, revisión visible.",
  "La estructura que conecta los bloques.",
  "Decisiones de la demostración.",
  "Recorrer la página en distintos tamaños.",
  "Conservar evidencia de cada comprobación.",
  "Criterios de revisión y trabajo pendiente.",
];
for (const [slug, name, topic, ...names] of topics) {
  const route = "/work/" + slug;
  const fields = catalog.bindings.filter((b) => b.route === route);
  for (const original of names)
    if (catalog.bindings.some((b) => b.expected === original))
      add("demo-name-" + original, original, name);
  const intro = fields.find(
    (b) => b.kind === "text" && / > h1:/.test(b.selector),
  );
  const next = fields.find(
    (b) => b.id === "field-" + (Number(intro.id.split("-")[1]) + 1),
  );
  add(
    "demo-intro-" + slug,
    next.expected,
    "Demostración editable para revisar " + topic + ".",
  );
  const metadata = fields.find(
    (b) => b.kind === "attribute" && b.attribute === "content",
  );
  add(
    "demo-metadata-" + slug,
    metadata.expected,
    name + ": maqueta provisional sobre " + topic + ".",
  );
  let h = 0,
    p = 0;
  for (const b of fields) {
    if (b.kind !== "text") continue;
    if (/ > h2:/.test(b.selector)) {
      if (h >= headings.length)
        throw new Error("Unexpected heading count: " + route);
      add("demo-heading-" + b.id, b.expected, headings[h++]);
    }
    if (b.expected.length > 200) {
      if (p >= paragraphs.length)
        throw new Error("Unexpected paragraph count: " + route);
      add(
        "demo-paragraph-" + b.id,
        b.expected,
        name + " explora " + topic + ". " + paragraphs[p++],
      );
    }
  }
}
const about = catalog.bindings.find((b) => b.id === "field-467");
add(
  "demo-about",
  about.expected,
  "Esta es una demostración de Bot MD con textos provisionales. Permite revisar el diseño, la navegación y el movimiento antes de incorporar contenido definitivo.",
);

// Ten loader strokes draw an authored BOT MD monogram; another replaces the small signature.
const shapes = [
  "M 180 350 L 180 650",
  "M 180 350 C 420 350 420 500 180 500 C 440 500 440 650 180 650",
  "M 540 350 C 360 350 360 650 540 650 C 720 650 720 350 540 350",
  "M 740 350 L 920 350",
  "M 830 350 L 830 650",
  "M 1000 650 L 1000 350 L 1100 520 L 1200 350 L 1200 650",
  "M 1300 350 L 1300 650",
  "M 1300 350 C 1550 350 1550 650 1300 650",
  "M 180 720 L 1440 720",
  "M 1440 720 L 1441 720",
];
const html = await readFile(path.join(site, index.routes["/"].file), "utf8");
const svgPaths = [];
function walk(n) {
  const cls = n.attrs?.find((a) => a.name === "class")?.value ?? "";
  if (n.tagName === "svg" && cls === "loader-signature") {
    const paths = n.childNodes.filter((c) => c.tagName === "path");
    if (paths.length !== shapes.length)
      throw new Error("Unexpected loader geometry");
    paths.forEach((p, i) =>
      svgPaths.push({
        id: "loader-" + (i + 1),
        from: p.attrs.find((a) => a.name === "d").value,
        to: shapes[i],
      }),
    );
  }
  if (n.tagName === "path" && cls === "eigna-signature") {
    const from = n.attrs.find((a) => a.name === "d").value;
    if (!svgPaths.some((r) => r.from === from))
      svgPaths.push({
        id: "small-monogram",
        from,
        to: "M 25 150 L 25 185 L 40 185 C 58 185 58 168 40 168 L 25 168 L 40 168 C 55 168 55 150 40 150 Z M 65 185 L 65 150 L 80 172 L 95 150 L 95 185",
      });
  }
  for (const c of n.childNodes ?? []) walk(c);
}
walk(parse(html));
if (svgPaths.length !== 11)
  throw new Error("Expected eleven authored path replacements");
plan.svgPaths = svgPaths;
plan.replacements = [...rules.values()];
await save(
  path.resolve(output),
  await format(JSON.stringify(plan), { parser: "json" }),
);
const covered = [],
  pending = [];
for (const b of catalog.bindings) {
  const rule = rules.get(b.expected);
  (rule ? covered : pending).push(
    rule ? { ...b, value: rule.to, ruleId: rule.id } : b,
  );
}
await saveJson(path.resolve(coverageOutput), {
  schemaVersion: 1,
  sourceDigest: index.sourceDigest,
  catalogSha256: hash(await readFile(path.resolve(catalogPath))),
  planSha256: hash(await readFile(path.resolve(output))),
  status: "in-progress",
  purpose:
    "Neutral provisional demo copy, not client facts. Catalog matching is not browser validation or complete semantic replacement.",
  total: catalog.bindings.length,
  coveredCount: covered.length,
  pendingCount: pending.length,
  covered,
  pending,
  graphics: svgPaths.map((r) => ({
    id: r.id,
    sourceSha256: hash(r.from),
    replacementSha256: hash(r.to),
  })),
});
console.log(
  JSON.stringify({
    rules: plan.replacements.length,
    svgPaths: svgPaths.length,
    covered: covered.length,
    pending: pending.length,
  }),
);
