#!/usr/bin/env node
// SUPERSEO · línea de comandos. Desde la raíz del repo: node superseo/cli.mjs <comando>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperSeoError } from "./core/canonical.mjs";
import { PLANES, RUBROS } from "./core/catalogo.mjs";
import { buscarCliente, cargarCartera, guardarPerfil } from "./core/cartera.mjs";
import { cargarConocimiento, cargarPaginas, cargarSitio, dirCliente, guardarPagina } from "./core/almacen.mjs";
import { construirEstrategia } from "./core/estratega.mjs";
import { cambiarEstado, cambiarInsumo, cambiarPlan, resolverExposicion } from "./core/interruptor.mjs";
import { mapaDeConflictos } from "./core/territorio.mjs";
import { rastrear } from "./ojos/crawler.mjs";
import { auditar } from "./ojos/auditoria.mjs";
import { grafoInterno } from "./ojos/grafo.mjs";
import { leerKeywordPlanner, minarDemanda, rutasExistentes } from "./ojos/demanda.mjs";
import { leerSearchConsole } from "./ojos/search-console.mjs";
import { construirSolicitud, ejecutarAvengers, resumirRecibos } from "./cerebro/avengers.mjs";
import { CAPACIDAD_POR_PLAN, priorizarLote } from "./cerebro/priorizar.mjs";
import { forjarPagina, revalidar } from "./manos/forja.mjs";
import { aprobar } from "./manos/pagina.mjs";
import { redactorAnthropic, redactorManual } from "./manos/redactores.mjs";
import { construirPaquete, escribirPaquete } from "./manos/publicar.mjs";
import { entradasSitemap, enviarIndexNow, planEnlacesInternos } from "./manos/indexacion.mjs";
import { compararResumenes, resumirSitio } from "./tercer-ojo/vigia.mjs";
import { detectarTemas, leerFuentes } from "./tercer-ojo/oraculo.mjs";
import { datosLocalesDe, descargarYProcesar, procesarTextoCsv, resolverRecurso } from "./arma/observatorio.mjs";
import { generarReporte } from "./reporte.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ARCHIVO_OBSERVATORIO = join(AQUI, "arma", "datos", "observatorio-cdmx.json");

const AYUDA = `SUPERSEO · Súper SEO de Nexus Bot Studio

Clientes e interruptor
  estado                                   Clientes, estado, plan y potencia
  estrategia <cliente>                     Estrategia completa (JSON)
  territorios                              Choques de territorio entre clientes
  encender | preparar | apagar <cliente> [motivo]
  plan <cliente> BASE|TOTAL
  insumo <cliente> <insumo> <si|no>        (revisor: cliente | nexus | ninguno)

Ojos y cerebro
  ciclo <cliente> [--max N] [--snapshot F] [--salida DIR]   Rastreo, auditoría, grafo, Search Console, Avengers, demanda y reporte
  rastrear <cliente> [--max N] [--salida DIR]
  search-console <cliente> [--salida DIR]   Requiere GSC_SERVICE_ACCOUNT_JSON
  demanda <cliente> [--snapshot F] [--volumenes CSV] [--salida DIR]
  lote <cliente> [--snapshot F] [--volumenes CSV] [--capacidad N]

Manos
  forjar <cliente> [--n N] [--pagina ID] [--redactor anthropic|manual] [--archivo F] [--snapshot F]
  paginas <cliente>                         Páginas forjadas y su estado
  revalidar <cliente> [pagina]              Vuelve a pasar los candados
  aprobar <cliente> <pagina> --revisor CLIENTE|NEXUS --por "Nombre"
  publicar <cliente>                        Escribe el paquete del sitio según el interruptor
  indexnow <cliente>                        Avisa a los buscadores de IndexNow

Tercer ojo y arma
  vigia <cliente> [--max N] [--estado DIR]  Cambios en los sitios de la competencia
  oraculo <cliente> [--estado DIR]          Temas nuevos del rubro en fuentes públicas
  observatorio [--archivo CSV | --url URL]  Actualiza los datos abiertos de la Fiscalía CDMX
`;

function opcion(args, nombre, defecto = null) {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : defecto;
}

function dirSalida(args, id) {
  const dir = resolve(opcion(args, "--salida", join("superseo-salida", id)));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function escribir(dir, nombre, contenido) {
  mkdirSync(dir, { recursive: true });
  const ruta = join(dir, nombre);
  writeFileSync(ruta, typeof contenido === "string" ? contenido : `${JSON.stringify(contenido, null, 2)}\n`);
  return ruta;
}

function leerJson(archivo) {
  return JSON.parse(readFileSync(resolve(archivo), "utf8"));
}

function entero(args, nombre, defecto, min, max) {
  const v = Number(opcion(args, nombre, String(defecto)));
  if (!Number.isInteger(v) || v < min || v > max) throw new SuperSeoError("OPCION_INVALIDA", `${nombre} debe ser entero entre ${min} y ${max}`);
  return v;
}

function cargarObservatorio() {
  return existsSync(ARCHIVO_OBSERVATORIO) ? leerJson(ARCHIVO_OBSERVATORIO) : null;
}

function demandaDe(perfil, args, { snapshot = null, searchConsole = [] } = {}) {
  const archivoVol = opcion(args, "--volumenes");
  const volumenes = archivoVol ? leerKeywordPlanner(readFileSync(resolve(archivoVol), "utf8")) : [];
  return minarDemanda(perfil, { snapshot, volumenes, searchConsole });
}

function textosDelSitio(snapshot) {
  return (snapshot?.paginas ?? []).filter((p) => p.estado_http === 200 && p.texto).map((p) => ({ ruta: p.ruta, texto: p.texto }));
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "ayuda" || cmd === "--help") { process.stdout.write(AYUDA); return 0; }

  if (cmd === "observatorio") {
    const archivo = opcion(args, "--archivo");
    let obs;
    if (archivo) {
      obs = procesarTextoCsv(readFileSync(resolve(archivo), "utf8"), { recurso: { archivo } });
    } else {
      const recurso = opcion(args, "--url") ? { url: opcion(args, "--url") } : await resolverRecurso();
      process.stderr.write(`Descargando ${recurso.url}\n`);
      obs = await descargarYProcesar({ url: recurso.url, recurso });
    }
    if (!obs.verificacion.ok) throw new SuperSeoError("OBSERVATORIO_NO_VERIFICADO", JSON.stringify(obs.verificacion.comprobaciones.filter((c) => !c.ok)));
    escribir(dirname(ARCHIVO_OBSERVATORIO), "observatorio-cdmx.json", obs);
    process.stdout.write(`Observatorio: corte ${obs.corte}, ${obs.total_ciudad_12_meses} carpetas en 12 meses, ${obs.ranking.length} alcaldías, verificado.\n`);
    return 0;
  }

  const cartera = cargarCartera();

  if (cmd === "estado") {
    const filas = cartera.map((p) => {
      const e = construirEstrategia(p, { cartera });
      const paginas = cargarPaginas(p.id);
      const aprobadas = paginas.filter((x) => x.estado === "APROBADA").length;
      return `${p.id.padEnd(16)} ${p.estado.padEnd(12)} ${p.plan.padEnd(6)} potencia ${String(e.potencia.puntos).padStart(3)}/100  páginas ${String(aprobadas).padStart(3)} aprobadas de ${paginas.length}  ${p.dominio}`;
    });
    process.stdout.write(`${filas.join("\n") || "Sin clientes"}\n`);
    return 0;
  }

  if (cmd === "territorios") {
    const mapa = mapaDeConflictos(cartera);
    process.stdout.write(mapa.length ? `${mapa.map((c) => `${c.severidad}  ${c.clientes.join(" vs ")}  ${c.especialidades.join(", ")}  [${c.zonas.join("; ")}]`).join("\n")}\n` : "Sin choques de territorio.\n");
    return mapa.some((c) => c.severidad === "BLOQUEO") ? 1 : 0;
  }

  const id = args[0];
  if (!id) throw new SuperSeoError("FALTA_CLIENTE", cmd);
  const perfil = buscarCliente(cartera, id);
  const snapshotArchivo = opcion(args, "--snapshot");
  const snapshotDado = snapshotArchivo ? leerJson(snapshotArchivo) : null;

  if (cmd === "estrategia") {
    const e = construirEstrategia(perfil, { cartera });
    process.stdout.write(`${JSON.stringify({ ...e, exposicion: resolverExposicion(perfil) }, null, 2)}\n`);
    return 0;
  }

  const estados = { encender: "ON", preparar: "PREPARACION", apagar: "OFF" };
  if (cmd in estados) {
    const nuevo = guardarPerfil(cambiarEstado(perfil, estados[cmd], { cartera, motivo: args.slice(1).join(" ") }));
    process.stdout.write(`${nuevo.id}: ${perfil.estado} → ${nuevo.estado}\n`);
    return 0;
  }

  if (cmd === "plan") {
    const plan = (args[1] ?? "").toUpperCase();
    if (!(plan in PLANES)) throw new SuperSeoError("PLAN_INVALIDO", args[1] ?? "");
    const nuevo = guardarPerfil(cambiarPlan(perfil, plan));
    process.stdout.write(`${nuevo.id}: plan ${nuevo.plan}\n`);
    return 0;
  }

  if (cmd === "insumo") {
    const [, insumo, valorRaw] = args;
    const valor = insumo === "revisor"
      ? { cliente: "CLIENTE", nexus: "NEXUS", ninguno: null }[(valorRaw ?? "").toLowerCase()]
      : { si: true, sí: true, no: false }[(valorRaw ?? "").toLowerCase()];
    if (valor === undefined) throw new SuperSeoError("VALOR_INVALIDO", `${insumo} = ${valorRaw}`);
    const nuevo = guardarPerfil(cambiarInsumo(perfil, insumo, valor));
    process.stdout.write(`${nuevo.id}: ${insumo} = ${valorRaw}. Potencia ${construirEstrategia(nuevo, { cartera }).potencia.puntos}/100\n`);
    return 0;
  }

  if (cmd === "search-console") {
    const gsc = await leerSearchConsole(perfil);
    const dir = dirSalida(args, id);
    escribir(dir, "search-console.json", gsc);
    process.stdout.write(gsc.estado === "OK" ? `Search Console: ${gsc.totales.impresiones} impresiones, ${gsc.totales.clics} clics, ${gsc.totales.consultas} búsquedas (${gsc.ventana.inicio} a ${gsc.ventana.fin}).\n` : `Search Console NO DISPONIBLE: ${gsc.motivo}\n`);
    return 0;
  }

  if (cmd === "demanda" || cmd === "lote") {
    const demanda = demandaDe(perfil, args, { snapshot: snapshotDado });
    const obs = cargarObservatorio();
    const lote = priorizarLote(demanda, { plan: perfil.plan, capacidad: entero(args, "--capacidad", CAPACIDAD_POR_PLAN[perfil.plan], 1, 200), hayDatosLocales: Boolean(obs?.verificacion?.ok), excluir: cargarPaginas(id).map((p) => p.id) });
    if (opcion(args, "--salida")) { const dir = dirSalida(args, id); escribir(dir, "demanda.json", demanda); escribir(dir, "lote.json", lote); }
    if (cmd === "demanda") {
      process.stdout.write(`${demanda.nota}\n${demanda.nuevos} candidatos nuevos de ${demanda.total}.\n`);
      for (const c of demanda.candidatos.slice(0, 40)) process.stdout.write(`${c.cobertura.padEnd(6)} ${String(c.valor).padStart(6)} ${c.tipo.padEnd(18)} ${c.ruta}  ${c.titulo}\n`);
    } else {
      process.stdout.write(`${lote.nota}\nValor ${lote.valor_total} con esfuerzo ${lote.esfuerzo_total}/${lote.capacidad}:\n${lote.seleccion.map((c) => `  ${c.ruta}  ${c.titulo}`).join("\n")}\n`);
    }
    return 0;
  }

  if (cmd === "forjar") {
    const tipo = opcion(args, "--redactor", "anthropic");
    const redactor = tipo === "manual"
      ? redactorManual(resolve(opcion(args, "--archivo") ?? (() => { throw new SuperSeoError("FALTA_ARCHIVO", "--archivo con el contenido escrito a mano"); })()))
      : tipo === "anthropic" ? redactorAnthropic() : (() => { throw new SuperSeoError("REDACTOR_DESCONOCIDO", tipo); })();
    const obs = cargarObservatorio();
    const existentesPaginas = cargarPaginas(id);
    const demanda = demandaDe(perfil, args, { snapshot: snapshotDado });
    const paginaPedida = opcion(args, "--pagina");
    const candidatos = paginaPedida
      ? demanda.candidatos.filter((c) => c.id === paginaPedida)
      : priorizarLote(demanda, { plan: perfil.plan, hayDatosLocales: Boolean(obs?.verificacion?.ok), excluir: existentesPaginas.map((p) => p.id) }).seleccion.slice(0, entero(args, "--n", 5, 1, 20));
    if (!candidatos.length) throw new SuperSeoError("SIN_CANDIDATOS", paginaPedida ? `${paginaPedida} no está entre los candidatos` : "no hay candidatos nuevos");
    const conocimiento = cargarConocimiento(id);
    const rutas = [...rutasExistentes({ snapshot: snapshotDado, perfil }), ...existentesPaginas.map((p) => p.ruta)];
    const hermanas = [...existentesPaginas];
    for (const c of candidatos) {
      const pagina = await forjarPagina(c, perfil, {
        redactor,
        conocimiento,
        existentes: [...rutas, ...candidatos.map((x) => x.ruta)],
        textosExistentes: textosDelSitio(snapshotDado),
        hermanas: hermanas.filter((h) => h.id !== c.id),
        datosLocales: c.tipo === "TORRE_ZONA" ? datosLocalesDe(obs, c.zona) : [],
      });
      guardarPagina(id, pagina);
      hermanas.push(pagina);
      process.stdout.write(`${pagina.estado.padEnd(9)} ${pagina.ruta}  ${pagina.candados.ok ? `${pagina.candados.palabras} palabras` : pagina.candados.motivos.join(" | ")}\n`);
    }
    return 0;
  }

  if (cmd === "paginas") {
    const paginas = cargarPaginas(id);
    process.stdout.write(paginas.length ? `${paginas.map((p) => `${p.estado.padEnd(9)} ${p.ruta}  ${p.titulo}${p.candados?.ok ? "" : `  ⚠ ${p.candados?.motivos?.join(" | ")}`}`).join("\n")}\n` : "Sin páginas forjadas.\n");
    return 0;
  }

  if (cmd === "revalidar") {
    const solo = args[1];
    const paginas = cargarPaginas(id).filter((p) => !solo || p.id === solo);
    if (solo && !paginas.length) throw new SuperSeoError("PAGINA_NO_EXISTE", solo);
    const todas = cargarPaginas(id);
    const rutas = [...rutasExistentes({ snapshot: snapshotDado, perfil }), ...todas.map((p) => p.ruta)];
    for (const p of paginas) {
      const r = guardarPagina(id, revalidar(p, perfil, { conocimiento: cargarConocimiento(id), existentes: rutas, textosExistentes: textosDelSitio(snapshotDado), hermanas: todas.filter((h) => h.id !== p.id) }));
      process.stdout.write(`${r.estado.padEnd(9)} ${r.ruta}${r.candados.ok ? "" : `  ${r.candados.motivos.join(" | ")}`}\n`);
    }
    return 0;
  }

  if (cmd === "aprobar") {
    const paginaId = args[1];
    const pagina = cargarPaginas(id).find((p) => p.id === paginaId);
    if (!pagina) throw new SuperSeoError("PAGINA_NO_EXISTE", paginaId ?? "");
    const aprobada = guardarPagina(id, aprobar(pagina, { revisor: (opcion(args, "--revisor") ?? "").toUpperCase(), por: opcion(args, "--por") ?? "" }));
    process.stdout.write(`${aprobada.ruta} APROBADA por ${aprobada.aprobacion.por} (${aprobada.aprobacion.revisor}). Se publica cuando el cliente esté encendido y corras "publicar".\n`);
    return 0;
  }

  if (cmd === "publicar") {
    const paquete = construirPaquete(perfil, cargarPaginas(id));
    const destino = escribirPaquete(paquete, cargarSitio(id));
    process.stdout.write(`${perfil.id} (${perfil.estado}): ${paquete.publicadas.length} páginas publicadas, ${paquete.redirecciones.length} redirecciones → ${destino}\n`);
    const plan = planEnlacesInternos(paquete);
    if (plan.length) process.stdout.write(`Enlaces internos sugeridos:\n${plan.map((p) => `  ${p.desde} → ${p.hacia.join(", ")}`).join("\n")}\n`);
    return 0;
  }

  if (cmd === "indexnow") {
    const paquete = construirPaquete(perfil, cargarPaginas(id));
    const r = await enviarIndexNow({ origen: perfil.dominio, llave: cargarSitio(id)?.indexnow_key ?? null, urls: entradasSitemap(paquete).map((e) => e.url) });
    process.stdout.write(`IndexNow: ${JSON.stringify(r)}\n`);
    return r.estado === "FALLO" ? 1 : 0;
  }

  if (cmd === "vigia") {
    const archivo = join(dirCliente(id), "competidores.json");
    const dominios = existsSync(archivo) ? leerJson(archivo).dominios ?? [] : [];
    if (!dominios.length) { process.stdout.write("Sin competidores registrados en competidores.json.\n"); return 0; }
    const estado = resolve(opcion(args, "--estado", join("superseo-salida", id, "vigia")));
    const max = entero(args, "--max", 60, 1, 1000);
    const informes = [];
    for (const d of dominios) {
      const snap = await rastrear({ inicio: d, maxPaginas: max });
      const actual = resumirSitio(snap);
      const archivoEstado = join(estado, `${new URL(d).hostname}.json`);
      const anterior = existsSync(archivoEstado) ? leerJson(archivoEstado) : null;
      const cmp = compararResumenes(anterior, actual);
      escribir(estado, `${new URL(d).hostname}.json`, actual);
      informes.push(cmp);
      process.stdout.write(`${new URL(d).hostname}: ${cmp.resumen}\n`);
      for (const n of cmp.nuevas.slice(0, 10)) process.stdout.write(`  + ${n.ruta}  ${n.titulo ?? ""}\n`);
      for (const c of cmp.cambiadas.slice(0, 10)) process.stdout.write(`  ~ ${c.ruta}  ${c.cambios.join("; ")}\n`);
    }
    escribir(dirSalida(args, id), "vigia.json", informes);
    return 0;
  }

  if (cmd === "oraculo") {
    const config = leerJson(join(AQUI, "tercer-ojo", "fuentes.json")).rubros[perfil.rubro];
    if (!config) { process.stdout.write(`Sin fuentes configuradas para ${RUBROS[perfil.rubro].nombre}.\n`); return 0; }
    const estado = resolve(opcion(args, "--estado", join("superseo-salida", id, "oraculo")));
    const archivoVistos = join(estado, "vistos.json");
    const vistos = existsSync(archivoVistos) ? leerJson(archivoVistos) : [];
    const { items, errores } = await leerFuentes(config.fuentes);
    const terminos = [...config.terminos, ...perfil.servicios.map((s) => ({ termino: s.nombre, peso: 1 }))];
    const r = detectarTemas(items, { terminos, vistos });
    escribir(estado, "vistos.json", r.vistos);
    escribir(dirSalida(args, id), "oraculo.json", { temas: r.temas, errores });
    process.stdout.write(`${r.total} temas nuevos${errores.length ? ` (${errores.length} fuentes con error)` : ""}.\n`);
    for (const t of r.temas.slice(0, 15)) process.stdout.write(`  [${t.puntaje}] ${t.titulo}\n      ${t.enlace}\n`);
    return 0;
  }

  if (cmd === "rastrear" || cmd === "ciclo") {
    const dir = dirSalida(args, id);
    const max = entero(args, "--max", 300, 1, 5000);
    const snapshot = snapshotDado ?? await rastrear({ inicio: perfil.dominio, maxPaginas: max });
    if (!snapshotDado) escribir(dir, "rastreo.json", snapshot);
    process.stderr.write(`Rastreo: ${snapshot.paginas.length} URLs de ${snapshot.origen}\n`);
    if (cmd === "rastrear") return 0;

    const searchConsole = await leerSearchConsole(perfil).catch((e) => ({ estado: "FALLO", motivo: e.message }));
    const estrategia = construirEstrategia(perfil, { cartera });
    const auditoria = auditar(snapshot, { perfil });
    const grafo = grafoInterno(snapshot, { importantes: perfil.servicios.map((s) => s.ruta) });
    const solicitud = construirSolicitud(snapshot, perfil);
    if (searchConsole.estado === "OK") solicitud.payload.search_performance_records = searchConsole.registros;
    const avengers = resumirRecibos(ejecutarAvengers(solicitud), solicitud);
    const demanda = demandaDe(perfil, args, { snapshot, searchConsole: searchConsole.estado === "OK" ? searchConsole.registros.map((r) => ({ query: r.query, impressions: r.impressions })) : [] });
    const obs = cargarObservatorio();
    const lote = priorizarLote(demanda, { plan: perfil.plan, hayDatosLocales: Boolean(obs?.verificacion?.ok), excluir: cargarPaginas(id).map((p) => p.id) });
    const reporte = generarReporte({ perfil, estrategia, auditoria, avengers, grafo, searchConsole, lote, paginas: cargarPaginas(id) });
    escribir(dir, "estrategia.json", estrategia);
    escribir(dir, "auditoria.json", auditoria);
    escribir(dir, "grafo.json", grafo);
    escribir(dir, "avengers.json", avengers);
    escribir(dir, "demanda.json", demanda);
    escribir(dir, "lote.json", lote);
    escribir(dir, "search-console.json", searchConsole.estado === "OK" ? { ...searchConsole, registros: searchConsole.registros.slice(0, 1000) } : searchConsole);
    const ruta = escribir(dir, "reporte.md", reporte);
    process.stderr.write(`Reporte: ${ruta}\n`);
    process.stdout.write(reporte);
    return 0;
  }

  throw new SuperSeoError("COMANDO_DESCONOCIDO", cmd);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    process.stderr.write(e instanceof SuperSeoError ? `SUPERSEO ${e.message}\n` : `${e.stack ?? e}\n`);
    process.exitCode = 2;
  },
);
