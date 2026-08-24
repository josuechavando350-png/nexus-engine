import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { QualityPassport } from "@nexus/quality/quality-passport";
import { pathToFileURL } from "node:url";

export interface PassportReadResult { path: string; passport: QualityPassport; computedHash: string; fileSha256: string }

function confined(root: string, requested: string): string {
  const allowedRoot = resolve(root, ".artifacts", "quality-passports");
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!absolute.startsWith(`${allowedRoot}${sep}`)) throw new Error("passport path must be inside .artifacts/quality-passports");
  return absolute;
}

export async function readPassport(root: string, target: string, passportPath?: string, verifier?: (passport: QualityPassport) => boolean): Promise<PassportReadResult | null> {
  const path = passportPath ? confined(root, passportPath) : join(root, ".artifacts", "quality-passports", `${target}.json`);
  try { if (!(await stat(path)).isFile()) return null; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  const bytes = await readFile(path);
  const passport = JSON.parse(bytes.toString("utf8")) as QualityPassport;
  if (passport.authority !== "NEXUS_QUALITY_PASSPORT_V1") throw new Error("unsupported Quality Passport authority");
  let verify = verifier;
  if (!verify) {
    const moduleUrl = pathToFileURL(join(root, "packages", "quality", "dist", "quality", "quality-passport.js")).href;
    const module = await import(moduleUrl) as typeof import("@nexus/quality/quality-passport");
    verify = module.verifyQualityPassport;
  }
  if (!verify(passport)) throw new Error("Quality Passport integrity verification failed");
  return { path: relative(root, path).split(sep).join("/"), passport, computedHash: passport.passportHash, fileSha256: createHash("sha256").update(bytes).digest("hex") };
}
