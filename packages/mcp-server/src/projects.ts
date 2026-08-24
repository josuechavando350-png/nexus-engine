import type { ProjectState } from "./contracts.js";
import { runReadOnly } from "./process.js";

export async function readProjects(root: string): Promise<readonly ProjectState[]> {
  const output = await runReadOnly(process.execPath, ["scripts/list-workspace-apps.mjs"], root);
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("workspace project discovery returned a non-array result");
  return Object.freeze(value as ProjectState[]);
}
