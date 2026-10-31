import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { integrity } from "./build.js";
import { inside, json, save, saveJson, newDirectory } from "./common.js";
import { verify } from "./verify.js";
import type { Layout, Verification } from "./types.js";

const ALLOWED = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "border-radius",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
];
export function improves(before: Verification, after: Verification): boolean {
  if (before.results.length !== after.results.length) return false;
  let gain = false;
  for (let i = 0; i < before.results.length; i++) {
    const a = before.results[i],
      b = after.results[i];
    if (a.id !== b.id || ["error", "unstable"].includes(b.status)) return false;
    if (a.status === "pass" && b.status !== "pass") return false;
    if (a.assertions.some((v, j) => v && !b.assertions[j])) return false;
    if (
      b.missingRequests.length > a.missingRequests.length ||
      b.consoleErrors.length > a.consoleErrors.length
    )
      return false;
    if (
      (b.diffRatio ?? 1) > (a.diffRatio ?? 1) + 1e-8 ||
      (b.geometryErrors?.length ?? 1e6) > (a.geometryErrors?.length ?? 1e6)
    )
      return false;
    if (
      (b.diffRatio ?? 1) < (a.diffRatio ?? 1) - 1e-8 ||
      (b.geometryErrors?.length ?? 1e6) < (a.geometryErrors?.length ?? 1e6) ||
      (a.status !== "pass" && b.status === "pass")
    )
      gain = true;
  }
  return gain;
}
export async function repair(
  captureDir: string,
  siteDir: string,
  out: string,
  maxTrials = 4,
) {
  const { manifest } = await integrity(captureDir);
  await newDirectory(out);
  let current = await verify(captureDir, siteDir, path.join(out, "before"));
  const sourceLayouts = await Promise.all(
    manifest.states.map((s) => json<Layout>(inside(captureDir, s.layout))),
  );
  const actualLayouts = await Promise.all(
    manifest.states.map(async (s) => {
      try {
        return await json<Layout>(
          path.join(out, "before", s.id, "layout.json"),
        );
      } catch {
        return null;
      }
    }),
  );
  const candidates: { selector: string; property: string; value: string }[] =
    [];
  const initial = sourceLayouts[0];
  for (const n of initial?.nodes ?? []) {
    for (const property of ALLOWED) {
      const value = n.style[property];
      if (!value || /[{};]/.test(value)) continue;
      const every = sourceLayouts.every(
        (l) => l.nodes.find((x) => x.key === n.key)?.style[property] === value,
      );
      const different = actualLayouts.some((l) => {
        const a = l?.nodes.find((x) => x.key === n.key);
        return a && a.style[property] !== value;
      });
      if (every && different)
        candidates.push({ selector: n.selector, property, value });
    }
  }
  const log: unknown[] = [];
  let css = await readFile(path.join(siteDir, "repairs.css"), "utf8");
  for (const candidate of candidates.slice(0, maxTrials)) {
    const trial = log.length + 1;
    const proposed =
      css +
      "\n" +
      candidate.selector +
      " {" +
      candidate.property +
      ": " +
      candidate.value +
      " !important;}\n";
    await save(path.join(siteDir, "repairs.css"), proposed);
    try {
      const after = await verify(
        captureDir,
        siteDir,
        path.join(out, "trial-" + trial),
      );
      const accepted = improves(current, after);
      log.push({
        ...candidate,
        accepted,
        reason: accepted
          ? "Mejora medida sin regresiones en los estados comprobados."
          : "Sin mejora suficiente o con regresión; revertido.",
      });
      if (accepted) {
        css = proposed;
        current = after;
      } else await save(path.join(siteDir, "repairs.css"), css);
    } catch (e) {
      await save(path.join(siteDir, "repairs.css"), css);
      log.push({ ...candidate, accepted: false, error: String(e) });
    }
  }
  await saveJson(path.join(out, "repair-log.json"), {
    mode: "deterministic-evidence-only",
    trials: log,
    candidates: candidates.length,
    remaining: Math.max(0, candidates.length - maxTrials),
    scope:
      "Solo propiedades CSS constantes en todos los estados observados. No genera lógica ni modifica las referencias.",
  });
  await saveJson(path.join(out, "final-verification.json"), current);
  return { verification: current, log };
}
