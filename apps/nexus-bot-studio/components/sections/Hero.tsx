"use client";

import Image from "next/image";
import { useRef } from "react";
import { useHeroParallax, useLoopScope } from "@/lib/useNexusMotion";

export function Hero() {
  const ref = useRef<HTMLElement | null>(null);
  useLoopScope(ref);
  useHeroParallax(ref);
  return (
    <section ref={ref} className="section hero loop-scope" data-running="false" aria-labelledby="hero-title">
      <div className="hero-media" aria-hidden="true">
        <Image className="hero-face" src="/hero.webp" alt="" fill priority sizes="100vw" />
        <div className="hero-overlay" />
        <div className="hero-hud">
          <div className="hero-ring" />
          <div className="hero-ring" />
          <div className="hero-ring" />
        </div>
      </div>
      <div className="section-inner hero-content">
        <h1 id="hero-title" className="display hero-title">
          <span className="hero-title-line">CREAMOS</span>
          <span className="hero-title-line">SISTEMAS QUE</span>
          <span className="hero-title-line">SORPRENDEN.</span>
        </h1>
        <div className="hero-copy">
          <p>Diseño de alto nivel. Tecnología propia.</p>
          <p>Inteligencia que trabaja por tu negocio.</p>
        </div>
        <p className="label hero-meta">NEXUS BOT STUDIO — MÉXICO</p>
      </div>
    </section>
  );
}
