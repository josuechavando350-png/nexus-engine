export type TextFitRule = {
  id: string;
  route: string;
  selector: string;
  lineSelector: string;
  minFontSizePx: number;
};

export function validateTextFit(rules: TextFitRule[]) {
  if (!Array.isArray(rules) || rules.length > 100)
    throw new Error("Reglas de ajuste inválidas");
  const ids = new Set<string>(),
    targets = new Set<string>();
  for (const r of rules) {
    if (
      !r ||
      typeof r.id !== "string" ||
      !r.id ||
      ids.has(r.id) ||
      typeof r.route !== "string" ||
      !r.route.startsWith("/") ||
      r.route.startsWith("//") ||
      typeof r.selector !== "string" ||
      !r.selector ||
      r.selector.length > 2048 ||
      typeof r.lineSelector !== "string" ||
      !r.lineSelector ||
      r.lineSelector.length > 2048 ||
      !Number.isFinite(r.minFontSizePx) ||
      r.minFontSizePx < 12 ||
      r.minFontSizePx > 200 ||
      targets.has(r.route + ":" + r.selector)
    )
      throw new Error("Regla de ajuste inválida: " + r?.id);
    ids.add(r.id);
    targets.add(r.route + ":" + r.selector);
  }
  return rules;
}

/** Sizing only: never replaces text, markup, ARIA, line order or animation paths. */
function runtime(rules: TextFitRule[]) {
  type Result = {
    id: string;
    status: string;
    fontSize?: number;
    clippedPx?: number;
    lines?: number;
  };
  const global = window as unknown as {
    __BOT_MD_LAYOUT__: { route: string; results: Result[] };
  };
  const state = (global.__BOT_MD_LAYOUT__ = {
    route: "",
    results: [] as Result[],
  });
  const saved = new WeakMap<
    HTMLElement,
    {
      inline: string;
      priority: string;
      written: string;
      key: string;
      result: Result;
    }
  >();
  let pending = false,
    fontGeneration = 0;
  const resize = new ResizeObserver(schedule);
  function schedule() {
    if (!pending) {
      pending = true;
      requestAnimationFrame(apply);
    }
  }
  function apply() {
    pending = false;
    if (document.fonts.status === "loading") {
      void document.fonts.ready.then(schedule);
      return;
    }
    const route = location.pathname + location.search;
    if (route !== state.route) {
      state.route = route;
      resize.disconnect();
    }
    state.results = [];
    let changed = false;
    for (const rule of rules.filter((r) => r.route === route)) {
      try {
        const matches = document.querySelectorAll(rule.selector);
        if (matches.length !== 1) {
          state.results.push({
            id: rule.id,
            status: matches.length ? "ambiguous" : "missing",
          });
          continue;
        }
        const el = matches[0];
        if (
          !(el instanceof HTMLElement) ||
          !/^(H[1-6]|P|DIV|SPAN|A|BUTTON)$/.test(el.tagName)
        ) {
          state.results.push({ id: rule.id, status: "unsupported-element" });
          continue;
        }
        const lines = [...el.querySelectorAll(rule.lineSelector)];
        if (
          !lines.length ||
          lines.length > 100 ||
          !el.getClientRects().length
        ) {
          state.results.push({ id: rule.id, status: "missing-lines" });
          continue;
        }
        resize.observe(el);
        const style = getComputedStyle(el),
          box = el.getBoundingClientRect();
        let left = 0,
          right = Math.min(
            innerWidth,
            box.right - parseFloat(style.paddingRight),
          );
        for (
          let parent: HTMLElement | null = el;
          parent;
          parent = parent.parentElement
        ) {
          if (
            /(hidden|clip|auto|scroll)/.test(getComputedStyle(parent).overflowX)
          ) {
            const rect = parent.getBoundingClientRect();
            left = Math.max(left, rect.left + parent.clientLeft);
            right = Math.min(
              right,
              rect.left + parent.clientLeft + parent.clientWidth,
            );
          }
        }
        const key = JSON.stringify([
          left,
          right,
          innerWidth,
          el.textContent,
          style.fontFamily,
          style.fontWeight,
          style.letterSpacing,
          fontGeneration,
        ]);
        let old = saved.get(el);
        if (old?.key === key && old.written === el.style.fontSize) {
          state.results.push(old.result);
          continue;
        }
        if (!old || old.written !== el.style.fontSize)
          old = {
            inline: el.style.fontSize,
            priority: el.style.getPropertyPriority("font-size"),
            written: el.style.fontSize,
            key: "",
            result: { id: rule.id, status: "pending" },
          };
        const previous = el.style.fontSize;
        if (old.inline)
          el.style.setProperty("font-size", old.inline, old.priority);
        else el.style.removeProperty("font-size");
        const natural = parseFloat(getComputedStyle(el).fontSize);
        if (!Number.isFinite(natural) || right <= left) {
          state.results.push({ id: rule.id, status: "invalid-bounds" });
          continue;
        }
        function measure() {
          let clippedPx = 0,
            ratio = 1;
          for (const line of lines) {
            const range = document.createRange();
            range.selectNodeContents(line);
            const r = range.getBoundingClientRect();
            if (!r.width) continue;
            clippedPx = Math.max(clippedPx, left - r.left, r.right - right);
            ratio = Math.min(
              ratio,
              Math.max(0, right - Math.max(left, r.left)) / r.width,
            );
          }
          return { clippedPx, ratio };
        }
        let size = natural,
          measured = measure();
        const minimum = Math.min(natural, rule.minFontSizePx);
        for (
          let attempt = 0;
          attempt < 4 && measured.clippedPx > 0.5 && size > minimum;
          attempt++
        ) {
          size = Math.max(
            minimum,
            Math.floor(size * Math.min(0.99, measured.ratio) * 100) / 100,
          );
          el.style.setProperty("font-size", size + "px", old.priority);
          measured = measure();
        }
        const result = {
          id: rule.id,
          status:
            measured.clippedPx > 0.5
              ? "clipped"
              : size < natural
                ? "fitted"
                : "pass",
          fontSize: size,
          clippedPx: measured.clippedPx,
          lines: lines.length,
        };
        saved.set(el, { ...old, key, written: el.style.fontSize, result });
        state.results.push(result);
        if (previous !== el.style.fontSize) changed = true;
      } catch {
        state.results.push({ id: rule.id, status: "invalid-selector" });
      }
    }
    if (changed)
      window.dispatchEvent(
        new CustomEvent("bot-md:layout-updated", { detail: { route } }),
      );
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  window.addEventListener("resize", schedule);
  window.addEventListener("popstate", schedule);
  window.addEventListener("pageshow", schedule);
  document.fonts.addEventListener("loadingdone", () => {
    fontGeneration++;
    schedule();
  });
  schedule();
}

export function textFitRuntime(rules: TextFitRule[]) {
  validateTextFit(rules);
  return (
    "(" +
    runtime.toString() +
    ")(" +
    JSON.stringify(rules).replace(/</g, "\\u003c") +
    ");\n"
  );
}
