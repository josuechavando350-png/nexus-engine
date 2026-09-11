import {
  runNexusClientPipeline,
  runNexusClientPipelineWithWorkspaceRuntime,
} from "../../scripts/nexus-client-pipeline.mjs";
import { enqueueSeoAvengersGeneratedCopy } from "./seo-avengers-200-outbox.mjs";

function renderPassed(result) {
  return Array.isArray(result?.stageLog)
    && result.stageLog.some((entry) => entry?.stage === "RENDER" && entry?.verdict === "PASS");
}

function resolvedGeneratedCopy(result, spec) {
  if (Array.isArray(result?.copySynthesis?.items) && result.copySynthesis.items.length > 0) {
    return result.copySynthesis.items.map((item) => ({ role: item.role, text: item.text }));
  }
  return Array.isArray(spec?.generatedCopy) ? spec.generatedCopy : [];
}

async function persistSeoSidecarAfterNativePipeline(spec, result) {
  // Never let the premium sidecar change a native pipeline verdict.
  // The enqueue helper itself is fail-closed and does zero filesystem/network
  // work when CONFIG_SEO_AVENGERS_200 is absent/false.
  if (!spec?.outputDir || !renderPassed(result)) return result;
  await enqueueSeoAvengersGeneratedCopy({
    projectDir: spec.outputDir,
    locale: spec.locale,
    sourceRevision: spec.sourceRevision,
    copy: resolvedGeneratedCopy(result, spec),
  });
  return result;
}

export async function runNexusClientPipelineWithSeoAvengers200(spec, adapters = {}) {
  const result = await runNexusClientPipeline(spec, adapters);
  return persistSeoSidecarAfterNativePipeline(spec, result);
}

export async function runNexusClientPipelineWithWorkspaceRuntimeAndSeoAvengers200(spec, options = {}) {
  const result = await runNexusClientPipelineWithWorkspaceRuntime(spec, options);
  return persistSeoSidecarAfterNativePipeline(spec, result);
}
