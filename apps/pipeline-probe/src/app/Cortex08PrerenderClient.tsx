"use client";

import { useEffect } from "react";
import {
  createInteractionPointerPrerenderer,
  parseInteractionPointerControl,
  type InteractionPointerControl,
  type InteractionPointerDecision,
} from "@nexus/core/cortex/interaction-pointer-prerenderers";

const CONTROL_ENDPOINT = "/api/cortex/prerender/control";
const OBSERVE_ENDPOINT = "/api/cortex/prerender/observe";
const CONTROL_RECONCILE_MS = 5_000;

async function readControl(): Promise<unknown> {
  const response = await fetch(CONTROL_ENDPOINT, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error("CORTEX_08_CONTROL_UNAVAILABLE");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 2048)) throw new Error("CORTEX_08_CONTROL_TOO_LARGE");
  return response.json();
}

async function readEffectiveControl(): Promise<InteractionPointerControl> {
  const control = parseInteractionPointerControl(await readControl());
  if (document.documentElement.dataset.nexusCortex13SuspendSpeculation === "1") {
    return Object.freeze({ ...control, mode: "OBSERVE_ONLY" as const });
  }
  return control;
}

function observe(decision: InteractionPointerDecision): void {
  const body = JSON.stringify({ signal: decision.signal, action: decision.action, reason: decision.reason });
  void fetch(OBSERVE_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => undefined);
}

export function Cortex08PrerenderClient() {
  useEffect(() => {
    const runtime = createInteractionPointerPrerenderer({ controlProvider: readEffectiveControl, onDecision: observe });
    const reconcile = async () => {
      try {
        if ((await readEffectiveControl()).mode !== "ACTIVE") runtime.rollback();
      } catch {
        runtime.rollback();
      }
    };

    runtime.start();
    void reconcile();
    const interval = window.setInterval(() => { void reconcile(); }, CONTROL_RECONCILE_MS);
    return () => {
      window.clearInterval(interval);
      runtime.stop();
      runtime.rollback();
    };
  }, []);

  return null;
}
