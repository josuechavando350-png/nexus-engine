import { parentPort, workerData } from 'node:worker_threads';
import { executeMirrorSchedule } from './mirror-agent.mjs';
try {
  const { spec, replica, fault } = workerData;
  parentPort.postMessage({ ok: true, result: executeMirrorSchedule(spec, replica, fault) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message, failureStep: error.failureStep ?? null, partialTrace: error.partialTrace ?? null });
}
