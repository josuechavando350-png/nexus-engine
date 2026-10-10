// Reporte SUPERSEO en español: lo que el dueño del negocio necesita leer.
const SEV = { CRITICO: "Crítico", ALTO: "Alto", MEDIO: "Medio", BAJO: "Bajo" };
const ESTADO = { OFF: "Apagado", PREPARACION: "En preparación", ON: "Encendido" };

function celda(t) {
  return String(t ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function generarReporte({ perfil, estrategia, auditoria = null, avengers = null, grafo = null, searchConsole = null, lote = null, paginas = null, ahora = new Date() }) {
  const fecha = ahora.toISOString().slice(0, 10);
  const l = [];
  l.push(`# SUPERSEO · ${perfil.nombre}`);
  l.push("");
  l.push(`${fecha} · ${perfil.dominio} · ${ESTADO[perfil.estado]} · Plan ${estrategia.plan.nombre} · ${estrategia.rubro.nombre}`);
  l.push("");

  const partes = [`potencia ${estrategia.potencia.puntos}/100 (${estrategia.potencia.nivel.toLowerCase()})`];
  if (auditoria) partes.unshift(`salud técnica ${auditoria.salud}/100 con ${auditoria.conteo.CRITICO} problemas críticos y ${auditoria.conteo.ALTO} altos`);
  if (avengers) partes.push(`${avengers.modulos} módulos Avengers ejecutados con ${avengers.total_hallazgos} hallazgos`);
  l.push(`**En una línea:** ${partes.join("; ")}.`);
  l.push("");

  if (auditoria) {
    l.push("## Lo que hay que arreglar primero");
    l.push("");
    l.push(`Rastreo propio de ${auditoria.rastreo.paginas} URLs (${auditoria.rastreo.indexables} indexables, ${auditoria.rastreo.en_sitemap} en el sitemap)${auditoria.rastreo.truncado ? ", con el límite de páginas alcanzado" : ""}.`);
    l.push("");
    if (!auditoria.hallazgos.length) {
      l.push("Sin hallazgos técnicos en este rastreo.");
    } else {
      l.push("| Severidad | Problema | URLs | Por qué importa | Ejemplo |");
      l.push("| --- | --- | --- | --- | --- |");
      for (const h of auditoria.hallazgos) {
        l.push(`| ${SEV[h.severidad]} | ${celda(h.titulo)} | ${h.total || "—"} | ${celda(h.porque)} | ${celda(h.urls[0] ?? "")} |`);
      }
    }
    l.push("");
  }

  if (avengers) {
    l.push("## SEO Avengers 2500");
    l.push("");
    l.push(`Se ejecutaron ${avengers.modulos} módulos (${avengers.rango}): ${avengers.por_estado.SUCCESS} con evidencia suficiente, ${avengers.por_estado.INSUFFICIENT_DATA} esperando datos y ${avengers.por_estado.ERROR} con error. Todos en modo observación: no publican ni modifican nada.`);
    l.push("");
    const conHallazgos = avengers.familias.filter((f) => f.hallazgos > 0).slice(0, 10);
    if (conHallazgos.length) {
      l.push("| Familia | Módulos | Hallazgos | Esperando datos |");
      l.push("| --- | --- | --- | --- |");
      for (const f of conHallazgos) l.push(`| ${celda(f.familia)} | ${f.modulos} | ${f.hallazgos} | ${f.sin_datos} |`);
      l.push("");
    }
    if (avengers.desbloqueos.length) {
      l.push("**Qué desbloquea más módulos:**");
      l.push("");
      l.push("| Fuente | Módulos que se activan |");
      l.push("| --- | --- |");
      for (const d of avengers.desbloqueos) l.push(`| ${celda(d.fuente)} | ${d.modulos} |`);
      l.push("");
    }
  }

  if (searchConsole) {
    l.push("## Search Console");
    l.push("");
    if (searchConsole.estado === "OK") {
      l.push(`Del ${searchConsole.ventana.inicio} al ${searchConsole.ventana.fin}: ${searchConsole.totales.impresiones.toLocaleString("en-US")} impresiones, ${searchConsole.totales.clics.toLocaleString("en-US")} clics y ${searchConsole.totales.consultas.toLocaleString("en-US")} búsquedas distintas. ${searchConsole.nota}`);
    } else {
      l.push(`No disponible: ${searchConsole.motivo}. Mientras tanto, la demanda se estima con fuentes prestadas.`);
    }
    l.push("");
  }

  if (grafo && grafo.paginas) {
    l.push("## Enlazado interno");
    l.push("");
    l.push(`${grafo.paginas} páginas indexables con ${grafo.enlaces} enlaces internos entre ellas. Las páginas con más autoridad interna son ${grafo.nodos.slice(0, 3).map((n) => `\`${n.ruta}\``).join(", ")}.`);
    if (grafo.recomendaciones.length) {
      l.push("");
      for (const r of grafo.recomendaciones.slice(0, 8)) l.push(`- \`${r.ruta}\`: ${r.accion}`);
    }
    l.push("");
  }

  if (lote) {
    l.push("## Próximo lote de páginas (GAUSS)");
    l.push("");
    l.push(lote.nota);
    if (lote.seleccion.length) {
      l.push("");
      l.push("| Página | Tipo | Valor | Fuente del valor |");
      l.push("| --- | --- | --- | --- |");
      for (const c of lote.seleccion) l.push(`| ${celda(c.titulo)} (\`${c.ruta}\`) | ${c.tipo} | ${c.valor} | ${c.fuente_valor === "VOLUMEN_REAL" ? "Keyword Planner" : "estimado"} |`);
    }
    l.push("");
  }

  if (paginas) {
    const cuenta = (e) => paginas.filter((p) => p.estado === e).length;
    l.push("## Páginas forjadas");
    l.push("");
    l.push(paginas.length ? `${cuenta("APROBADA")} aprobadas, ${cuenta("BORRADOR")} esperando revisión y ${cuenta("RECHAZADA")} rechazadas por los candados.` : "Todavía no hay páginas forjadas.");
    l.push("");
  }

  l.push("## Estrategia del cliente");
  l.push("");
  l.push(`- **Demanda:** ${estrategia.demanda.fuente === "PROPIA" ? "propia" : "prestada"}. ${estrategia.demanda.nota}`);
  l.push(`- **Voz:** ${estrategia.voz.nota}`);
  l.push(`- **Publicación:** ${estrategia.publicacion.nota}`);
  l.push(`- **Páginas:** lote inicial de ${estrategia.plan.lote_inicial}, ${estrategia.plan.por_mes} por mes, tope de ${estrategia.plan.tope}.`);
  l.push(`- **Canales activos:** ${estrategia.canales.filter((c) => c.activo).map((c) => c.nombre).join(", ")}.`);
  const apagados = estrategia.canales.filter((c) => !c.activo);
  if (apagados.length) l.push(`- **Canales en espera:** ${apagados.map((c) => `${c.nombre} (${c.motivo})`).join("; ")}.`);
  l.push("");

  if (estrategia.siguientes_pasos.length) {
    l.push("## Qué pedirle al cliente para subir la potencia");
    l.push("");
    estrategia.siguientes_pasos.forEach((p, i) => l.push(`${i + 1}. ${p.pedir} (+${p.suma_potencia} de potencia)`));
    l.push("");
  }

  l.push("## Territorio");
  l.push("");
  l.push(`${estrategia.territorio.exclusivo ? "Exclusivo" : "Compartido"} en ${estrategia.territorio.especialidades.length} especialidades y zonas ${estrategia.territorio.zonas.join(", ")}.`);
  if (estrategia.territorio.conflictos.length) {
    for (const c of estrategia.territorio.conflictos) l.push(`- ${c.severidad}: ${c.clientes.join(" y ")} en ${c.especialidades.join(", ")}. ${c.explicacion}`);
  } else {
    l.push("Sin choques con otros clientes.");
  }
  l.push("");

  l.push("## Evidencia");
  l.push("");
  l.push(`- Estrategia: \`${estrategia.estrategia_digest}\``);
  if (auditoria) l.push(`- Auditoría: \`${auditoria.auditoria_digest}\` sobre el rastreo \`${auditoria.rastreo_digest}\``);
  if (avengers) l.push(`- Avengers: ejecución \`${avengers.execution_hash}\`, certificador terminal \`${avengers.terminal_evidence_hash}\``);
  l.push("");
  l.push("Ningún número de este reporte es una promesa de posiciones en Google; es lo que SUPERSEO observó y lo que decide hacer.");
  return `${l.join("\n")}\n`;
}
