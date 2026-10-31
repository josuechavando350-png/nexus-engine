import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./types.js";

export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function save(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
export const saveJson = (file: string, value: unknown) =>
  save(file, JSON.stringify(value, null, 2) + "\n");
export function inside(root: string, relative: string) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new Error("Ruta fuera del proyecto: " + relative);
  return target;
}
export async function newDirectory(dir: string) {
  try {
    await stat(dir);
    throw new Error("La carpeta ya existe; usa una ruta nueva: " + dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dir, { recursive: true });
}
export function canonical(input: string, base?: string) {
  const u = new URL(input, base);
  u.hash = "";
  return u.href;
}
export function localPath(input: string, origin: string) {
  const u = new URL(input);
  return (
    (u.origin === origin
      ? ""
      : "/__replica/external/" + hash(u.origin).slice(0, 16)) +
    u.pathname +
    u.search
  );
}
export function config(input: Partial<Config> & { url: string }): Config {
  const c: Config = {
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ],
    maxPages: 3,
    maxStates: 8,
    autoExplore: true,
    allowLocalhost: false,
    settleMs: 300,
    navigationTimeoutMs: 20000,
    maxElements: 5000,
    maxResourceBytes: 20 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxScrollSteps: 12,
    scenarios: [],
    pixelThreshold: 0.1,
    maxDiffRatio: 0.005,
    geometryTolerance: 1,
    ...input,
  };
  const u = new URL(c.url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Se requiere una URL HTTP(S) sin credenciales.");
  c.url = canonical(c.url);
  for (const [key, min, max] of [
    ["maxPages", 1, 50],
    ["maxStates", 1, 100],
    ["settleMs", 0, 10000],
    ["navigationTimeoutMs", 1000, 120000],
    ["maxElements", 10, 20000],
    ["maxResourceBytes", 1024, 100 * 1024 * 1024],
    ["maxTotalBytes", 1024, 1024 * 1024 * 1024],
    ["maxScrollSteps", 0, 100],
  ] as const)
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error("Límite inválido: " + key);
  for (const key of [
    "pixelThreshold",
    "maxDiffRatio",
    "geometryTolerance",
  ] as const)
    if (
      !Number.isFinite(c[key]) ||
      c[key] < 0 ||
      c[key] > (key === "geometryTolerance" ? 100 : 1)
    )
      throw new Error("Umbral inválido: " + key);
  for (const key of ["autoExplore", "allowLocalhost"] as const)
    if (typeof c[key] !== "boolean")
      throw new Error("Booleano inválido: " + key);
  if (
    !Array.isArray(c.viewports) ||
    !c.viewports.length ||
    c.viewports.length > 12
  )
    throw new Error("Se requieren de 1 a 12 viewports.");
  const names = new Set<string>();
  for (const v of c.viewports) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(v.name) ||
      names.has(v.name) ||
      !Number.isInteger(v.width) ||
      !Number.isInteger(v.height) ||
      v.width < 240 ||
      v.width > 3840 ||
      v.height < 240 ||
      v.height > 2160
    )
      throw new Error("Viewport inválido o duplicado.");
    names.add(v.name);
  }
  if (!Array.isArray(c.scenarios) || c.scenarios.length > 50)
    throw new Error("Escenarios inválidos.");
  if (
    c.readySelector !== undefined &&
    (typeof c.readySelector !== "string" ||
      !c.readySelector ||
      c.readySelector.length > 2048)
  )
    throw new Error("Selector de preparación inválido.");
  if (
    c.readySelectors !== undefined &&
    (typeof c.readySelectors !== "object" ||
      c.readySelectors === null ||
      Array.isArray(c.readySelectors) ||
      Object.entries(c.readySelectors).some(
        ([route, selector]) =>
          !route.startsWith("/") ||
          typeof selector !== "string" ||
          !selector ||
          selector.length > 2048,
      ))
  )
    throw new Error("Mapa de preparación inválido.");
  for (const s of c.scenarios) {
    if (!s.name || !Array.isArray(s.steps) || s.steps.length > 30)
      throw new Error("Escenario inválido.");
    if (s.path && new URL(s.path, c.url).origin !== u.origin)
      throw new Error("Los escenarios deben permanecer en el origen inicial.");
    for (const a of s.steps) {
      if (
        ![
          "click",
          "hover",
          "focus",
          "fill",
          "select",
          "press",
          "scroll",
          "wait",
        ].includes(a.action)
      )
        throw new Error("Acción no admitida.");
      if (!["scroll", "wait"].includes(a.action) && !a.selector)
        throw new Error("Falta selector.");
      if (
        a.action === "wait" &&
        (!Number.isFinite(a.ms) || a.ms! < 0 || a.ms! > 10000)
      )
        throw new Error("Espera inválida.");
      if (
        a.action === "scroll" &&
        (!Number.isFinite(a.y) || Math.abs(a.y!) > 100000)
      )
        throw new Error("Scroll inválido.");
    }
    for (const a of s.assertions ?? [])
      if (
        !a.selector ||
        !["visible", "hidden", "text", "attribute", "value"].includes(a.kind)
      )
        throw new Error("Aserción inválida.");
  }
  return c;
}
export function escapeHTML(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
