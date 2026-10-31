import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fixture } from "../tests/fixture-server.js";
import { config, newDirectory } from "./common.js";
import { capture } from "./capture.js";
import { build } from "./build.js";
import { verify, hasFailures } from "./verify.js";

const out = path.resolve(process.argv[2] ?? "runs/demo-" + Date.now());
await newDirectory(out);
const source = await fixture();
try {
  await capture(
    config({
      url: source.url,
      allowLocalhost: true,
      maxPages: 2,
      maxStates: 4,
      viewports: [
        { name: "mobile", width: 390, height: 844 },
        { name: "tablet", width: 820, height: 1000 },
        { name: "desktop", width: 1440, height: 900 },
      ],
      scenarios: [
        {
          name: "engineering-tab",
          path: "/",
          steps: [{ action: "click", selector: "#engineering" }],
          assertions: [
            { selector: "#panel", kind: "text", value: "Sistemas rápidos" },
            {
              selector: "#engineering",
              kind: "attribute",
              attribute: "aria-selected",
              value: "true",
            },
          ],
        },
      ],
    }),
    path.join(out, "capture"),
  );
} finally {
  await source.close();
}
await build(path.join(out, "capture"), path.join(out, "site"));
const result = await verify(
  path.join(out, "capture"),
  path.join(out, "site"),
  path.join(out, "verification"),
);
console.log("Origen detenido antes de reconstruir y verificar.");
console.log("Informe: " + path.join(out, "verification/index.html"));
process.exitCode = hasFailures(result) ? 2 : 0;
