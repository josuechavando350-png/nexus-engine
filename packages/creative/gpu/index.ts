import { assertCanonicalId, assertScope, lexicalCompare, type CreativeScope } from "../shared";

export type ShaderStage = "vertex" | "fragment" | "compute";
export type GPUBackend = "webgpu" | "webgl2" | "cpu";
export type GPUQualityTier = "low" | "medium" | "high" | "ultra";
export type GPUErrorCode = "INVALID_INPUT" | "SCOPE_MISMATCH" | "NO_SUPPORTED_BACKEND" | "BUDGET_EXCEEDED";

export class GPUError extends Error {
  constructor(readonly code: GPUErrorCode, message: string) {
    super(message);
    this.name = "GPUError";
  }
}

export type ShaderModuleDescriptor = Readonly<{
  shaderId: string;
  stage: ShaderStage;
  sourceDigest: `sha256:${string}`;
  entryPoint: string;
  requiredFeatures: readonly string[];
  estimatedCost: number;
}>;

export type GPUCapabilities = Readonly<{
  backend: GPUBackend;
  features: readonly string[];
  maxTextureDimension2D: number;
  maxStorageBufferBytes: number;
  score: number;
}>;

export type GPUPerformanceBudget = Readonly<{
  maxFrameTimeMs: number;
  maxEstimatedCost: number;
  preferredQuality: GPUQualityTier;
}>;

export type ShaderPipelineRequest = Readonly<{
  pipelineId: string;
  scope: CreativeScope;
  shaders: readonly ShaderModuleDescriptor[];
  capabilities: readonly GPUCapabilities[];
  budget: GPUPerformanceBudget;
}>;

export type ShaderPipelinePlan = Readonly<{
  pipelineId: string;
  scope: CreativeScope;
  backend: GPUBackend;
  quality: GPUQualityTier;
  shaderIds: readonly string[];
  estimatedCost: number;
  rationale: readonly string[];
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const QUALITY_ORDER: readonly GPUQualityTier[] = ["ultra", "high", "medium", "low"];
const BACKEND_ORDER: readonly GPUBackend[] = ["webgpu", "webgl2", "cpu"];

function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new GPUError("INVALID_INPUT", `${field} must be finite`);
}

function validateShader(shader: ShaderModuleDescriptor): void {
  try { assertCanonicalId(shader.shaderId, "shader.shaderId"); } catch (error) { throw new GPUError("INVALID_INPUT", error instanceof Error ? error.message : "invalid shader"); }
  if (!DIGEST.test(shader.sourceDigest)) throw new GPUError("INVALID_INPUT", "shader sourceDigest must be sha256");
  if (typeof shader.entryPoint !== "string" || !shader.entryPoint.trim()) throw new GPUError("INVALID_INPUT", "shader entryPoint is required");
  if (!Array.isArray(shader.requiredFeatures) || shader.requiredFeatures.some((feature) => typeof feature !== "string" || !feature.trim())) throw new GPUError("INVALID_INPUT", "shader requiredFeatures must be non-empty strings");
  finite(shader.estimatedCost, "shader.estimatedCost");
  if (shader.estimatedCost < 0) throw new GPUError("INVALID_INPUT", "shader estimatedCost must be non-negative");
}

function validateCapabilities(capability: GPUCapabilities): void {
  finite(capability.maxTextureDimension2D, "capability.maxTextureDimension2D");
  finite(capability.maxStorageBufferBytes, "capability.maxStorageBufferBytes");
  finite(capability.score, "capability.score");
  if (capability.maxTextureDimension2D <= 0 || capability.maxStorageBufferBytes < 0 || capability.score < 0 || capability.score > 1) {
    throw new GPUError("INVALID_INPUT", "GPU capability values are outside valid ranges");
  }
  if (!Array.isArray(capability.features) || capability.features.some((feature) => typeof feature !== "string" || !feature.trim())) throw new GPUError("INVALID_INPUT", "GPU capability features must be non-empty strings");
}

function qualityFor(cost: number, budget: GPUPerformanceBudget): GPUQualityTier {
  const ratio = budget.maxEstimatedCost === 0 ? Number.POSITIVE_INFINITY : cost / budget.maxEstimatedCost;
  const preferredIndex = QUALITY_ORDER.indexOf(budget.preferredQuality);
  const degradation = ratio <= 0.5 ? 0 : ratio <= 0.75 ? 1 : ratio <= 1 ? 2 : 3;
  return QUALITY_ORDER[Math.min(QUALITY_ORDER.length - 1, preferredIndex + degradation)]!;
}

export class DeterministicGPUPlanner {
  plan(request: ShaderPipelineRequest, scope: CreativeScope): ShaderPipelinePlan {
    try { assertCanonicalId(request.pipelineId, "pipeline.pipelineId"); assertScope(request.scope); assertScope(scope); } catch (error) { throw new GPUError("INVALID_INPUT", error instanceof Error ? error.message : "invalid pipeline"); }
    if (request.scope.tenantId !== scope.tenantId || request.scope.brandId !== scope.brandId) throw new GPUError("SCOPE_MISMATCH", "GPU pipeline scope mismatch");
    if (!Array.isArray(request.shaders) || !request.shaders.length) throw new GPUError("INVALID_INPUT", "pipeline requires shaders");
    request.shaders.forEach(validateShader);
    if (new Set(request.shaders.map((shader) => shader.shaderId)).size !== request.shaders.length) throw new GPUError("INVALID_INPUT", "shader IDs must be unique");
    if (!Array.isArray(request.capabilities) || !request.capabilities.length) throw new GPUError("NO_SUPPORTED_BACKEND", "no GPU capabilities supplied");
    request.capabilities.forEach(validateCapabilities);
    finite(request.budget.maxFrameTimeMs, "budget.maxFrameTimeMs");
    finite(request.budget.maxEstimatedCost, "budget.maxEstimatedCost");
    if (request.budget.maxFrameTimeMs <= 0 || request.budget.maxEstimatedCost <= 0) throw new GPUError("INVALID_INPUT", "GPU budgets must be positive");

    const requiredFeatures = [...new Set(request.shaders.flatMap((shader) => shader.requiredFeatures))].sort(lexicalCompare);
    const supported = request.capabilities.filter((capability) => requiredFeatures.every((feature) => capability.features.includes(feature)));
    if (!supported.length) throw new GPUError("NO_SUPPORTED_BACKEND", "no backend satisfies shader feature requirements");
    const backend = [...supported].sort((a, b) => b.score - a.score || BACKEND_ORDER.indexOf(a.backend) - BACKEND_ORDER.indexOf(b.backend))[0]!;
    const estimatedCost = request.shaders.reduce((sum, shader) => sum + shader.estimatedCost, 0);
    if (estimatedCost > request.budget.maxEstimatedCost) throw new GPUError("BUDGET_EXCEEDED", "estimated shader cost exceeds budget");
    const quality = qualityFor(estimatedCost, request.budget);
    const shaderIds = request.shaders.map((shader) => shader.shaderId).sort(lexicalCompare);
    return Object.freeze({
      pipelineId: request.pipelineId,
      scope: Object.freeze({ ...request.scope }),
      backend: backend.backend,
      quality,
      shaderIds: Object.freeze(shaderIds),
      estimatedCost,
      rationale: Object.freeze([`selected ${backend.backend} by capability score`, `quality ${quality} within cost budget`])
    });
  }
}
