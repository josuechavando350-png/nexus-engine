// Identidad canónica, hashes y errores tipados de SUPERSEO.
// Todo artefacto que SUPERSEO emite (estrategia, auditoría, reporte) se liga a
// un digest SHA-256 de su entrada canónica, igual que GAUSS, WALLE y Avengers.
import { createHash } from "node:crypto";

export class SuperSeoError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SuperSeoError";
    this.code = code;
    this.detail = detail;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SuperSeoError("NUMERO_NO_FINITO");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Normaliza texto para comparar términos: minúsculas, sin acentos, espacios simples.
export function normalizarTexto(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
