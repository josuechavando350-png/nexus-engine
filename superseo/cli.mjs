#!/usr/bin/env node
// SUPERSEO · línea de comandos. Desde la raíz del repo: node superseo/cli.mjs <comando>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SuperSeoError } from "./core/canonical.mjs";
import { PLANES } from "./core/catalogo.mjs";
import { buscarCliente, cargarCartera, guardarPerfil } from "./core/cartera.mjs";
import { construirEstrategia } from "./core/estratega.mjs";
import { cambiarEstado, cambiarInsumo, cambiarPlan, resolverExposicion } from "./core/interruptor.mjs";
import { mapaDeConflictos } from "./core/territorio.mjs";
import { rastrear } from "./ojos/crawler.mjs";
import { auditar } from "./ojos/auditoria.mjs";
import { construirSolicitud, ejecutarAvengers, resumirRecibos } from "./cerebro/avengers.mjs";
import { generarReporte } from "./reporte.mjs";

const AYUDA = `SUPERSEO · Súper SEO de Nexus Bot Studio

  estado                              Clientes, estado, plan y potencia
  estrategia <cliente>                Estrategia completa del cliente (JSON)
  territorios                         Choques de territorio entre clientes
  encender <cliente> [motivo]         Prende SUPERSEO (publica y corre el ciclo)
  preparar <cliente> [motivo]         Modo preparación (construye y mide, no publica)
  apagar <cliente> [motivo]           Apaga SUPERSEO (sitio normal, páginas redirigen)
  plan <cliente> BASE|TOTAL           Cambia el plan
  insumo <cliente> <insumo> <valor>   Marca un insumo (si/no; revisor: CLIENTE/NEXUS/ninguno)
  rastrear <cliente> [--max N] [--salida DIR]
  ciclo <cliente> [--max N] [--salida DIR] [--snapshot ARCHIVO]
                                      Rastreo + auditoría + Avengers + reporte
`;

function opcion(args, nombre, defecto = null) {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : defecto;
}

function salida(args, id) {
  const dir = resolve(opcion(args, "--salida", join("superseo-salida", id)));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function escribir(dir, nombre, contenido) {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, typeof contenido === "string" ? contenido : `${JSON.stringify(contenido, null, 2)}\n`);
  return ruta;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "ayuda" || cmd === "--help") { process.stdout.write(AYUDA); return 0; }
  const cartera = cargarCartera();

  if (cmd === "estado") {
    const filas = cartera.map((p) => {
      const e = construirEstrategia(p, { cartera });
      return `${p.id.padEnd(16)} ${p.estado.padEnd(12)} ${p.plan.padEnd(6)} potencia ${String(e.potencia.puntos).padStart(3)}/100  ${p.dominio}`;
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
    let valor;
    if (insumo === "revisor") valor = { cliente: "CLIENTE", nexus: "NEXUS", ninguno: null }[(valorRaw ?? "").toLowerCase()];
    else valor = { si: true, sí: true, no: false }[(valorRaw ?? "").toLowerCase()];
    if (valor === undefined) throw new SuperSeoError("VALOR_INVALIDO", `${insumo} = ${valorRaw}`);
    const nuevo = guardarPerfil(cambiarInsumo(perfil, insumo, valor));
    const e = construirEstrategia(nuevo, { cartera });
    process.stdout.write(`${nuevo.id}: ${insumo} = ${valorRaw}. Potencia ${e.potencia.puntos}/100\n`);
    return 0;
  }

  if (cmd === "rastrear" || cmd === "ciclo") {
    const dir = salida(args, id);
    const max = Number(opcion(args, "--max", "300"));
    if (!Number.isInteger(max) || max < 1 || max > 5000) throw new SuperSeoError("MAX_INVALIDO", String(max));
    const archivoSnapshot = opcion(args, "--snapshot");
    const snapshot = archivoSnapshot
      ? JSON.parse(readFileSync(resolve(archivoSnapshot), "utf8"))
      : await rastrear({ inicio: perfil.dominio, maxPaginas: max });
    if (!archivoSnapshot) escribir(dir, "rastreo.json", snapshot);
    process.stderr.write(`Rastreo: ${snapshot.paginas.length} URLs de ${snapshot.origen}\n`);
    if (cmd === "rastrear") return 0;

    const estrategia = construirEstrategia(perfil, { cartera });
    const auditoria = auditar(snapshot, { perfil });
    const solicitud = construirSolicitud(snapshot, perfil);
    const avengers = resumirRecibos(ejecutarAvengers(solicitud), solicitud);
    const reporte = generarReporte({ perfil, estrategia, auditoria, avengers });
    escribir(dir, "estrategia.json", estrategia);
    escribir(dir, "auditoria.json", auditoria);
    escribir(dir, "avengers.json", avengers);
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
