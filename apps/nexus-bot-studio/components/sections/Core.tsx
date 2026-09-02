"use client";

import { CSSProperties, useRef } from "react";
import { Card } from "@/components/ui/Card";
import { Reveal } from "@/components/ui/Reveal";
import { useCoreExplode } from "@/lib/useNexusMotion";

const layers = [
  "Experiencia de usuario",
  "Servicios Core",
  "Inteligencia artificial",
  "Datos",
  "Infraestructura y tecnología propia",
] as const;

export function Core() {
  const ref = useRef<HTMLElement | null>(null);
  useCoreExplode(ref);
  return (
    <section ref={ref} className="section" aria-labelledby="core-title">
      <div className="section-inner core-layout">
        <div className="core-copy">
          <Reveal><p className="section-kicker">NEXUS CORE:</p></Reveal>
          <Reveal delay={80}><h2 id="core-title" className="h2">ARQUITECTURA QUE SOSTIENE EL SISTEMA.</h2></Reveal>
          <Reveal delay={160}><p className="copy">Infraestructura propia. Algoritmos avanzados. Escalable, segura y diseñada para evolucionar contigo. Tu visión. Nuestro talento. La ventaja es tuya.</p></Reveal>
        </div>
        <div className="core-stage">
          <Reveal className="core-layers">
            {layers.map((layer, index) => (
              <Card key={layer} className="core-layer" style={{ "--i": index } as CSSProperties}>
                <span className="sr-only">{layer}</span>
              </Card>
            ))}
            <svg className="core-connectors" viewBox="0 0 640 420" aria-hidden="true">
              <path d="M90 90 C 210 90, 220 145, 330 145" pathLength="160" />
              <path d="M90 142 C 210 142, 220 200, 330 200" pathLength="160" />
              <path d="M90 194 C 210 194, 220 255, 330 255" pathLength="160" />
              <path d="M90 246 C 210 246, 220 310, 330 310" pathLength="160" />
              <path d="M90 298 C 210 298, 220 365, 330 365" pathLength="160" />
            </svg>
          </Reveal>
          <div className="core-labels">
            {layers.map((layer, index) => <Reveal key={layer} delay={index * 80}><Card className="core-label">{layer}</Card></Reveal>)}
          </div>
        </div>
      </div>
    </section>
  );
}
