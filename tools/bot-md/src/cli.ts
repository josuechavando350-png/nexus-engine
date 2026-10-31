import { parseArgs } from "node:util";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { config, json, newDirectory } from "./common.js";
import { capture } from "./capture.js";
import { build } from "./build.js";
import { verify, hasFailures } from "./verify.js";
import { repair } from "./repair.js";
import { serve } from "./server.js";
import { enrich } from "./dependencies.js";
import type { Config } from "./types.js";

const HELP =
  "Bot MD 0.2.1\n\n" +
  "npm run bot-md -- run --url https://sitio.example --out runs/ejemplo\n" +
  "npm run bot-md -- run --config examples/config.json --out runs/ejemplo\n" +
  "npm run bot-md -- capture --url URL --out CAPTURA\n" +
  "npm run bot-md -- build --capture CAPTURA --out SITIO\n" +
  "npm run bot-md -- enrich --capture CAPTURA --out CAPTURA_NUEVA\n" +
  "npm run bot-md -- verify --capture CAPTURA --site SITIO --out INFORME\n" +
  "npm run bot-md -- repair --capture CAPTURA --site SITIO --out REPARACION\n" +
  "npm run bot-md -- serve --site SITIO --port 4173\n\n" +
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
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const required = (key: "out" | "capture" | "site") => {
    const v = values[key];
    if (!v) throw new Error("Falta --" + key);
    return path.resolve(v);
  };
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
    const result = await enrich(required("capture"), required("out"));
    console.log("Dependencias CSS agregadas: " + result.addedURLs.length);
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
  await capture(c, path.join(out, "capture"));
  await build(path.join(out, "capture"), path.join(out, "site"));
  const v = await verify(
    path.join(out, "capture"),
    path.join(out, "site"),
    path.join(out, "verification"),
  );
  console.log("Informe: " + path.join(out, "verification", "index.html"));
  process.exitCode = hasFailures(v) ? 2 : 0;
}
main().catch((e) => {
  console.error("Error: " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
