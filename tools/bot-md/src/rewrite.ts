import { parse, serialize } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { parse as parseJS } from "acorn";
import { simple } from "acorn-walk";
import { canonical, localPath } from "./common.js";

export type Mapper = (input: string, base: string) => string;
export function createMapper(
  origin: string,
  known: Set<string>,
  missing: Set<string>,
): Mapper {
  return (input, base) => {
    if (
      !input ||
      input.startsWith("#") ||
      /^(data:|blob:|mailto:|tel:|javascript:)/i.test(input)
    )
      return input;
    try {
      const u = new URL(input, base);
      if (!["http:", "https:"].includes(u.protocol)) return input;
      const normalized = canonical(u.href);
      if (!known.has(normalized)) missing.add(normalized);
      return localPath(normalized, origin) + u.hash;
    } catch {
      return input;
    }
  };
}
export function rewriteCSS(css: string, base: string, map: Mapper): string {
  const root = postcss.parse(css);
  function values(value: string) {
    const v = valueParser(value);
    v.walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "url") {
        const inner = node.nodes[0];
        if (inner && (inner.type === "string" || inner.type === "word")) {
          node.nodes[0] = {
            ...inner,
            type: "string",
            value: map(inner.value, base),
            quote: '"',
          };
        }
        return false;
      }
    });
    return v.toString();
  }
  root.walkDecls((d) => {
    d.value = values(d.value);
  });
  root.walkAtRules("import", (rule) => {
    const v = valueParser(rule.params);
    const first = v.nodes[0];
    if (first?.type === "string") first.value = map(first.value, base);
    rule.params = values(v.toString());
  });
  return root.toString();
}
export function rewriteJS(
  source: string,
  base: string,
  map: Mapper,
  known: Set<string>,
): string {
  let ast: ReturnType<typeof parseJS>;
  try {
    ast = parseJS(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
  } catch {
    ast = parseJS(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
  }
  const patches: { start: number; end: number; value: string }[] = [];
  simple(ast, {
    Literal(node) {
      if (typeof node.value === "string" && /^https?:\/\//.test(node.value)) {
        try {
          if (known.has(canonical(node.value)))
            patches.push({
              start: node.start,
              end: node.end,
              value: JSON.stringify(map(node.value, base)),
            });
        } catch {}
      }
    },
  });
  for (const p of patches.sort((a, b) => b.start - a.start))
    source = source.slice(0, p.start) + p.value + source.slice(p.end);
  return source;
}
export function rewriteHTML(
  html: string,
  base: string,
  map: Mapper,
  known: Set<string>,
  injection: string,
): string {
  const doc = parse(html);
  let documentBase = base;
  function findBase(node: any) {
    if (node.tagName === "base") {
      const href = node.attrs.find((a: any) => a.name === "href");
      if (href) {
        try {
          documentBase = new URL(href.value, base).href;
        } catch {}
      }
    }
    for (const c of node.childNodes ?? []) findBase(c);
  }
  findBase(doc);
  function visit(node: any) {
    if (node.childNodes)
      node.childNodes = node.childNodes.filter(
        (n: any) =>
          !(
            n.tagName === "meta" &&
            n.attrs.some(
              (a: any) =>
                a.name === "http-equiv" &&
                /content-security-policy|refresh/i.test(a.value),
            )
          ),
      );
    if (node.attrs) {
      node.attrs = node.attrs.filter(
        (a: any) => !["integrity", "nonce"].includes(a.name),
      );
      for (const a of node.attrs) {
        if (
          ["src", "href", "poster", "action", "formaction", "data"].includes(
            a.name,
          )
        )
          a.value = map(a.value, documentBase);
        if (a.name === "srcset" && !a.value.includes("data:"))
          a.value = a.value
            .split(",")
            .map((part: string) => {
              const tokens = part.trim().split(/\s+/);
              tokens[0] = map(tokens[0], documentBase);
              return tokens.join(" ");
            })
            .join(", ");
        if (a.name === "style") {
          try {
            a.value = rewriteCSS("x{" + a.value + "}", documentBase, map).slice(
              2,
              -1,
            );
          } catch {}
        }
      }
    }
    if (node.tagName === "style")
      for (const c of node.childNodes ?? [])
        if (c.nodeName === "#text") {
          try {
            c.value = rewriteCSS(c.value, documentBase, map);
          } catch {}
        }
    if (
      node.tagName === "script" &&
      !node.attrs.some((a: any) => a.name === "src") &&
      !node.attrs.some(
        (a: any) => a.name === "type" && /json|importmap/.test(a.value),
      )
    )
      for (const c of node.childNodes ?? [])
        if (c.nodeName === "#text") {
          try {
            c.value = rewriteJS(c.value, documentBase, map, known);
          } catch {}
        }
    for (const c of node.childNodes ?? []) visit(c);
    if (node.content) visit(node.content);
  }
  visit(doc);
  return serialize(doc).replace(
    /<head([^>]*)>/i,
    (_m, attrs) => "<head" + attrs + ">" + injection,
  );
}
