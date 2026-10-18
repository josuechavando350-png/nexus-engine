// Detector de contenido duplicado o casi duplicado (candado anti-clones).
// Compara "tejas" de 5 palabras con índice de Jaccard. Antes de comparar,
// enmascara los nombres de lugar: así una página que solo cambia "Iztapalapa"
// por "Coyoacán" se ve idéntica, que es exactamente lo que Google castiga.
import { normalizarTexto } from "./canonical.mjs";
import { ZONAS } from "./catalogo.mjs";

export const LUGARES_CONOCIDOS = Object.freeze([...new Set(Object.values(ZONAS).flat())]);

function escapar(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function enmascarar(texto, ignorar = []) {
  let t = normalizarTexto(texto);
  const terminos = [...new Set(ignorar.map(normalizarTexto).filter((x) => x.length > 2))].sort((a, b) => b.length - a.length);
  for (const termino of terminos) t = t.replace(new RegExp(`(^| )${escapar(termino)}(?= |$)`, "g"), "$1lugar");
  return t;
}

export function tejas(texto, k = 5, ignorar = []) {
  const palabras = enmascarar(texto, ignorar).split(" ").filter(Boolean);
  const out = new Set();
  if (palabras.length < k) {
    if (palabras.length) out.add(palabras.join(" "));
    return out;
  }
  for (let i = 0; i + k <= palabras.length; i += 1) out.add(palabras.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [menor, mayor] = a.size <= b.size ? [a, b] : [b, a];
  let comun = 0;
  for (const t of menor) if (mayor.has(t)) comun += 1;
  return comun / (a.size + b.size - comun);
}

// documentos: [{ id, texto }]. Devuelve pares con similitud >= umbral.
export function paresParecidos(documentos, { umbral = 0.8, k = 5, minPalabras = 80, ignorar = LUGARES_CONOCIDOS } = {}) {
  const preparados = documentos
    .filter((d) => normalizarTexto(d.texto).split(" ").length >= minPalabras)
    .map((d) => ({ id: d.id, tejas: tejas(d.texto, k, ignorar) }));
  const pares = [];
  for (let i = 0; i < preparados.length; i += 1) {
    for (let j = i + 1; j < preparados.length; j += 1) {
      const a = preparados.at(i);
      const b = preparados.at(j);
      const s = jaccard(a.tejas, b.tejas);
      if (s >= umbral) pares.push({ a: a.id, b: b.id, similitud: Math.round(s * 1000) / 1000 });
    }
  }
  return pares.sort((x, y) => y.similitud - x.similitud || x.a.localeCompare(y.a));
}
