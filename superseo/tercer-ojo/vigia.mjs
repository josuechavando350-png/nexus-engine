// Vigía de competencia: compara cada semana los sitios que compiten con el cliente.
// Detecta páginas nuevas, páginas eliminadas y cambios de título o contenido, para
// responder antes de que el competidor gane terreno. Solo rastrea sitios públicos
// respetando su robots.txt.
import { sha256, deepFreeze } from "../core/canonical.mjs";

export function resumirSitio(snapshot) {
  const paginas = {};
  for (const p of snapshot.paginas) {
    if (p.estado_http !== 200 || !/html/i.test(p.tipo ?? "")) continue;
    paginas[p.ruta] = { titulo: p.titulo ?? null, h1: p.h1?.[0] ?? null, palabras: p.palabras ?? 0, huella: sha256(p.texto ?? "") };
  }
  return { schema_version: 1, origen: snapshot.origen, observado_en: snapshot.terminado_en ?? null, paginas };
}

export function compararResumenes(anterior, actual) {
  if (!anterior) {
    return deepFreeze({ origen: actual.origen, primera_vez: true, total: Object.keys(actual.paginas).length, nuevas: [], eliminadas: [], cambiadas: [], resumen: "Primera observación: queda como línea base para la próxima semana." });
  }
  const antes = anterior.paginas;
  const ahora = actual.paginas;
  const nuevas = Object.keys(ahora).filter((r) => !(r in antes)).sort().map((ruta) => ({ ruta, titulo: ahora[ruta].titulo, palabras: ahora[ruta].palabras }));
  const eliminadas = Object.keys(antes).filter((r) => !(r in ahora)).sort().map((ruta) => ({ ruta, titulo: antes[ruta].titulo }));
  const cambiadas = Object.keys(ahora).filter((r) => r in antes).sort().flatMap((ruta) => {
    const a = antes[ruta];
    const b = ahora[ruta];
    const cambios = [];
    if (a.titulo !== b.titulo) cambios.push(`título: "${a.titulo}" → "${b.titulo}"`);
    if (a.h1 !== b.h1) cambios.push(`H1: "${a.h1}" → "${b.h1}"`);
    if (a.huella !== b.huella) cambios.push(`contenido (${a.palabras} → ${b.palabras} palabras)`);
    return cambios.length ? [{ ruta, cambios }] : [];
  });
  const partes = [];
  if (nuevas.length) partes.push(`${nuevas.length} páginas nuevas`);
  if (cambiadas.length) partes.push(`${cambiadas.length} páginas cambiadas`);
  if (eliminadas.length) partes.push(`${eliminadas.length} páginas eliminadas`);
  return deepFreeze({
    origen: actual.origen,
    primera_vez: false,
    desde: anterior.observado_en,
    hasta: actual.observado_en,
    total: Object.keys(ahora).length,
    nuevas,
    eliminadas,
    cambiadas,
    resumen: partes.length ? partes.join(", ") : "Sin cambios desde la última observación.",
  });
}
