/** A bounded, non-executing reader for the observed React Flight text format.
 * Framing reference: react/react v19.0.0, ReactFlightClient.js (ROW_TAG/ROW_LENGTH).
 * Unknown/binary records fail closed; this is not a universal Flight decoder.
 */
export function rewriteFlight(
  input: string,
  replace: (value: string) => string,
): string {
  const bytes = Buffer.from(input, "utf8");
  const output: Buffer[] = [];
  let offset = 0;
  function text(data: Buffer) {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  function model(value: unknown): unknown {
    if (typeof value === "string") {
      // React references are protocol, not copy. $$ represents a literal dollar.
      if (value.startsWith("$") && !value.startsWith("$$")) return value;
      const decoded = value.startsWith("$$") ? value.slice(1) : value;
      const changed = replace(decoded);
      return changed.startsWith("$") ? "$" + changed : changed;
    }
    if (Array.isArray(value))
      return value.map((v, i) => (value[0] === "$" && i < 3 ? v : model(v)));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, model(v)]),
      );
    return value;
  }
  while (offset < bytes.length) {
    const start = offset;
    const colon = bytes.indexOf(58, offset);
    if (
      colon < offset ||
      colon - offset > 16 ||
      !/^[0-9a-f]*$/.test(text(bytes.subarray(offset, colon)))
    )
      throw new Error(
        "Flight: identificador o trama incompleta en byte " + offset,
      );
    const id = text(bytes.subarray(offset, colon));
    offset = colon + 1;
    const tag = String.fromCharCode(bytes[offset]);
    if ("TAOoUSsLlGgMmVb".includes(tag)) {
      if (tag !== "T")
        throw new Error("Flight: registro binario no soportado: " + tag);
      const comma = bytes.indexOf(44, ++offset);
      const lengthText = text(bytes.subarray(offset, comma));
      if (
        comma < offset ||
        comma - offset > 8 ||
        !/^[0-9a-f]+$/.test(lengthText)
      )
        throw new Error("Flight: longitud inválida");
      const length = parseInt(lengthText, 16),
        end = comma + 1 + length;
      if (end > bytes.length) throw new Error("Flight: texto truncado");
      const original = text(bytes.subarray(comma + 1, end));
      const value = replace(original);
      output.push(
        value === original
          ? bytes.subarray(start, end)
          : Buffer.from(
              id + ":T" + Buffer.byteLength(value).toString(16) + "," + value,
            ),
      );
      offset = end;
      continue;
    }
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error("Flight: falta terminador de registro");
    let payload = text(bytes.subarray(offset, end)),
      prefix = "";
    if (tag === "H") {
      // Resource preload hints contain protocol/module paths, not editable copy.
      if (!/^H[a-zA-Z][\[{]/.test(payload))
        throw new Error("Flight: hint no soportado");
      JSON.parse(payload.slice(2));
      output.push(bytes.subarray(start, end + 1));
      offset = end + 1;
      continue;
    }
    if (tag === "I") {
      JSON.parse(payload.slice(1));
      output.push(bytes.subarray(start, end + 1));
      offset = end + 1;
      continue;
    }
    if ("RXrxC".includes(tag)) {
      prefix = tag;
      payload = payload.slice(1);
      if (!payload) {
        output.push(bytes.subarray(start, end + 1));
        offset = end + 1;
        continue;
      }
    } else if (/^[A-Z#]/.test(payload)) {
      throw new Error("Flight: etiqueta no soportada: " + tag);
    }
    const parsed: unknown = JSON.parse(payload);
    const changed = model(parsed);
    output.push(
      JSON.stringify(parsed) === JSON.stringify(changed)
        ? bytes.subarray(start, end + 1)
        : Buffer.from(id + ":" + prefix + JSON.stringify(changed) + "\n"),
    );
    offset = end + 1;
  }
  return Buffer.concat(output).toString("utf8");
}
