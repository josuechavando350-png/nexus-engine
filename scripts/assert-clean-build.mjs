import { execFileSync } from "node:child_process";

const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  encoding: "utf8",
}).trim();

if (status) {
  process.stderr.write("pnpm build mutated tracked files; builds must be side-effect-free:\n");
  process.stderr.write(`${status}\n`);
  try {
    process.stderr.write(execFileSync("git", ["diff", "--", "."], { encoding: "utf8" }));
  } catch {
    // The status above remains the authoritative failure signal.
  }
  process.exit(1);
}

console.log("Build hygiene PASS: no tracked file was modified by the build.");
