import { validateBackendExecution } from "./contracts.mjs";

const BACKEND_FAMILIES = new Set(["SIMULATOR", "PHYSICAL_QPU"]);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function text(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be string`);
  const normalized = value.normalize("NFC").trim();
  if (!TOKEN_RE.test(normalized)) throw new Error(`${label} invalid`);
  return normalized;
}

export class QuantumBackendAdapter {
  constructor({ adapterId, adapterVersion, backendFamily, hardwareExecution, execute }) {
    const normalizedFamily = text(backendFamily, "backendFamily");
    if (!BACKEND_FAMILIES.has(normalizedFamily)) throw new Error("unsupported backend family");
    if (typeof hardwareExecution !== "boolean") throw new Error("hardwareExecution must be boolean");
    if ((normalizedFamily === "PHYSICAL_QPU") !== hardwareExecution) throw new Error("backend family/hardwareExecution mismatch");
    if (typeof execute !== "function") throw new Error("backend execute implementation required");
    this.descriptor = Object.freeze({
      schemaVersion: 1,
      adapterId: text(adapterId, "adapterId"),
      adapterVersion: text(adapterVersion, "adapterVersion"),
      backendFamily: normalizedFamily,
      hardwareExecution,
    });
    this._execute = execute;
    Object.freeze(this);
  }

  async execute(request) {
    const raw = await this._execute(request);
    return validateBackendExecution(raw, this.descriptor);
  }
}
