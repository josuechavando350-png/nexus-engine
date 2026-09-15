"use client";
import { useEffect, useState } from "react";
export function SplashScreen() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (sessionStorage.getItem("nexus-intro-seen")) { setVisible(false); return; }
    document.documentElement.dataset.intro = "active";
    const timer = window.setTimeout(() => { sessionStorage.setItem("nexus-intro-seen", "true"); delete document.documentElement.dataset.intro; setVisible(false); }, 1400);
    return () => { window.clearTimeout(timer); delete document.documentElement.dataset.intro; };
  }, []);
  if (!visible) return null;
  return <div className="splash" role="status" aria-label="Cargando Nexus Bot Studio"><div className="splash-mark" aria-hidden="true"><strong>NEXUS</strong><span>BOT STUDIO</span><i/><p>Desarrollando experiencias digitales.</p></div></div>;
}
