// Priorización con GAUSS: elige el lote de páginas que más valor da con el
// esfuerzo disponible, usando la mochila binaria exacta de GAUSS
// (GAUSS.CS.KNAPSACK_EXACT.001). El resultado es óptimo para los candidatos
// evaluados; si el presupuesto de búsqueda se agota, GAUSS se niega a afirmar
// optimalidad y SUPERSEO lo reporta en lugar de inventarla.
import { exactBinaryKnapsack } from "../../gauss/core/layers/computing.mjs";
import { SuperSeoError, sha256, deepFreeze } from "../core/canonical.mjs";

export const OPERADOR_GAUSS = "GAUSS.CS.KNAPSACK_EXACT.001";
const MAX_GAUSS = 20;
const MAX_CRUCES = 3;
export const CAPACIDAD_POR_PLAN = Object.freeze({ BASE: 24, TOTAL: 40 });

export function priorizarLote(demanda, { plan = "BASE", capacidad = CAPACIDAD_POR_PLAN[plan], excluir = [], hayDatosLocales = false } = {}) {
  if (!Number.isInteger(capacidad) || capacidad < 1) throw new SuperSeoError("CAPACIDAD_INVALIDA", String(capacidad));
  const fuera = new Set(excluir);
  // Sin datos locales (Observatorio), una Torre sería un clon con otro nombre de zona: no entra al lote.
  const disponibles = demanda.candidatos.filter((c) => c.cobertura === "NUEVA" && !fuera.has(c.id) && (hayDatosLocales || !c.requiere_datos_locales));
  if (!disponibles.length) {
    return deepFreeze({ operador: OPERADOR_GAUSS, capacidad, evaluados: [], seleccion: [], valor_total: 0, esfuerzo_total: 0, optimo: true, nota: "No hay candidatos nuevos.", lote_digest: sha256({ capacidad, vacio: true }) });
  }
  // Diversidad: como máximo MAX_CRUCES cruces por situación en un mismo lote, para no
  // publicar muchas páginas casi iguales a la vez.
  const porGrupo = new Map();
  const evaluados = [...disponibles]
    .sort((a, b) => (b.valor / b.esfuerzo) - (a.valor / a.esfuerzo) || b.valor - a.valor || a.id.localeCompare(b.id))
    .filter((c) => {
      if (c.tipo !== "SERVICIO_SITUACION") return true;
      const n = porGrupo.get(c.situacion) ?? 0;
      porGrupo.set(c.situacion, n + 1);
      return n < MAX_CRUCES;
    })
    .slice(0, MAX_GAUSS);
  let resultado;
  let optimo = true;
  let nota = `Lote óptimo calculado por ${OPERADOR_GAUSS} sobre los ${evaluados.length} mejores candidatos por valor/esfuerzo.`;
  try {
    resultado = exactBinaryKnapsack({ items: evaluados.map((c) => ({ id: c.id, weight: c.esfuerzo, value: c.valor })), capacity: capacidad });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    optimo = false;
    nota = "GAUSS agotó su presupuesto de búsqueda y no afirma optimalidad; se usó selección voraz por valor/esfuerzo.";
    let restante = capacidad;
    const ids = [];
    for (const c of evaluados) if (c.esfuerzo <= restante) { ids.push(c.id); restante -= c.esfuerzo; }
    resultado = { selectedIds: ids };
  }
  const elegidos = new Set(resultado.selectedIds);
  const seleccion = evaluados.filter((c) => elegidos.has(c.id));
  const cuerpo = {
    operador: OPERADOR_GAUSS,
    capacidad,
    evaluados: evaluados.map((c) => ({ id: c.id, valor: c.valor, esfuerzo: c.esfuerzo })),
    seleccion,
    valor_total: Math.round(seleccion.reduce((s, c) => s + c.valor, 0) * 10) / 10,
    esfuerzo_total: seleccion.reduce((s, c) => s + c.esfuerzo, 0),
    optimo,
    nota,
    demanda_digest: demanda.demanda_digest,
  };
  return deepFreeze({ ...cuerpo, lote_digest: sha256(cuerpo) });
}
