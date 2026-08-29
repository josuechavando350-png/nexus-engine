"use client";

import { FormEvent, useState } from "react";

const FORMSPREE_ENDPOINT = "https://formspree.io/f/mwlkprdl";
const FORM_CONVERSION = "AW-11458109085/VHB1CKrijeocEJZ909cq";

type Gtag = (...args: unknown[]) => void;

type RuntimeWindow = typeof window & {
  dataLayer?: unknown[];
  gtag?: Gtag;
};

function trackFormConversion() {
  const runtime = window as RuntimeWindow;
  const dataLayer = (runtime.dataLayer ||= []);
  const gtag: Gtag = runtime.gtag || ((...args: unknown[]) => dataLayer.push(args));
  runtime.gtag = gtag;
  gtag("event", "conversion", {
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

      trackFormConversion();
      form.reset();
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form className="cp-form" onSubmit={handleSubmit}>
      <input aria-label="Nombre" name="nombre" placeholder="Nombre" required />
      <input aria-label="Teléfono" name="telefono" placeholder="Teléfono" required />
      <input className="full" aria-label="Correo" name="correo" type="email" placeholder="Correo" required />
      <textarea className="full" aria-label="Mensaje" name="mensaje" placeholder="Mensaje" required />
      <button className="cp-btn cp-btn-solid cp-contact-action full" type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Enviando…" : "Enviar consulta"}
      </button>
      <p className="full" role="status" aria-live="polite">
        {status === "success" ? "Gracias. Tu mensaje fue enviado correctamente." : ""}
        {status === "error" ? "No pudimos enviar tu mensaje. Inténtalo de nuevo o contáctanos por WhatsApp." : ""}
      </p>
    </form>
  );
}
