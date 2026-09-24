"use client";

import { useEffect, useState } from "react";

const SPLASH_SESSION_KEY = "cano:splash-shown:v1";

export function HomeSplash() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SPLASH_SESSION_KEY) === "1") return;
      window.sessionStorage.setItem(SPLASH_SESSION_KEY, "1");
    } catch {
      // If session storage is unavailable, show the home splash once for this mount.
    }

    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 2350);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="cp-splash" aria-hidden="true">
      <div className="cp-splash-inner">
        <div className="cp-splash-logo-wrap">
          <img className="cp-splash-logo" src="/media/logo-cano.png" alt="" />
        </div>
        <div className="cp-splash-line" />
        <p>EXPERIENCIA DESDE DENTRO. DEFENSA DE FRENTE.</p>
      </div>
    </div>
  );
}
