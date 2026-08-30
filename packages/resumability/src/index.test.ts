import { describe, expect, it } from "vitest";
import {
  MANIFEST_AUTHORITY,
  NON_CLAIM,
  STATE_AUTHORITY,
  createManifest,
  createState,
  renderPayload,
  resumeDocument,
  validateManifest,
  validateState,
  type Handler,
} from "./index.js";

function baseState() {
  return createState({ count: 1, hidden: false, nested: { value: "safe" } });
}

function baseManifest() {
  return createManifest(
    "a".repeat(64),
    [{ id: "increment", module: "/assets/increment.abc123.js", exportName: "increment" }],
    [{ id: "counter-click", event: "click", symbolId: "increment", stateIds: ["count"], preventDefault: false }],
  );
}

describe("resumability", () => {
  it("creates deterministic validated state and manifest envelopes", () => {
    const state = baseState();
    const manifest = baseManifest();
    expect(state.authority).toBe(STATE_AUTHORITY);
    expect(manifest.authority).toBe(MANIFEST_AUTHORITY);
    expect(manifest.nonClaim).toBe(NON_CLAIM);
    expect(() => validateState(state)).not.toThrow();
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(createState({ b: 2, a: 1 }).digest).toBe(createState({ a: 1, b: 2 }).digest);
  });

  it("rejects non-JSON, cyclic, prototype-sensitive and non-finite state", () => {
    expect(() => createState({ date: new Date() })).toThrow(/plain object|non-serializable/);
    expect(() => createState({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createState({ cyclic })).toThrow(/cycle/);
    const dangerous = JSON.parse('{"constructor":{"polluted":true}}') as Record<string, unknown>;
    expect(() => createState({ dangerous })).toThrow(/reserved key/);
  });

  it("rejects tampered state and manifest even when shape still looks plausible", () => {
    const state = baseState();
    expect(() => validateState({ ...state, values: { ...state.values, count: 99 } })).toThrow(/replay mismatch/);
    const manifest = baseManifest();
    expect(() => validateManifest({ ...manifest, buildDigest: "b".repeat(64) })).toThrow(/replay mismatch/);
  });

  it("enforces exact symbol and binding contracts", () => {
    expect(() => createManifest("a".repeat(64), [{ id: "s", module: "https://evil.example/x.js", exportName: "go" }], [])).toThrow(/root-relative/);
    expect(() => createManifest("a".repeat(64), [{ id: "s", module: "/x.js", exportName: "go" }], [{ id: "b", event: "click", symbolId: "missing" }])).toThrow(/unknown symbol/);
    expect(() => createManifest("a".repeat(64), [{ id: "s", module: "/x.js", exportName: "go" }], [{ id: "b", event: "submit", symbolId: "s", preventDefault: false }])).toThrow(/preventDefault=true/);
    expect(() => createManifest("a".repeat(64), [{ id: "s", module: "/x.js", exportName: "not-valid-name!" }], [])).toThrow(/exportName/);
  });

  it("binds captured state IDs before rendering payload", () => {
    const state = baseState();
    const manifest = createManifest("a".repeat(64), [{ id: "s", module: "/x.js", exportName: "go" }], [{ id: "b", event: "click", symbolId: "s", stateIds: ["missing"] }]);
    expect(() => renderPayload(manifest, state)).toThrow(/captures unknown state/);
  });

  it("escapes script-breaking text in serialized payloads", () => {
    const state = createState({ text: "</script><script>alert(1)</script>" });
    const manifest = createManifest("a".repeat(64), [], []);
    const html = renderPayload(manifest, state);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("does not import any handler merely by resuming", () => {
    const state = baseState();
    const manifest = baseManifest();
    const doc = new FakeDocument(renderPayload(manifest, state));
    const imports: string[] = [];
    const controller = resumeDocument({ document: doc as unknown as Document, importer: async (url) => { imports.push(url); return { increment: () => undefined }; } });
    expect(imports).toEqual([]);
    expect(controller.loaded.size).toBe(0);
    controller.dispose();
  });

  it("delegates an event, lazy-imports the exact same-origin module and projects captured state", async () => {
    const state = baseState();
    const manifest = baseManifest();
    const doc = new FakeDocument(renderPayload(manifest, state));
    const host = new FakeHTMLElement();
    host.setAttribute("data-nx-on-click", "counter-click");
    const output = new FakeHTMLElement();
    output.setAttribute("data-nx-text", "count");
    doc.projected.set('[data-nx-text="count"]', [output]);
    const imports: string[] = [];
    const handler: Handler = ({ state: captured }) => captured.set("count", captured.get<number>("count") + 1);
    const controller = resumeDocument({
      document: doc as unknown as Document,
      importer: async (url) => { imports.push(url); return { increment: handler }; },
    });
    doc.dispatchEvent(new PathEvent("click", [host]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(imports).toEqual(["https://example.com/assets/increment.abc123.js"]);
    expect(output.textContent).toBe("2");
    expect(controller.loaded.has("increment")).toBe(true);
    controller.dispose();
  });

  it("intercepts submit synchronously before a lazy handler resolves", () => {
    const state = createState({ value: "x" });
    const manifest = createManifest("a".repeat(64), [{ id: "submit", module: "/submit.js", exportName: "go" }], [{ id: "form-submit", event: "submit", symbolId: "submit", stateIds: ["value"], preventDefault: true }]);
    const doc = new FakeDocument(renderPayload(manifest, state));
    const host = new FakeHTMLElement();
    host.setAttribute("data-nx-on-submit", "form-submit");
    const controller = resumeDocument({ document: doc as unknown as Document, importer: () => new Promise(() => undefined) });
    const event = new PathEvent("submit", [host], { cancelable: true });
    doc.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    controller.dispose();
  });

  it("contains importer/handler failures through onError instead of unhandled rejection", async () => {
    const state = baseState();
    const manifest = baseManifest();
    const doc = new FakeDocument(renderPayload(manifest, state));
    const host = new FakeHTMLElement();
    host.setAttribute("data-nx-on-click", "counter-click");
    const errors: unknown[] = [];
    const controller = resumeDocument({
      document: doc as unknown as Document,
      importer: async () => { throw new Error("load failed"); },
      onError: (error) => errors.push(error),
    });
    doc.dispatchEvent(new PathEvent("click", [host]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    controller.dispose();
  });
});

class FakeElement extends EventTarget {
  textContent: string | null = null;
  private readonly attributes = new Map<string, string>();

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeHTMLElement extends FakeElement {
  hidden = false;
}

class PathEvent extends Event {
  private readonly path: EventTarget[];

  constructor(type: string, path: EventTarget[], init?: EventInit) {
    super(type, init);
    this.path = path;
  }

  override composedPath(): EventTarget[] {
    return this.path;
  }
}

class FakeDocument extends EventTarget {
  readonly baseURI = "https://example.com/page";
  readonly defaultView = { CSS: { escape: (value: string) => value } };
  readonly projected = new Map<string, FakeHTMLElement[]>();
  private readonly manifestNode = new FakeElement();
  private readonly stateNode = new FakeElement();

  constructor(payload: string) {
    super();
    const manifestMatch = payload.match(/id="nexus-resume-manifest">([^<]*)<\/script>/u);
    const stateMatch = payload.match(/id="nexus-resume-state">([^<]*)<\/script>/u);
    if (!manifestMatch || !stateMatch) throw new Error("test payload malformed");
    this.manifestNode.textContent = manifestMatch[1]!;
    this.stateNode.textContent = stateMatch[1]!;
  }

  getElementById(id: string): FakeElement | null {
    if (id === "nexus-resume-manifest") return this.manifestNode;
    if (id === "nexus-resume-state") return this.stateNode;
    return null;
  }

  querySelectorAll(selector: string): FakeHTMLElement[] {
    return this.projected.get(selector) ?? [];
  }
}

Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
