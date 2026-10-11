// El Interruptor: prende, pone en preparación o apaga SUPERSEO en un cliente.
// Apagar nunca rompe el sitio: las páginas de SUPERSEO redirigen (301) a su
// página de servicio, y el sitio base sigue funcionando igual.
import { SuperSeoError, deepFreeze } from "./canonical.mjs";
import { ESTADOS, PLANES } from "./catalogo.mjs";
import { conflictosDe } from "./territorio.mjs";
import { validarPerfil } from "./perfil.mjs";

export function resolverExposicion(perfil) {
  const on = perfil.estado === "ON";
  const prep = perfil.estado === "PREPARACION";
  return deepFreeze({
    estado: perfil.estado,
    publica_paginas: on,
    exponer: {
      paginas_superseo: on,
      sitemap_superseo: on,
      schema_extendido: on,
      analitica_propia: on || prep,
    },
    robots_paginas_superseo: on ? "index,follow" : "noindex,follow",
    redirige_paginas_superseo: perfil.estado === "OFF",
  });
}

// paginas: [{ ruta, servicio }] generadas por SUPERSEO para este cliente.
export function planDeApagado(perfil, paginas) {
  const rutaDeServicio = new Map(perfil.servicios.map((s) => [s.slug, s.ruta]));
  const desde = new Set(paginas.map((p) => p.ruta));
  const plan = paginas.map((p) => {
    if (typeof p.ruta !== "string" || !p.ruta.startsWith("/")) {
      throw new SuperSeoError("PAGINA_INVALIDA", String(p.ruta));
    }
    let hacia = rutaDeServicio.get(p.servicio) ?? "/";
    if (desde.has(hacia) || hacia === p.ruta) hacia = "/";
    return { desde: p.ruta, hacia, codigo: 301 };
  });
  return deepFreeze(plan.sort((a, b) => a.desde.localeCompare(b.desde)));
}

function conHistorial(perfil, cambios, accion, detalle, ahora) {
  const en = (ahora ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return validarPerfil({
    ...JSON.parse(JSON.stringify(perfil)),
    ...cambios,
    historial: [...perfil.historial, { en, accion, detalle }],
  });
}

export function cambiarEstado(perfil, nuevo, { cartera = [], ahora, motivo = "" } = {}) {
  if (!ESTADOS.includes(nuevo)) throw new SuperSeoError("ESTADO_INVALIDO", nuevo);
  if (perfil.estado === nuevo) return perfil;
  if (nuevo !== "OFF") {
    const bloqueos = conflictosDe({ ...perfil, estado: nuevo }, cartera).filter((c) => c.severidad === "BLOQUEO");
    if (bloqueos.length) {
      throw new SuperSeoError("TERRITORIO_OCUPADO", bloqueos.map((b) => `${b.clientes.join(" vs ")} en ${b.especialidades.join(", ")}`).join("; "));
    }
  }
  const verbo = { ON: "encender", PREPARACION: "preparar", OFF: "apagar" }[nuevo];
  return conHistorial(perfil, { estado: nuevo }, verbo, motivo || `${perfil.estado} → ${nuevo}`, ahora);
}

export function cambiarPlan(perfil, plan, { ahora } = {}) {
  if (!(plan in PLANES)) throw new SuperSeoError("PLAN_INVALIDO", plan);
  if (perfil.plan === plan) return perfil;
  return conHistorial(perfil, { plan }, "plan", `${perfil.plan} → ${plan}`, ahora);
}

export function cambiarInsumo(perfil, insumo, valor, { ahora } = {}) {
  if (!(insumo in perfil.insumos)) throw new SuperSeoError("INSUMO_INVALIDO", insumo);
  const insumos = { ...perfil.insumos, [insumo]: valor };
  return conHistorial(perfil, { insumos }, "insumo", `${insumo} = ${valor === null ? "ninguno" : valor}`, ahora);
}
