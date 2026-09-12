import {
  runNexusClientPipeline,
  runNexusClientPipelineWithWorkspaceRuntime,
} from "../../../scripts/nexus-client-pipeline.mjs";
import { enqueueSeoAvengers2500Run } from "../../scripts/seo-avengers-2500-outbox.mjs";

function renderPassed(result) {
  return Array.isArray(result?.stageLog)
    && result.stageLog.some((entry) => entry?.stage === "RENDER" && entry?.verdict === "PASS");
}

async function persistAvengers2500AfterNativePipeline(spec, result) {
  // Native Nexus remains authoritative. The SEO sidecar never changes the
  // pipeline verdict/result and receives work only after a real RENDER PASS.
  if (!spec?.outputDir || !renderPassed(result)) return result;

  // No telemetry is synthesized from stage logs. Production evidence must be
  // supplied explicitly by authorized collectors/adapters.
  if (spec.seoAvengers2500Input) {
    await enqueueSeoAvengers2500Run({
      projectDir: spec.outputDir,
      sourceRevision: spec.sourceRevision,
      payload: spec.seoAvengers2500Input,
      runtimeConfig: spec.seoAvengers2500Config ?? {},
    });
  }

  return result;
}

export async function runNexusClientPipelineWithSeoAvengers2500(spec, adapters = {}) {
  const result = await runNexusClientPipeline(spec, adapters);
  return persistAvengers2500AfterNativePipeline(spec, result);
}

export async function runNexusClientPipelineWithWorkspaceRuntimeAndSeoAvengers2500(spec, options = {}) {
  const result = await runNexusClientPipelineWithWorkspaceRuntime(spec, options);
  return persistAvengers2500AfterNativePipeline(spec, result);
}
