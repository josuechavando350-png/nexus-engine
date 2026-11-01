/** Deliberately conservative SVG path syntax: explicit commands and separated numbers.
 * Compact arc flags and implicit command repetition must be expanded by the editor.
 * This is input validation, not a claim that the shape has the intended visual meaning.
 */
export type SVGPathRule = { id: string; from: string; to: string };

export function validatePathData(value: string) {
  if (typeof value !== "string" || !value || value.length > 100000)
    throw new Error("Geometría SVG vacía o demasiado larga");
  const tokens = value.match(
    /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g,
  );
  if (
    !tokens ||
    !/^\s*[Mm]/.test(value) ||
    /,\s*(?:,|[a-df-zA-DF-Z]|$)|[a-df-zA-DF-Z]\s*,/.test(value) ||
    value.replace(
      /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g,
      "",
    )
  )
    throw new Error("Geometría SVG contiene caracteres no admitidos");
  if (!/^[Mm]$/.test(tokens[0]))
    throw new Error("La geometría SVG debe comenzar con M");
  const arities: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
    Z: 0,
  };
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++].toUpperCase(),
      count = arities[command];
    if (count === undefined)
      throw new Error("Comando SVG no admitido: " + command);
    const args = tokens.slice(i, i + count);
    if (
      args.length !== count ||
      args.some((v) => !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1e7)
    )
      throw new Error("Argumentos SVG inválidos: " + command);
    if (
      command === "A" &&
      (Number(args[0]) < 0 ||
        Number(args[1]) < 0 ||
        !/^[01]$/.test(args[3]) ||
        !/^[01]$/.test(args[4]))
    )
      throw new Error("Arco SVG inválido");
    i += count;
  }
}

export function validateSVGPaths(rules: SVGPathRule[]) {
  if (!Array.isArray(rules) || rules.length > 1000)
    throw new Error("Plan SVG inválido");
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      !rule.id ||
      ids.has(rule.id) ||
      typeof rule.from !== "string" ||
      !rule.from ||
      rule.from.length > 100000 ||
      paths.has(rule.from) ||
      rule.from === rule.to
    )
      throw new Error("Regla SVG inválida o ambigua: " + rule?.id);
    // Source is exact captured data; only the newly authored geometry uses our bounded grammar.
    validatePathData(rule.to);
    ids.add(rule.id);
    paths.add(rule.from);
  }
}
