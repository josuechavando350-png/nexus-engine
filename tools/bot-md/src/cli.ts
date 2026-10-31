import { parseArgs } from "node:util";
import path from "node:path";
import { config, json, newDirectory, saveJson } from "./common.js";
import { capture } from "./capture.js";
import { build } from "./build.js";
import { verify, hasFailures } from "./verify.js";
import { repair } from "./repair.js";
import { serve } from "./server.js";
import { enrich } from "./dependencies.js";
import type { Config } from "./types.js";
import { exportStyles } from "./styles.js";
import { catalogContent, createTemplate } from "./content.js";
import { captureMotion, assessMotion, readMotion } from "./motion.js";
import type { ContentMap, MotionConfig } from "./experience-types.js";

const HELP =
  "Bot MD 0.3.0\n\n" +
  "npm run bot-md -- run --url https://sitio.example --out runs/ejemplo\n" +
  "npm run bot-md -- run --config examples/config.json --out runs/ejemplo\n" +
  "npm run bot-md -- capture --url URL --out CAPTURA\n" +
  "npm run bot-md -- build --capture CAPTURA --out SITIO\n" +
  "npm run bot-md -- enrich --capture CAPTURA --out CAPTURA_NUEVA\n" +
  "npm run bot-md -- verify --capture CAPTURA --site SITIO --out INFORME\n" +
  "npm run bot-md -- repair --capture CAPTURA --site SITIO --out REPARACION\n" +
  "npm run bot-md -- serve --site SITIO --port 4173\n\n" +
  "npm run bot-md -- styles --capture CAPTURA --out ESTILOS\n" +
  "npm run bot-md -- catalog --capture CAPTURA --out CONTENIDO\n" +
  "npm run bot-md -- template --site SITIO --content content.json --out PLANTILLA\n" +
  "npm run bot-md -- motion --url URL --config motion.json --out TRAZA\n" +
  "npm run bot-md -- motion --site SITIO --config motion.json --out TRAZA_LOCAL\n" +
  "npm run bot-md -- compare-motion --reference TRAZA --candidate TRAZA_LOCAL --out INFORME\n\n" +
  "Opciones: --allow-localhost (solo pruebas locales), --max-pages N, --config ARCHIVO.\n" +
  "verify: --legacy-cdp-replay reproduce el entorno de capturas anteriores a la corrección de hover.\n" +
  "No sobrescribe capturas. Las respuestas API son grabaciones; no hay backend recuperado.\n";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      out: { type: "string" },
      capture: { type: "string" },
      site: { type: "string" },
      config: { type: "string" },
      port: { type: "string" },
      "max-pages": { type: "string" },
      "allow-localhost": { type: "boolean" },
      "legacy-cdp-replay": { type: "boolean" },
      states: { type: "string" },
      content: { type: "string" },
      reference: { type: "string" },
      candidate: { type: "string" },
      trace: { type: "string" },
      "motion-config": { type: "string" },
      "repeat-reference": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const required = (
    key: "out" | "capture" | "site" | "content" | "reference" | "candidate",
  ) => {
    const v = values[key];
    if (!v) throw new Error("Falta --" + key);
    return path.resolve(v);
  };
  if (command === "styles") {
    await exportStyles(required("capture"), required("out"));
    return;
  }
  if (command === "catalog") {
    await catalogContent(required("capture"), required("out"));
    return;
  }
  if (command === "template") {
    await createTemplate(
      required("site"),
      await json<ContentMap>(required("content")),
      required("out"),
    );
    return;
  }
  if (command === "motion") {
    if (Boolean(values.site) === Boolean(values.url))
      throw new Error("Elige --site o --url.");
    const supplied = values.config
      ? await json<Partial<MotionConfig>>(values.config)
      : {};
    const trace = await captureMotion(
      values.site ? { site: required("site") } : { url: values.url! },
      {
        ...supplied,
        ...(values["allow-localhost"] !== undefined
          ? { allowLocalhost: values["allow-localhost"] }
          : {}),
      },
      required("out"),
    );
    console.log(
      "Muestras: " +
        trace.frames.length +
        " · incidencias: " +
        trace.issues.length,
    );
    process.exitCode = trace.issues.length ? 2 : 0;
    return;
  }
  if (command === "compare-motion") {
    const result = assessMotion(
      await readMotion(required("reference")),
      await readMotion(required("candidate")),
      values["repeat-reference"]
        ? await readMotion(path.resolve(values["repeat-reference"]))
        : undefined,
    );
    const out = required("out");
    await newDirectory(out);
    await saveJson(path.join(out, "comparison.json"), result);
    console.log("Comparación de movimiento: " + result.status);
    process.exitCode = result.status === "pass" ? 0 : 2;
    return;
  }
  if (command === "serve") {
    const port = Number(values.port ?? 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Puerto inválido.");
    const server = await serve(required("site"), port);
    console.log("Reconstrucción local: " + server.url);
    process.on("SIGINT", () => {
      void server.close().then(() => process.exit(0));
    });
    return;
  }
  if (command === "enrich") {
    const result = await enrich(
      required("capture"),
      required("out"),
      values.trace ? path.resolve(values.trace) : undefined,
    );
    console.log("Recursos agregados: " + result.addedURLs.length);
    return;
  }
  if (command === "build") {
    await build(required("capture"), required("out"));
    console.log("Reconstrucción creada.");
    return;
  }
  if (command === "verify") {
    const v = await verify(
      required("capture"),
      required("site"),
      required("out"),
      console.log,
      {
        legacyCDPReplay: values["legacy-cdp-replay"],
        ...(values.states
          ? { stateIds: values.states.split(",").map((s) => s.trim()) }
          : {}),
      },
    );
    process.exitCode = hasFailures(v) ? 2 : 0;
    return;
  }
  if (command === "repair") {
    const r = await repair(
      required("capture"),
      required("site"),
      required("out"),
    );
    console.log("Reparación terminada: " + r.log.length + " intentos.");
    process.exitCode = hasFailures(r.verification) ? 2 : 0;
    return;
  }
  if (!["capture", "run"].includes(command))
    throw new Error("Comando desconocido: " + command);
  const supplied = values.config
    ? await json<Partial<Config>>(values.config)
    : {};
  const c = config({
    ...supplied,
    url: values.url ?? supplied.url ?? "",
    ...(values["allow-localhost"] !== undefined
      ? { allowLocalhost: values["allow-localhost"] }
      : {}),
    ...(values["max-pages"] ? { maxPages: Number(values["max-pages"]) } : {}),
  });
  const out = required("out");
  if (command === "capture") {
    await capture(c, out);
    return;
  }
  await newDirectory(out);
  const originalCapture = path.join(out, "capture");
  await capture(c, originalCapture);
  let buildCapture = originalCapture;
  let motionFailed = false;
  const activeMotion = values["motion-config"]
    ? await json<Partial<MotionConfig>>(values["motion-config"])
    : undefined;
  if (activeMotion) {
    const trace = await captureMotion(
      { url: c.url },
      { ...activeMotion, allowLocalhost: c.allowLocalhost },
      path.join(out, "motion-source"),
    );
    motionFailed = trace.issues.length > 0;
    buildCapture = path.join(out, "capture-completed");
    await enrich(
      originalCapture,
      buildCapture,
      path.join(out, "motion-source"),
    );
  }
  await exportStyles(buildCapture, path.join(out, "styles"));
  await catalogContent(buildCapture, path.join(out, "content"));
  await build(buildCapture, path.join(out, "site"));
  const v = await verify(
    buildCapture,
    path.join(out, "site"),
    path.join(out, "verification"),
  );
  if (activeMotion) {
    await captureMotion(
      { site: path.join(out, "site") },
      {
        route: new URL(c.url).pathname + new URL(c.url).search,
        ...activeMotion,
        allowLocalhost: c.allowLocalhost,
      },
      path.join(out, "motion-local"),
    );
    const assessment = assessMotion(
      await readMotion(path.join(out, "motion-source")),
      await readMotion(path.join(out, "motion-local")),
    );
    await saveJson(path.join(out, "motion-comparison.json"), assessment);
    motionFailed ||= assessment.status !== "pass";
  }
  if (values.content)
    await createTemplate(
      path.join(out, "site"),
      await json<ContentMap>(values.content),
      path.join(out, "template"),
    );
  console.log("Informe: " + path.join(out, "verification", "index.html"));
  process.exitCode = hasFailures(v) || motionFailed ? 2 : 0;
}
main().catch((e) => {
  console.error("Error: " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
