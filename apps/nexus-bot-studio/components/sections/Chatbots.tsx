"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Reveal } from "@/components/ui/Reveal";
import { useLoopScope } from "@/lib/useNexusMotion";

const messages = [
  { role: "ia", text: "¿En qué puedo ayudarte hoy?" },
  { role: "user", text: "Quiero saber cómo funciona el servicio." },
  { role: "ia", text: "Puedo darte más info sobre Agentes de IA." },
  { role: "user", text: "Quiero una IA que conversa, ayuda y convierte." },
] as const;

const features = [
  "Entrenados 100% con tu conocimiento: tu sitio, tus productos, tus servicios y tus datos.",
  "Responden al instante con IA que entiende tu negocio y tus clientes.",
  "Calificados y conectados: capturan leads, filtran y los envían de vuelta.",
  "Memoria de largo plazo: recuerdan lo que importa en cada conversación.",
  "Escalan conversaciones: atienden miles sin perder calidad, tono ni contexto.",
] as const;

function ChatSequence() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setVisibleCount(messages.length); return; }
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 250;
    messages.forEach((message, index) => {
      if (message.role === "ia") {
        timers.push(setTimeout(() => !cancelled && setTyping(true), elapsed));
        elapsed += 800;
        timers.push(setTimeout(() => {
          if (cancelled) return;
          setTyping(false);
          setVisibleCount(index + 1);
        }, elapsed));
      } else {
        elapsed += 400;
        timers.push(setTimeout(() => !cancelled && setVisibleCount(index + 1), elapsed));
      }
      elapsed += 400;
    });
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, []);

  return (
    <div className="chat-stack" aria-live="polite">
      {messages.map((message, index) => (
        <div key={`${message.role}-${index}`} className={`chat-bubble ${message.role === "user" ? "user" : ""} ${index < visibleCount ? "visible" : ""}`}>
          {message.text}
        </div>
      ))}
      {typing && <div className="typing" aria-label="La IA está escribiendo"><span /><span /><span /></div>}
    </div>
  );
}

export function Chatbots() {
  const ref = useRef<HTMLElement | null>(null);
  useLoopScope(ref);
  return (
    <section ref={ref} className="section loop-scope" data-running="false" aria-labelledby="chatbots-title">
      <div className="section-inner chat-layout">
        <div className="chat-copy">
          <Reveal><h2 id="chatbots-title" className="h2">CHATBOTS AVANZADOS.</h2></Reveal>
          <Reveal delay={80}><p className="copy">Conversaciones que entienden, responden y resuelven. La interacción que convierte en clientes y en operación. Integrados con IA.</p></Reveal>
        </div>
        <div>
          <div className="chat-panel">
            <Reveal>
              <div className="chat-mockup">
                <div className="chat-top"><span className="chat-brand">NEXUS CHAT</span><span aria-hidden="true">•••</span></div>
                <ChatSequence />
              </div>
            </Reveal>
            <div className="chat-features">
              {features.map((feature, index) => (
                <Reveal key={feature} delay={index * 150}>
                  <Card className="chat-feature">
                    <Image src="/hex.webp" alt="" width={44} height={44} aria-hidden="true" />
                    <p>{feature}</p>
                  </Card>
                </Reveal>
              ))}
            </div>
          </div>
          <Reveal className="chat-foot"><p>Tecnología de élite para empresas que quieren más.</p></Reveal>
          <Reveal delay={80}><p className="chat-close">¿NO NOS CREES? PREGÚNTASELO A TU IA.</p></Reveal>
        </div>
      </div>
    </section>
  );
}
