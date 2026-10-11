// Territorios: evita que Nexus trabaje para dos clientes contra sí mismo.
// Dos clientes chocan cuando comparten al menos una especialidad y sus zonas se
// traslapan. Si alguno pagó exclusividad, el choque BLOQUEA la activación; si no,
// es un AVISO que debe estar dicho por escrito en ambos contratos.
import { zonasSeTraslapan } from "./catalogo.mjs";

function ocupaTerritorio(perfil) {
  return perfil.estado !== "OFF";
}

export function compararTerritorios(a, b) {
  if (a.id === b.id) return null;
  const especialidades = a.territorio.especialidades.filter((e) => b.territorio.especialidades.includes(e));
  if (especialidades.length === 0) return null;
  const zonas = [];
  for (const za of a.territorio.zonas) {
    for (const zb of b.territorio.zonas) {
      if (zonasSeTraslapan(za, zb)) zonas.push([za, zb]);
    }
  }
  if (zonas.length === 0) return null;
  const severidad = a.territorio.exclusivo || b.territorio.exclusivo ? "BLOQUEO" : "AVISO";
  return {
    clientes: [a.id, b.id].sort(),
    especialidades: especialidades.sort(),
    zonas: zonas.map((par) => par.join(" ~ ")).sort(),
    severidad,
    explicacion: severidad === "BLOQUEO"
      ? "Uno de los dos tiene exclusividad en este territorio: no se puede activar al otro."
      : "Comparten territorio sin exclusividad: ambos contratos deben decir que es compartido.",
  };
}

// Conflictos de un candidato contra la cartera que hoy ocupa territorio.
export function conflictosDe(candidato, cartera) {
  return cartera
    .filter((otro) => otro.id !== candidato.id && ocupaTerritorio(otro))
    .map((otro) => compararTerritorios(candidato, otro))
    .filter(Boolean);
}

// Mapa completo de choques entre clientes activos o en preparación.
export function mapaDeConflictos(cartera) {
  const activos = cartera.filter(ocupaTerritorio);
  const out = [];
  for (let i = 0; i < activos.length; i += 1) {
    for (let j = i + 1; j < activos.length; j += 1) {
      const choque = compararTerritorios(activos.at(i), activos.at(j));
      if (choque) out.push(choque);
    }
  }
  return out.sort((x, y) => x.clientes.join().localeCompare(y.clientes.join()));
}
