import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childProcessEnvironment } from "./child-env.js";

const execFileAsync = promisify(execFile);

export async function runReadOnly(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync(command, [...args], {
    cwd,
    env: childProcessEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.trimEnd();
}
