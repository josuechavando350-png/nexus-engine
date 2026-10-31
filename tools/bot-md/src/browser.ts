import { chromium, type Page } from "playwright";
import type { Config, Layout, Step, Assertion } from "./types.js";
import { transportOptions, certificatePin } from "./transport.js";

export const launch = (captureTransport = false) => {
  const proxy = captureTransport ? transportOptions() : {};
  const pin = captureTransport ? certificatePin() : undefined;
  return chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    ...("server" in proxy ? { proxy: proxy as { server: string } } : {}),
    args: [
      "--disable-dev-shm-usage",
      ...(pin ? ["--ignore-certificate-errors-spki-list=" + pin] : []),
    ],
  });
};
export async function settle(page: Page, c: Config, scroll = false) {
  const readiness =
    c.readySelectors?.[new URL(page.url()).pathname] ?? c.readySelector;
  if (scroll && readiness)
    await page
      .locator(readiness)
      .first()
      .waitFor({ state: "attached", timeout: c.navigationTimeoutMs });
  await page.evaluate(async () => {
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  });
  if (scroll) {
    for (let i = 0; i < c.maxScrollSteps; i++) {
      const done = await page.evaluate(() => {
        window.scrollBy(0, Math.max(200, innerHeight * 0.8));
        return (
          scrollY + innerHeight >= document.documentElement.scrollHeight - 2
        );
      });
      await page.waitForTimeout(80);
      if (done) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(c.settleMs);
}
export async function applySteps(page: Page, steps: Step[]) {
  for (const step of steps) {
    const l = step.selector ? page.locator(step.selector).first() : undefined;
    switch (step.action) {
      case "click":
        await l!.click({ timeout: 5000 });
        break;
      case "hover":
        await l!.hover({ timeout: 5000 });
        break;
      case "focus":
        await l!.focus({ timeout: 5000 });
        break;
      case "fill":
        await l!.fill(step.value ?? "", { timeout: 5000 });
        break;
      case "select":
        await l!.selectOption(step.value ?? "", { timeout: 5000 });
        break;
      case "press":
        await l!.press(step.value ?? "Enter", { timeout: 5000 });
        break;
      case "scroll":
        await page.evaluate(
          ({ x, y }) => window.scrollTo(x ?? 0, y ?? 0),
          step,
        );
        break;
      case "wait":
        await page.waitForTimeout(step.ms ?? 0);
        break;
    }
  }
}
export async function checkAssertions(
  page: Page,
  assertions: Assertion[],
  timeoutMs = 20000,
  errors?: string[],
) {
  const results: boolean[] = [];
  for (const a of assertions) {
    try {
      const l = page.locator(a.selector).first();
      switch (a.kind) {
        case "visible":
          results.push(await l.isVisible());
          break;
        case "hidden":
          results.push(!(await l.isVisible()));
          break;
        case "text":
          results.push(
            (await l.innerText({ timeout: timeoutMs })).includes(a.value ?? ""),
          );
          break;
        case "attribute":
          results.push(
            (await l.getAttribute(a.attribute ?? "", {
              timeout: timeoutMs,
            })) === a.value,
          );
          break;
        case "value":
          results.push(
            (await l.inputValue({ timeout: timeoutMs })) === a.value,
          );
          break;
      }
    } catch (error) {
      errors?.push(a.selector + ": " + String(error));
      results.push(false);
    }
  }
  return results;
}
export async function layout(page: Page, maxElements: number): Promise<Layout> {
  return page.evaluate((limit) => {
    const props = [
      "display",
      "position",
      "box-sizing",
      "width",
      "height",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "color",
      "background-color",
      "background-image",
      "border-radius",
      "border-top-width",
      "border-top-color",
      "gap",
      "grid-template-columns",
      "flex-direction",
      "align-items",
      "justify-content",
      "transform",
      "opacity",
      "overflow",
      "object-fit",
      "object-position",
      "z-index",
    ];
    function selector(el: Element): string {
      if (el.id) return "#" + CSS.escape(el.id);
      const p = el.parentElement;
      if (!p) return el.tagName.toLowerCase();
      const siblings = [...p.children].filter((e) => e.tagName === el.tagName);
      return (
        selector(p) +
        " > " +
        el.tagName.toLowerCase() +
        ":nth-of-type(" +
        (siblings.indexOf(el) + 1) +
        ")"
      );
    }
    function styles(s: CSSStyleDeclaration) {
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
    }
    const elements = [...document.querySelectorAll("*")];
    const nodes = elements
      .filter(
        (e) =>
          ![
            "SCRIPT",
            "STYLE",
            "META",
            "LINK",
            "HEAD",
            "TITLE",
            "NOSCRIPT",
          ].includes(e.tagName),
      )
      .slice(0, limit)
      .map((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el),
          before = getComputedStyle(el, "::before"),
          after = getComputedStyle(el, "::after");
        const key = selector(el);
        return {
          key,
          selector: key,
          tag: el.tagName.toLowerCase(),
          text: [...el.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join("")
            .trim()
            .slice(0, 500),
          rect: {
            x: r.x + scrollX,
            y: r.y + scrollY,
            width: r.width,
            height: r.height,
          },
          style: styles(s),
          visible:
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== "hidden" &&
            s.display !== "none",
          attrs: Object.fromEntries(
            [...el.attributes]
              .filter((a) =>
                [
                  "id",
                  "class",
                  "role",
                  "aria-expanded",
                  "aria-hidden",
                  "aria-selected",
                  "open",
                  "href",
                  "src",
                  "srcset",
                  "type",
                  "placeholder",
                  "alt",
                ].includes(a.name),
              )
              .map((a) => [a.name, a.value]),
          ),
          before: { content: before.content, ...styles(before) },
          after: { content: after.content, ...styles(after) },
        };
      });
    return {
      title: document.title,
      url: location.href,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      scrollX,
      scrollY,
      input: {
        hover: matchMedia("(hover: hover)").matches,
        pointerFine: matchMedia("(pointer: fine)").matches,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        maxTouchPoints: navigator.maxTouchPoints,
      },
      nodes,
      truncated:
        elements.filter(
          (e) =>
            ![
              "SCRIPT",
              "STYLE",
              "META",
              "LINK",
              "HEAD",
              "TITLE",
              "NOSCRIPT",
            ].includes(e.tagName),
        ).length > limit,
      fonts: [...document.fonts].map((f) => ({
        family: f.family,
        status: f.status,
        weight: f.weight,
        style: f.style,
      })),
      animations: document.getAnimations().map((a) => ({
        currentTime: String(a.currentTime),
        playState: a.playState,
        timing: a.effect?.getTiming(),
        keyframes:
          a.effect instanceof KeyframeEffect ? a.effect.getKeyframes() : [],
      })),
      unsupported: {
        canvas: document.querySelectorAll("canvas").length,
        iframes: document.querySelectorAll("iframe").length,
        shadowHosts: elements.filter((e) => e.shadowRoot).length,
        videos: document.querySelectorAll("video").length,
      },
    };
  }, maxElements);
}
export async function discoverControls(page: Page, max: number) {
  return page.evaluate((limit) => {
    function selector(el: Element): string {
      if (el.id) return "#" + CSS.escape(el.id);
      const p = el.parentElement;
      if (!p) return el.tagName.toLowerCase();
      const siblings = [...p.children].filter((e) => e.tagName === el.tagName);
      return (
        selector(p) +
        " > " +
        el.tagName.toLowerCase() +
        ":nth-of-type(" +
        (siblings.indexOf(el) + 1) +
        ")"
      );
    }
    return [
      ...document.querySelectorAll(
        'details:not([open]) > summary,button[type="button"][aria-expanded="false"][aria-controls]',
      ),
    ]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .slice(0, limit)
      .map((el) => {
        const detail = el.parentElement?.tagName === "DETAILS",
          target = detail
            ? el.parentElement!
            : document.getElementById(el.getAttribute("aria-controls") ?? "");
        return {
          name: (el.textContent ?? "control").trim().slice(0, 80),
          steps: [{ action: "click" as const, selector: selector(el) }],
          assertions: target
            ? [
                {
                  selector: selector(detail ? el.parentElement! : el),
                  kind: "attribute" as const,
                  attribute: detail ? "open" : "aria-expanded",
                  value: detail ? "" : "true",
                },
              ]
            : [],
        };
      });
  }, max);
}
