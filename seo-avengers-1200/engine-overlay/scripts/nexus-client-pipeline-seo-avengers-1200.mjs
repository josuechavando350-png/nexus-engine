import {
  runNexusClientPipeline,
  runNexusClientPipelineWithWorkspaceRuntime,
} from "../../../scripts/nexus-client-pipeline.mjs";
import { enqueueSeoAvengersGeneratedCopy } from "../../../seo-avengers-200/scripts/seo-avengers-200-outbox.mjs";
import { enqueueSeoAvengers1200Run } from "../../scripts/seo-avengers-1200-outbox.mjs";

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

async function persistAvengersSidecarsAfterNativePipeline(spec, result) {
  // The native Nexus verdict is authoritative. Sidecars only receive work after
  // a real render PASS and never mutate the returned native result.
  if (!spec?.outputDir || !renderPassed(result)) return result;

  await enqueueSeoAvengersGeneratedCopy({
    projectDir: spec.outputDir,
    locale: spec.locale,
    sourceRevision: spec.sourceRevision,
    copy: resolvedGeneratedCopy(result, spec),
  });

  // No synthetic telemetry is derived from stage logs. The extended runtime is
  // queued only when its typed source payload was explicitly provided upstream.
  if (spec.seoAvengers1200Input) {
    await enqueueSeoAvengers1200Run({
      projectDir: spec.outputDir,
      sourceRevision: spec.sourceRevision,
      payload: spec.seoAvengers1200Input,
      runtimeConfig: spec.seoAvengers1200Config ?? {},
    });
  }

  return result;
}

export async function runNexusClientPipelineWithSeoAvengers1200(spec, adapters = {}) {
  const result = await runNexusClientPipeline(spec, adapters);
  return persistAvengersSidecarsAfterNativePipeline(spec, result);
}

export async function runNexusClientPipelineWithWorkspaceRuntimeAndSeoAvengers1200(spec, options = {}) {
  const result = await runNexusClientPipelineWithWorkspaceRuntime(spec, options);
  return persistAvengersSidecarsAfterNativePipeline(spec, result);
}
