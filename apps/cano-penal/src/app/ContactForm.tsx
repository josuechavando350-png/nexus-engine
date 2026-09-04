"use client";

import { FormEvent, useState } from "react";

const FORMSPREE_ENDPOINT = "https://formspree.io/f/mwlkprdl";
const FORM_CONVERSION = "AW-11458109085/tbcxCLLLwO4cEJ2909cq";

type Gtag = (...args: unknown[]) => void;

type RuntimeWindow = typeof window & {
  gtag?: Gtag;
};

function trackFormConversion() {
  (window as RuntimeWindow).gtag?.("event", "conversion", {
    send_to: FORM_CONVERSION,
    value: 1.0,
    currency: "MXN",
  });
}

export function ContactForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;

    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus("sending");

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        body: data,
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) throw new Error("Formspree submission failed");
    } catch {
      setStatus("error");
      return;
    }

    try {
      trackFormConversion();
    } catch {
      // Tracking must never turn a successful Formspree submission into an error.
    }

    form.reset();
    setStatus("success");
  }

  return (
    <form className="cp-form" onSubmit={handleSubmit}>
      <input aria-label="Nombre" name="nombre" placeholder="Nombre" required />
      <input aria-label="Teléfono" name="telefono" placeholder="Teléfono" required />
      <input className="full" aria-label="Correo" name="correo" type="email" placeholder="Correo" required />
      <textarea className="full" aria-label="Mensaje" name="mensaje" placeholder="Mensaje" required />
      <button
        type="submit"
        disabled={status === "sending"}
        aria-busy={status === "sending"}
        style={{
          gridColumn: "1 / -1",
          width: "100%",
          minHeight: "52px",
          marginTop: "8px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--accent-default)",
          background: "var(--accent-default)",
          color: "var(--content-inverse)",
          textTransform: "uppercase",
          letterSpacing: ".12em",
          fontSize: "12px",
          fontWeight: 700,
          cursor: status === "sending" ? "wait" : "pointer",
          opacity: status === "sending" ? 0.7 : 1,
        }}
      >
        {status === "sending" ? "Enviando…" : "Enviar consulta"}
      </button>
      <p className="full" role="status" aria-live="polite" style={{ margin: 0 }}>
        {status === "success" ? "Gracias. Tu mensaje fue enviado correctamente." : ""}
        {status === "error" ? "No pudimos enviar tu mensaje. Inténtalo de nuevo o contáctanos por WhatsApp." : ""}
      </p>
    </form>
  );
}
