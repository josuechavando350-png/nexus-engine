import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { optimizeImage, type CandidatePolicy, type ToolPaths } from "./index";

export interface CwvPerceptualImageAction {
  readonly actionId: string;
  readonly kind: "IMAGE_PERCEPTUAL";
  readonly target: string;
  readonly required: boolean;
}
export interface CwvPerceptualImageReceipt {
  readonly actionId: string;
  readonly kind: "IMAGE_PERCEPTUAL";
  readonly status: "APPLIED" | "NO_CHANGE";
  readonly beforeDigest: `sha256:${string}`;
  readonly afterDigest: `sha256:${string}`;
  readonly evidenceDigest: `sha256:${string}`;
}
export interface PerceptualImageCwvAdapterConfig { readonly inputRoot: string; readonly outputRoot: string; readonly tools: ToolPaths; readonly policy?: CandidatePolicy; }

function sha256(value: string): `sha256:${string}` { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function safeChild(root: string, target: string): string {
  const normalizedRoot = resolve(root); const resolved = resolve(normalizedRoot, `.${target.startsWith("/") ? target : `/${target}`}`); const rel = relative(normalizedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`CWV image target escapes configured root: ${target}`);
  return resolved;
}

export class PerceptualImageCwvAdapter {
  constructor(private readonly config: PerceptualImageCwvAdapterConfig) {
    if (!isAbsolute(config.inputRoot) || !isAbsolute(config.outputRoot)) throw new Error("CWV perceptual image roots must be absolute");
  }

  async apply(action: CwvPerceptualImageAction): Promise<CwvPerceptualImageReceipt> {
    if (action.kind !== "IMAGE_PERCEPTUAL") throw new Error("PerceptualImageCwvAdapter only accepts IMAGE_PERCEPTUAL actions");
    const report = await optimizeImage({ sourcePath: safeChild(this.config.inputRoot, action.target), outputDir: this.config.outputRoot, tools: this.config.tools, ...(this.config.policy === undefined ? {} : { policy: this.config.policy }) });
    if (!/^[0-9a-f]{64}$/u.test(report.sourceSha256) || !/^[0-9a-f]{64}$/u.test(report.digest)) throw new Error("perceptual optimizer returned invalid digest evidence");
    const selected = Object.values(report.selected).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined).sort((left, right) => left.codec.localeCompare(right.codec));
    return Object.freeze({
      actionId: action.actionId,
      kind: "IMAGE_PERCEPTUAL",
      status: report.status === "READY" && selected.length > 0 ? "APPLIED" : "NO_CHANGE",
      beforeDigest: `sha256:${report.sourceSha256}`,
      afterDigest: selected.length ? sha256(selected.map((entry) => `${entry.codec}:${entry.outputSha256}:${entry.bytes}:${entry.score}`).join("|")) : `sha256:${report.sourceSha256}`,
      evidenceDigest: `sha256:${report.digest}`,
    });
  }
}
