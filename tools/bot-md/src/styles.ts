import path from "node:path";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import { integrity } from "./build.js";
import { inside, json, newDirectory, save, saveJson } from "./common.js";
import type { Layout } from "./types.js";

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** Export measured values and original CSS conditions, without inventing semantic roles. */
export async function exportStyles(captureDir: string, out: string) {
  const { manifest, digest } = await integrity(captureDir);
  await newDirectory(out);
  const properties = new Map<
    string,
    Map<string, { count: number; examples: string[] }>
  >();
  const typography: {
    state: string;
    selector: string;
    tag: string;
    style: Record<string, string>;
  }[] = [];
  const cssEvidence: {
    url: string;
    sha256: string;
    file: string;
    media: string[];
    containers: string[];
    fonts: string[];
    keyframes: string[];
    variables: {
      selector: string;
      property: string;
      value: string;
      context: string[];
    }[];
  }[] = [];
  const issues: string[] = [];
  for (const state of manifest.states) {
    const measured = await json<Layout>(inside(captureDir, state.layout));
    if (measured.truncated) issues.push("Layout truncado: " + state.id);
    for (const node of measured.nodes.filter((n) => n.visible)) {
      for (const [property, value] of Object.entries(node.style)) {
        if (!value) continue;
        const values = properties.get(property) ?? new Map();
        const item = values.get(value) ?? { count: 0, examples: [] };
        item.count++;
        if (item.examples.length < 3)
          item.examples.push(state.id + " " + node.selector);
        values.set(value, item);
        properties.set(property, values);
      }
      if (/^(h[1-6]|p|button|a)$/.test(node.tag) && typography.length < 250)
        typography.push({
          state: state.id,
          selector: node.selector,
          tag: node.tag,
          style: Object.fromEntries(
            Object.entries(node.style).filter(([k]) =>
              /font|line-height|letter-spacing/.test(k),
            ),
          ),
        });
    }
  }
  for (const resource of Object.values(manifest.resources).filter((r) =>
    /text\/css/i.test(r.mime),
  )) {
    const record = {
      url: resource.url,
      sha256: resource.sha256,
      file: "css/" + resource.sha256 + ".css",
      media: [] as string[],
      containers: [] as string[],
      fonts: [] as string[],
      keyframes: [] as string[],
      variables: [] as {
        selector: string;
        property: string;
        value: string;
        context: string[];
      }[],
    };
    const raw = await readFile(inside(captureDir, resource.file));
    await save(inside(out, record.file), raw);
    try {
      const css = postcss.parse(raw.toString("utf8"));
      css.walkAtRules((rule) => {
        if (rule.name === "media") record.media.push(rule.params);
        if (rule.name === "container") record.containers.push(rule.params);
        if (rule.name === "font-face") record.fonts.push(rule.toString());
        if (/keyframes$/.test(rule.name))
          record.keyframes.push(rule.toString());
      });
      css.walkDecls((decl) => {
        if (!decl.prop.startsWith("--")) return;
        const context: string[] = [];
        let parent = decl.parent;
        while (parent && parent.type !== "root") {
          if (parent.type === "atrule")
            context.unshift("@" + parent.name + " " + parent.params);
          parent = parent.parent;
        }
        record.variables.push({
          selector:
            decl.parent?.type === "rule" ? decl.parent.selector : ":unknown",
          property: decl.prop,
          value: decl.value,
          context,
        });
      });
    } catch (error) {
      issues.push(resource.url + ": " + String(error));
    }
    cssEvidence.push(record);
  }
  const values = Object.fromEntries(
    [...properties].map(([prop, items]) => [
      prop,
      [...items]
        .map(([value, data]) => ({ value, ...data }))
        .sort((a, b) => b.count - a.count),
    ]),
  );
  const evidence = {
    schemaVersion: 1,
    sourceDigest: digest,
    origin: manifest.origin,
    states: manifest.states.map((s) => ({
      id: s.id,
      url: s.url,
      viewport: s.viewport,
      name: s.name,
    })),
    properties: values,
    typography,
    typographySampleLimit: 250,
    css: cssEvidence,
    issues,
    scope:
      "Valores observados; frecuencia no equivale a importancia. Las media queries son declaradas por el CSS; solo los viewports de la evidencia fueron observados. Tipografía por selector: primeras 250 observaciones; frecuencias: todos los nodos visibles capturados. css/ conserva las hojas externas capturadas, con sus URLs originales; los recursos se encuentran en la captura. Los estilos inline/pseudo y los estados no observados requieren consultar HTML/layout y pruebas adicionales.",
  };
  await saveJson(path.join(out, "estilos.json"), evidence);
  const tokenProperties = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "line-height",
    "letter-spacing",
    "border-radius",
    "gap",
  ];
  const tokenLines = tokenProperties.flatMap((prop) =>
    (values[prop] ?? [])
      .slice(0, 15)
      .filter((v) => !/[;{}]/.test(v.value))
      .map((v, i) => `  --bot-md-${prop}-${i + 1}: ${v.value};`),
  );
  await save(
    path.join(out, "tokens.css"),
    "/* Valores medidos. Los índices no asignan funciones semánticas. No modifica reglas originales. */\n:root {\n" +
      tokenLines.join("\n") +
      "\n}\n",
  );
  const sections = tokenProperties.map(
    (prop) =>
      "## " +
      prop +
      "\n\n| Valor observado | Apariciones | Ejemplo |\n|---|---:|---|\n" +
      (values[prop] ?? [])
        .slice(0, 15)
        .map(
          (v) => `| ${cell(v.value)} | ${v.count} | ${cell(v.examples[0])} |`,
        )
        .join("\n"),
  );
  await save(
    path.join(out, "ESTILOS.md"),
    "# Estilos observados\n\nFuente: " +
      manifest.origin +
      "\n\nReferencia SHA-256: `" +
      digest +
      "`\n\n" +
      evidence.scope +
      "\n\n## Tamaños y estados\n\n" +
      manifest.states
        .map(
          (s) =>
            `- ${s.id}: ${s.viewport.width} × ${s.viewport.height}; ${s.name}; ${s.url}`,
        )
        .join("\n") +
      "\n\n" +
      sections.join("\n\n") +
      "\n\n## Condiciones responsive declaradas\n\n" +
      [...new Set(cssEvidence.flatMap((c) => c.media))]
        .map((m) => "- `" + m.replace(/`/g, "") + "`")
        .join("\n") +
      "\n\n## Fuentes, variables y movimiento CSS\n\nLas reglas originales @font-face, variables con selector/contexto y @keyframes se conservan en estilos.json. Los valores computados por selector/estado están en las capturas. El movimiento JavaScript requiere una traza independiente; este documento no lo certifica.\n\n## Incidencias\n\n" +
      (issues.length
        ? issues.map((i) => "- " + i).join("\n")
        : "Sin incidencias de exportación.") +
      "\n",
  );
  return evidence;
}
