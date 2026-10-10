// Link Graph interno: cómo fluye la autoridad dentro del sitio.
// PageRank interno (métrica de NEXUS, no el PageRank de Google), profundidad desde
// el inicio, enlaces entrantes y recomendaciones de enlazado. Los backlinks externos
// requieren el grafo de Common Crawl y son una fase aparte.
import { sha256, deepFreeze } from "../core/canonical.mjs";

function clave(url) {
  const u = new URL(url);
  const ruta = u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "/";
  return `${u.hostname.replace(/^www\./, "")}${ruta}`;
}

export function grafoInterno(snapshot, { importantes = [], amortiguacion = 0.85, iteraciones = 60 } = {}) {
  const html = snapshot.paginas.filter((p) => p.estado_http === 200 && /html/i.test(p.tipo ?? "") && !/noindex/i.test(p.robots ?? ""));
  const nodos = new Map(html.map((p) => [clave(p.url), p.ruta]));
  const salientes = new Map();
  for (const p of html) {
    const origen = clave(p.url);
    const destinos = new Set((p.enlaces_internos ?? []).map(clave).filter((k) => nodos.has(k) && k !== origen));
    salientes.set(origen, [...destinos].sort());
  }
  const ids = [...nodos.keys()].sort();
  const n = ids.length;
  if (!n) return deepFreeze({ paginas: 0, nodos: [], recomendaciones: [], grafo_digest: sha256({ vacio: true }) });

  const entrantes = new Map(ids.map((id) => [id, 0]));
  for (const destinos of salientes.values()) for (const d of destinos) entrantes.set(d, entrantes.get(d) + 1);

  let rango = new Map(ids.map((id) => [id, 1 / n]));
  for (let it = 0; it < iteraciones; it += 1) {
    const siguiente = new Map(ids.map((id) => [id, (1 - amortiguacion) / n]));
    let colgante = 0;
    for (const id of ids) {
      const destinos = salientes.get(id);
      if (!destinos.length) { colgante += rango.get(id); continue; }
      const parte = (amortiguacion * rango.get(id)) / destinos.length;
      for (const d of destinos) siguiente.set(d, siguiente.get(d) + parte);
    }
    for (const id of ids) siguiente.set(id, siguiente.get(id) + (amortiguacion * colgante) / n);
    rango = siguiente;
  }

  const raiz = ids.find((id) => nodos.get(id) === "/") ?? ids[0];
  const profundidad = new Map([[raiz, 0]]);
  const cola = [raiz];
  while (cola.length) {
    const actual = cola.shift();
    for (const d of salientes.get(actual)) if (!profundidad.has(d)) { profundidad.set(d, profundidad.get(actual) + 1); cola.push(d); }
  }

  const max = Math.max(...rango.values());
  const tabla = ids.map((id) => ({
    ruta: nodos.get(id),
    rango_interno: Math.round((rango.get(id) / max) * 1000) / 1000,
    entrantes: entrantes.get(id),
    salientes: salientes.get(id).length,
    profundidad: profundidad.has(id) ? profundidad.get(id) : null,
  })).sort((a, b) => b.rango_interno - a.rango_interno || a.ruta.localeCompare(b.ruta));

  const recomendaciones = [];
  const fuertes = tabla.slice(0, 5).map((t) => t.ruta);
  for (const t of tabla) {
    if (t.profundidad === null) recomendaciones.push({ ruta: t.ruta, tipo: "INALCANZABLE", accion: "Ninguna ruta desde el inicio llega a esta página: enlázala desde una página fuerte.", desde: fuertes });
    else if (t.profundidad > 3) recomendaciones.push({ ruta: t.ruta, tipo: "PROFUNDA", accion: `Está a ${t.profundidad} clics del inicio: acércala a 3 o menos.`, desde: fuertes });
    if (importantes.includes(t.ruta) && t.entrantes < 3) recomendaciones.push({ ruta: t.ruta, tipo: "SERVICIO_DEBIL", accion: `Página de servicio con solo ${t.entrantes} enlaces internos entrantes: súmale enlaces desde guías relacionadas.`, desde: fuertes.filter((f) => f !== t.ruta) });
  }
  const cuerpo = { schema_version: 1, origen: snapshot.origen, paginas: n, enlaces: [...salientes.values()].reduce((s, d) => s + d.length, 0), nodos: tabla, recomendaciones };
  return deepFreeze({ ...cuerpo, grafo_digest: sha256(cuerpo) });
}
