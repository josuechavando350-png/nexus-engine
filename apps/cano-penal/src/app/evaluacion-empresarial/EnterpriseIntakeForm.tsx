"use client";

import { useState, type FormEvent } from "react";
import { site } from "../content";

const authorityOptions = [
  ["", "Selecciona una opción"],
  ["SAT", "SAT"],
  ["PFF", "Procuraduría Fiscal de la Federación"],
  ["FGR", "Fiscalía General de la República"],
  ["FGJ-CDMX", "Fiscalía General de Justicia CDMX"],
  ["OTRA", "Otra autoridad"],
  ["NO-SE", "Aún no lo sé"],
] as const;

export function EnterpriseIntakeForm() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [authority, setAuthority] = useState("");
  const [deadline, setDeadline] = useState("");
  const [reply, setReply] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = [
      "Hola, deseo solicitar una evaluación confidencial con CANO Estrategia Penal.",
      `Nombre: ${name.trim()}`,
      role.trim() ? `Cargo o relación con el asunto: ${role.trim()}` : "",
      authority ? `Autoridad involucrada: ${authority}` : "",
      deadline.trim() ? `Fecha o plazo relevante: ${deadline.trim()}` : "",
      reply.trim() ? `Medio de contacto: ${reply.trim()}` : "",
      "Prefiero compartir documentos y detalles sensibles por un canal adecuado después de la revisión inicial.",
    ].filter(Boolean).join("\n");
    window.location.assign(`${site.whatsapp}?text=${encodeURIComponent(message)}`);
  }

  return (
    <form className="cp-enterprise-intake" onSubmit={submit} data-nexus-signal="enterprise-intake">
      <label><span>Nombre</span><input value={name} onChange={(e)=>setName(e.target.value)} maxLength={80} required autoComplete="name" /></label>
      <label><span>Cargo o relación con el asunto</span><input value={role} onChange={(e)=>setRole(e.target.value)} maxLength={100} placeholder="Director, socio, representante, contador…" /></label>
      <label><span>Autoridad involucrada</span><select value={authority} onChange={(e)=>setAuthority(e.target.value)}>{authorityOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>¿Existe una fecha o plazo próximo?</span><input value={deadline} onChange={(e)=>setDeadline(e.target.value)} maxLength={80} placeholder="Ej. citatorio, audiencia, requerimiento" /></label>
      <label className="cp-enterprise-intake-full"><span>Teléfono o correo</span><input value={reply} onChange={(e)=>setReply(e.target.value)} maxLength={100} required /></label>
      <div className="cp-enterprise-intake-full cp-enterprise-intake-bottom">
        <p>No incluyas documentos, datos bancarios, contraseñas ni información sensible en este formulario.</p>
        <button type="submit" className="cp-btn cp-btn-solid" data-nexus-signal="enterprise-submit-whatsapp">Solicitar evaluación confidencial →</button>
      </div>
    </form>
  );
}
