"use client";

import { useRef } from "react";
import { Reveal } from "@/components/ui/Reveal";
import { useLoopScope } from "@/lib/useNexusMotion";

const motors = [
  ["Estrategia", "Definimos con precisión y sentido de IA."],
  ["Experiencia", "Creamos cada clic pensado para impactar, conectar y fidelizar."],
  ["Datos", "Convertimos lo bruto en decisiones inteligentes."],
  ["Automatización", "Procesos que escalan sin esfuerzo, sin perder control."],
  ["Inteligencia", "Modelos predictivos que anticipan y optimizan."],
] as const;

export function Motores() {
  const ref = useRef<HTMLElement | null>(null);
  useLoopScope(ref);
  return (
    <section ref={ref} className="section loop-scope" data-running="false" aria-labelledby="motores-title">
      <div className="section-inner motors-layout">
        <div className="motors-intro">
          <Reveal><h2 id="motores-title" className="h2">CINCO MOTORES. UN SISTEMA VIVO.</h2></Reveal>
          <Reveal delay={80}><p className="copy">Diseñamos para que cada motor trabaje en armonía y potencie tus resultados.</p></Reveal>
          <Reveal delay={160}><p className="label">NO SON HERRAMIENTAS. ES UNA ARQUITECTURA INTELIGENTE.</p></Reveal>
        </div>
        <Reveal className="orbit-wrap" delay={80}>
          <svg className="orbit-svg" viewBox="0 0 600 600" role="img" aria-label="Diagrama orbital de los cinco motores de Nexus Bot Studio">
            <ellipse className="orbit-ellipse" cx="300" cy="300" rx="82" ry="48" />
            <ellipse className="orbit-ellipse" cx="300" cy="300" rx="138" ry="82" />
            <ellipse className="orbit-ellipse" cx="300" cy="300" rx="198" ry="118" />
            <ellipse className="orbit-ellipse" cx="300" cy="300" rx="254" ry="152" />
            <g className="orbit-core"><circle cx="300" cy="300" r="14" fill="white" opacity=".9" /><circle cx="300" cy="300" r="34" fill="white" opacity=".08" /></g>
            <g className="orbit-dot"><circle cx="300" cy="148" r="6" fill="white" /></g>
            <g className="orbit-dot d2"><circle cx="498" cy="300" r="6" fill="white" /></g>
            <g className="orbit-dot d3"><circle cx="300" cy="452" r="6" fill="white" /></g>
            <g className="orbit-dot d4"><circle cx="102" cy="300" r="6" fill="white" /></g>
            <g className="orbit-dot d5"><circle cx="440" cy="206" r="6" fill="white" /></g>
          </svg>
          <div className="desktop-orbit-labels" aria-hidden="true">
            {motors.map(([title, text], index) => <div key={title} className={`orbit-label l${index + 1}`}><h3>{title}</h3><p>{text}</p></div>)}
          </div>
        </Reveal>
        <div className="motor-list">
          {motors.map(([title, text], index) => <Reveal key={title} className="motor-item" delay={index * 80}><h3>{title}</h3><p>{text}</p></Reveal>)}
        </div>
      </div>
    </section>
  );
}
