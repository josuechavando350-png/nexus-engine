import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { CwvBuildOptimizationAction, CwvBuildOptimizationAdapter, CwvOptimizationKind, CwvOptimizationReceipt } from "@nexus/core/cortex/cwv-lifecycle-pipeline";
import { optimizeImage, type CandidatePolicy, type ToolPaths } from "@nexus/perceptual-images";

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function safeChild(root: string, target: string): string {
  const normalizedRoot = resolve(root);
  const resolved = resolve(normalizedRoot, `.${target.startsWith("/") ? target : `/${target}`}`);
  const rel = relative(normalizedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`CWV target escapes configured root: ${target}`);
  return resolved;
}

export class CwvBuildAdapterRegistry implements CwvBuildOptimizationAdapter {
  constructor(private readonly adapters: Readonly<Partial<Record<CwvOptimizationKind, CwvBuildOptimizationAdapter>>>) {}

  async apply(action: CwvBuildOptimizationAction): Promise<CwvOptimizationReceipt> {
    const adapter = this.adapters[action.kind];
    if (!adapter) throw new Error(`no real CWV build adapter is registered for ${action.kind}`);
    return adapter.apply(action);
  }
}

export interface PerceptualImageCwvAdapterConfig {
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly tools: ToolPaths;
  readonly policy?: CandidatePolicy;
}

export class PerceptualImageCwvAdapter implements CwvBuildOptimizationAdapter {
  constructor(private readonly config: PerceptualImageCwvAdapterConfig) {
    if (!isAbsolute(config.inputRoot) || !isAbsolute(config.outputRoot)) throw new Error("perceptual image CWV roots must be absolute paths");
  }

  async apply(action: CwvBuildOptimizationAction): Promise<CwvOptimizationReceipt> {
    if (action.kind !== "IMAGE_PERCEPTUAL") throw new Error(`PerceptualImageCwvAdapter cannot apply ${action.kind}`);
    const sourcePath = safeChild(this.config.inputRoot, action.target);
    const report = await optimizeImage({
      sourcePath,
      outputDir: this.config.outputRoot,
      tools: this.config.tools,
      ...(this.config.policy === undefined ? {} : { policy: this.config.policy }),
    });
    if (!SHA256_HEX.test(report.sourceSha256) || !SHA256_HEX.test(report.digest)) throw new Error("perceptual image optimizer returned invalid digest evidence");
    const selected = Object.values(report.selected).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined).sort((left, right) => left.codec.localeCompare(right.codec));
    const afterDigest = selected.length
      ? sha256(selected.map((entry) => `${entry.codec}:${entry.outputSha256}:${entry.bytes}:${entry.score}`).join("|"))
      : `sha256:${report.sourceSha256}` as const;
    return Object.freeze({
      actionId: action.actionId,
      kind: action.kind,
      status: report.status === "READY" && selected.length > 0 ? "APPLIED" : "NO_CHANGE",
      beforeDigest: `sha256:${report.sourceSha256}`,
      afterDigest,
      evidenceDigest: `sha256:${report.digest}`,
    });
  }
}
