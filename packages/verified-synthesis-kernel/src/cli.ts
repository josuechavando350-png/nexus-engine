#!/usr/bin/env node
import { open } from "node:fs/promises";
import { CommandCounterexampleOracle } from "./oracle.js";
import { VerifiedSynthesisRuntime } from "./runtime.js";
import { ExternalSmtLibSolver, InternalBoundedSolver } from "./solver.js";
import type { CounterexampleOracle, SynthesisProblem, SynthesisSolver } from "./types.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

type SolverChoice = "internal" | "z3" | "cvc5-smt" | "cvc5-sygus";

interface CliOptions {
  readonly file: string;
  readonly solver: SolverChoice;
  readonly runtimeOracle?: string;
  readonly browserOracle?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let file: string | undefined;
  let solver: SolverChoice = "internal";
  let runtimeOracle: string | undefined;
  let browserOracle: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--solver=")) {
      const value = arg.slice("--solver=".length);
      if (value !== "internal" && value !== "z3" && value !== "cvc5-smt" && value !== "cvc5-sygus") throw new Error("unsupported --solver value");
      solver = value;
    } else if (arg.startsWith("--runtime-oracle=")) {
      runtimeOracle = executableArg(arg.slice("--runtime-oracle=".length), "runtime oracle");
    } else if (arg.startsWith("--browser-oracle=")) {
      browserOracle = executableArg(arg.slice("--browser-oracle=".length), "browser oracle");
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!file) {
      file = arg;
    } else {
      throw new Error("exactly one synthesis problem file is required");
    }
  }
  if (!file) throw new Error("usage: nexus-verified-synthesis <problem.json> [--solver=internal|z3|cvc5-smt|cvc5-sygus] [--runtime-oracle=/trusted/executable] [--browser-oracle=/trusted/executable]");
  return Object.freeze({ file, solver, ...(runtimeOracle ? { runtimeOracle } : {}), ...(browserOracle ? { browserOracle } : {}) });
}

function executableArg(value: string, field: string): string {
  if (!value || value.length > 1024 || value.includes("\0")) throw new Error(`${field} path is invalid`);
  return value;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("input path must be a regular file");
    if (before.size < 1 || before.size > MAX_INPUT_BYTES) throw new Error("input file size is outside the supported bound");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== buffer.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("input file changed while being read");
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

function solverFor(choice: SolverChoice): SynthesisSolver {
  switch (choice) {
    case "internal": return new InternalBoundedSolver();
    case "z3": return new ExternalSmtLibSolver({ executable: "z3", kind: "SMT", args: ["-in", "-smt2"] });
    case "cvc5-smt": return new ExternalSmtLibSolver({ executable: "cvc5", kind: "SMT", args: ["--lang=smt2", "--produce-models"] });
    case "cvc5-sygus": return new ExternalSmtLibSolver({ executable: "cvc5", kind: "SYGUS", args: ["--lang=sygus2"] });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = await readBoundedJson(options.file);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("synthesis input must be a JSON object");
  const oracles: CounterexampleOracle[] = [];
  if (options.runtimeOracle) oracles.push(new CommandCounterexampleOracle({ authority: "RUNTIME", executable: options.runtimeOracle }));
  if (options.browserOracle) oracles.push(new CommandCounterexampleOracle({ authority: "BROWSER", executable: options.browserOracle }));
  const runtime = new VerifiedSynthesisRuntime({ solver: solverFor(options.solver), oracles });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("operator cancelled verified synthesis"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runtime.run(input as SynthesisProblem, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "verified synthesis failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
