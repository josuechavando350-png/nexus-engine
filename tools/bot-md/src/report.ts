import path from "node:path";
import { save, escapeHTML as e } from "./common.js";
import type { Verification } from "./types.js";

export async function report(v: Verification, out: string) {
  const rows = v.results
    .map(
      (r) =>
        '<article><div class="row"><h2>' +
        e(r.id) +
        " · " +
        e(r.name) +
        '</h2><span class="badge ' +
        r.status +
        '">' +
        r.status +
        "</span></div><p>" +
        r.viewport.width +
        " × " +
        r.viewport.height +
        " · Diferencia visual: " +
        (r.diffRatio === undefined
          ? "sin medición"
          : (100 * r.diffRatio).toFixed(4) + "%") +
        " · Errores geométricos: " +
        (r.geometryErrors?.length ?? "—") +
        " · Comprobaciones: " +
        r.assertions.filter(Boolean).length +
        "/" +
        r.assertions.length +
        "</p>" +
        (r.screenshot
          ? '<div class="images"><figure><figcaption>Referencia</figcaption><img loading="lazy" src="' +
            e(r.id) +
            '/original.png"></figure><figure><figcaption>Reconstrucción</figcaption><img loading="lazy" src="' +
            e(r.screenshot) +
            '"></figure><figure><figcaption>Diferencias</figcaption><img loading="lazy" src="' +
            e(r.diff ?? "") +
            '"></figure></div>'
          : "") +
        "<details><summary>Evidencia y pendientes</summary><pre>" +
        e(JSON.stringify(r, null, 2)) +
        "</pre></details></article>",
    )
    .join("");
  await save(
    path.join(out, "index.html"),
    '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot MD · Informe</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0c1118;color:#e5edf7;font:15px/1.6 system-ui}main{max-width:1320px;margin:auto;padding:40px 24px}header{border-bottom:1px solid #2a3544;margin-bottom:28px;padding-bottom:24px}small{color:#87b8ff;text-transform:uppercase;letter-spacing:.16em}h1{font-size:44px;line-height:1.1;margin:14px 0}h2{font-size:19px;margin:0}.metrics{display:flex;gap:12px;flex-wrap:wrap}.metric,article{background:#131c28;border:1px solid #293647;border-radius:12px;padding:20px}.metric b{display:block;font-size:30px}article{margin:20px 0}.row{display:flex;justify-content:space-between;gap:12px}.badge{padding:3px 12px;border-radius:20px;background:#314157}.pass{color:#89e9b2}.fail,.error{color:#ffa49e}.unstable{color:#ffdc8d}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{color:#a2b5ce;margin-bottom:8px}img{width:100%;max-height:640px;object-fit:contain;object-position:top;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:14px 0}p{color:#b4c1d3}a{color:#8cbfff}@media(max-width:700px){h1{font-size:32px}.images{grid-template-columns:1fr}.row{display:block}}</style><main><header><small>Bot MD / evidencia</small><h1>Informe de reconstrucción.</h1><p>' +
      e(v.scope) +
      "</p><p>Capturados: " +
      v.captureCoverage.capturedStates +
      " · Estados no capturados: " +
      v.captureCoverage.failedStates +
      " · Cargas fallidas: " +
      v.captureCoverage.failedPageLoads +
      " · Estados truncados: " +
      v.captureCoverage.truncatedStates +
      '</p><div class="metrics">' +
      Object.entries(v.totals)
        .map(([k, n]) => '<div class="metric"><b>' + n + "</b>" + k + "</div>")
        .join("") +
      "</div></header>" +
      rows +
      "<details><summary>Alcance y limitaciones (" +
      v.limitations.length +
      ")</summary><ul>" +
      v.limitations.map((x) => "<li>" + e(x) + "</li>").join("") +
      "</ul></details><p>Referencia SHA-256: " +
      e(v.sourceDigest) +
      "<br>" +
      e(v.createdAt) +
      " · " +
      e(v.environment.browser) +
      "</p></main></html>",
  );
  await save(
    path.join(out, "REPORT.md"),
    "# Bot MD — verificación\n\n" +
      v.scope +
      "\n\nFecha: " +
      v.createdAt +
      "\n\n| Estado | Resultado | Diferencia visual |\n|---|---|---|\n" +
      v.results
        .map(
          (r) =>
            "| " +
            r.id +
            " | " +
            r.status +
            " | " +
            (r.diffRatio === undefined
              ? "sin medición"
              : (100 * r.diffRatio).toFixed(4) + "%") +
            " |",
        )
        .join("\n") +
      "\n\n## Limitaciones\n\n" +
      v.limitations.map((s) => "- " + s.replace(/\n/g, " ")).join("\n") +
      "\n",
  );
}
