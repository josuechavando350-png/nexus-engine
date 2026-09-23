"use client";

import { useState, type FormEvent } from "react";
import { site } from "./content";

const issues = [
  ["", "Selecciona el motivo de contacto"],
  ["Detención o urgencia", "Detención o urgencia"],
  ["Citatorio o audiencia", "Citatorio o audiencia"],
  ["Delitos fiscales o SAT", "Delitos fiscales o SAT"],
  ["Diagnóstico penal", "Diagnóstico penal"],
  ["Otra consulta penal", "Otra consulta penal"],
] as const;

export function ContactForm({ compact = false }: { compact?: boolean }) {
  const [name, setName] = useState("");
  const [issue, setIssue] = useState("");
  const [reply, setReply] = useState("");
  const [prepared, setPrepared] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = [
      "Hola, deseo contactar a CANO Estrategia Penal.",
      `Nombre: ${name.trim()}`,
      `Motivo general: ${issue}`,
      reply.trim() ? `Medio de respuesta: ${reply.trim()}` : "",
      "Prefiero compartir los detalles de forma privada con el despacho.",
    ].filter(Boolean).join("\n");
    const destination = `${site.whatsapp}?text=${encodeURIComponent(message)}`;
    setPrepared(true);
    window.location.assign(destination);
  }

  return (
    <form className={`cp-contact-form-live${compact ? " cp-contact-form-live-compact" : ""}`} onSubmit={submit}>
      <label>
        <span>Tu nombre</span>
        <input name="nombre" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={80} required placeholder="Nombre" />
      </label>
      <label>
        <span>¿Qué necesitas?</span>
        <select name="motivo" value={issue} onChange={(event) => setIssue(event.target.value)} required>
          {issues.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="cp-contact-form-full">
        <span>Teléfono o correo para responder (opcional)</span>
        <input name="respuesta" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={100} placeholder="Cómo prefieres que te contacten" />
      </label>
      <div className="cp-contact-form-full cp-contact-form-bottom">
        <p>Al continuar se abrirá WhatsApp con el mensaje preparado. No se envía ni se guarda este formulario en la web. Evita escribir datos sensibles del asunto.</p>
        <button className="cp-btn cp-btn-solid" type="submit">Comunícate conmigo →</button>
      </div>
      {prepared ? <p className="cp-contact-form-full" role="status">Si WhatsApp no se abrió, utiliza el botón flotante de contacto.</p> : null}
    </form>
  );
}
