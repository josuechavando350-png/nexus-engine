"use client";

import { useEffect } from "react";
import { createBehavioralBrowserCollector } from "@nexus/ontology/cortex/behavioral-signal-tracking/browser-collector";

const SESSION_KEY = "nexus:behavioral:session:v1";
const CONSENT_COOKIE = "nexus_behavioral_consent";
const DECISION_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

function sessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing && existing.length >= 8 && existing.length <= 256) return existing;
    const created = `ses:${crypto.randomUUID()}`;
    window.sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return `ses:${crypto.randomUUID()}`;
  }
}

function privacyDecision() {
  const prefix = `${CONSENT_COOKIE}=`;
  const raw = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
  if (!raw) return { collectionAllowed: false, privacyDecisionRef: null } as const;
  let value: string;
  try { value = decodeURIComponent(raw.slice(prefix.length)); } catch { return { collectionAllowed: false, privacyDecisionRef: null } as const; }
  const separator = value.indexOf(":");
  if (separator <= 0 || value.slice(0, separator) !== "granted") return { collectionAllowed: false, privacyDecisionRef: null } as const;
  const ref = value.slice(separator + 1);
  if (!DECISION_REF.test(ref)) return { collectionAllowed: false, privacyDecisionRef: null } as const;
  return { collectionAllowed: true, privacyDecisionRef: ref } as const;
}

export function NexusBehavioralSignals() {
  useEffect(() => {
    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/nexus/behavioral",
      siteId: "cano-penal",
      surfaceId: "cano-site",
      sessionId: sessionId(),
      privacy: privacyDecision,
      signalAttribute: "data-nexus-signal",
      maxRetries: 2,
      retryDelayMs: 300,
    });
    collector.start();
    return () => {
      collector.stop();
      void collector.drain();
    };
  }, []);

  return null;
}
