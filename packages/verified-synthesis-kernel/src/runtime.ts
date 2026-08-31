import { VerifiedSynthesisKernel } from "./kernel.js";
import type { CounterexampleOracle, SynthesisProblem, SynthesisSolver, VerifiedSynthesisResult } from "./types.js";

export interface VerifiedSynthesisRuntimeOptions {
  readonly solver: SynthesisSolver;
  readonly oracles?: readonly CounterexampleOracle[];
}

export class VerifiedSynthesisRuntime {
  readonly #kernel: VerifiedSynthesisKernel;
  constructor(options: VerifiedSynthesisRuntimeOptions) {
    this.#kernel = new VerifiedSynthesisKernel(options);
  }

  run(problem: SynthesisProblem, signal?: AbortSignal): Promise<VerifiedSynthesisResult> {
    return this.#kernel.synthesize(problem, signal ?? new AbortController().signal);
  }
}
