const mounted = new WeakSet();
const clamp = (v) => Math.max(0, Math.min(1, v));
const number = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function validateScrollDetail(detail) {
    if (!detail ||
        detail.schemaVersion !== 1 ||
        detail.kind !== "scroll-svg" ||
        !Array.isArray(detail.variants) ||
        !detail.variants.length ||
        detail.variants.length > 12)
        throw new Error("Invalid scroll detail");
    const names = new Set(), widths = new Set();
    for (const v of detail.variants) {
        if (!v ||
            typeof v.name !== "string" ||
            !v.name ||
            names.has(v.name) ||
            !number(v.minWidth, 0, 3840) ||
            widths.has(v.minWidth) ||
            !Array.isArray(v.viewBox) ||
            v.viewBox.length !== 4 ||
            !v.viewBox.every((n) => number(n, -1e7, 1e7)) ||
            v.viewBox[2] <= 0 ||
            v.viewBox[3] <= 0 ||
            !Array.isArray(v.transform) ||
            v.transform.length !== 6 ||
            !v.transform.every((n) => number(n, -1e7, 1e7)) ||
            typeof v.path !== "string" ||
            !/^[Mm]/.test(v.path.trim()) ||
            v.path.length > 100000 ||
            !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/.test(v.path) ||
            typeof v.stroke !== "string" ||
            !/^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]+)$/i.test(v.stroke) ||
            !number(v.strokeWidth, 0.01, 100) ||
            !["butt", "round", "square"].includes(v.linecap) ||
            !["miter", "round", "bevel"].includes(v.linejoin))
            throw new Error("Invalid scroll variant: " + v?.name);
        names.add(v.name);
        widths.add(v.minWidth);
    }
    if (!widths.has(0))
        throw new Error("A scroll variant must start at width 0");
}
function settings(input) {
    const result = {
        start: 0.85,
        end: 0.25,
        smoothingMs: 100,
        headRadius: 4,
        endRingRadius: 12,
        ...input,
    };
    if (!number(result.start, 0, 1) ||
        !number(result.end, 0, 1) ||
        result.start < result.end ||
        !number(result.smoothingMs, 0, 2000) ||
        !number(result.headRadius, 0, 30) ||
        !number(result.endRingRadius, 0, 60))
        throw new Error("Invalid scroll options");
    return result;
}
export function mountScrollThread(host, definition, options = {}) {
    if (!(host instanceof HTMLElement) || !host.isConnected)
        throw new Error("Provide a connected host element");
    if (mounted.has(host))
        throw new Error("This host already contains a scroll thread");
    validateScrollDetail(definition);
    const detail = structuredClone(definition), variants = [...detail.variants].sort((a, b) => a.minWidth - b.minWidth);
    let config = settings(options), destroyed = false, frame = 0, progress = 0, target = 0, last = 0;
    let active, length = 0;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS(svg.namespaceURI, "path");
    const group = document.createElementNS(svg.namespaceURI, "g");
    const head = document.createElementNS(svg.namespaceURI, "circle");
    const ring = document.createElementNS(svg.namespaceURI, "circle");
    svg.classList.add("bot-md-thread-art");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;";
    path.setAttribute("fill", "none");
    path.setAttribute("class", "bot-md-thread-line");
    head.setAttribute("class", "bot-md-thread-head");
    ring.setAttribute("class", "bot-md-thread-ring");
    ring.setAttribute("fill", "none");
    group.append(path);
    svg.append(group, ring, head);
    const oldPosition = host.style.position, changedPosition = getComputedStyle(host).position === "static";
    if (changedPosition)
        host.style.position = "relative";
    host.append(svg);
    mounted.add(host);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = reduced.matches;
    function mediaChanged(event) {
        reducedMotion = event.matches;
        refresh();
    }
    const getVariant = () => variants
        .filter((v) => v.minWidth <= host.getBoundingClientRect().width)
        .at(-1);
    function geometry() {
        const variant = getVariant();
        if (active === variant)
            return;
        active = variant;
        svg.setAttribute("viewBox", variant.viewBox.join(" "));
        path.setAttribute("d", variant.path);
        group.setAttribute("transform", "matrix(" + variant.transform.join(" ") + ")");
        path.setAttribute("stroke", variant.stroke);
        path.style.stroke = "var(--bot-md-thread-color, " + variant.stroke + ")";
        path.setAttribute("stroke-linecap", variant.linecap);
        path.setAttribute("stroke-linejoin", variant.linejoin);
        head.style.fill = "var(--bot-md-thread-color, " + variant.stroke + ")";
        ring.style.stroke = "var(--bot-md-thread-color, " + variant.stroke + ")";
        ring.style.strokeWidth =
            "var(--bot-md-thread-width, " + variant.strokeWidth + "px)";
        length = path.getTotalLength();
        if (!Number.isFinite(length) || length <= 0)
            throw new Error("Selected SVG path has no drawable length");
        path.style.strokeDasharray = length + " " + length;
    }
    function paint() {
        path.style.strokeDashoffset = String(length * (1 - progress));
        path.style.visibility = progress > 0 ? "visible" : "hidden";
        const point = path.getPointAtLength(length * progress), m = active.transform;
        head.setAttribute("cx", String(m[0] * point.x + m[2] * point.y + m[4]));
        head.setAttribute("cy", String(m[1] * point.x + m[3] * point.y + m[5]));
        // Compensate scale without vector-effect, so dash length and head position agree.
        const rootMatrix = svg.getScreenCTM(), pathMatrix = path.getScreenCTM();
        const scale = rootMatrix ? Math.hypot(rootMatrix.a, rootMatrix.b) : 1;
        const strokeScale = pathMatrix
            ? Math.sqrt(Math.abs(pathMatrix.a * pathMatrix.d - pathMatrix.b * pathMatrix.c))
            : 1;
        path.style.strokeWidth = `calc(var(--bot-md-thread-width, ${active.strokeWidth}px) / ${Math.max(0.0001, strokeScale)})`;
        head.setAttribute("r", String(config.headRadius));
        const cx = Number(head.getAttribute("cx")), cy = Number(head.getAttribute("cy"));
        head.setAttribute("transform", scale > 0
            ? `translate(${cx} ${cy}) scale(${1 / scale}) translate(${-cx} ${-cy})`
            : "");
        head.style.visibility =
            progress > 0 && config.headRadius > 0 ? "visible" : "hidden";
        for (const attr of ["cx", "cy", "transform"])
            ring.setAttribute(attr, head.getAttribute(attr));
        ring.setAttribute("r", String(config.endRingRadius));
        ring.style.visibility =
            progress === 1 && config.endRingRadius > 0 ? "visible" : "hidden";
    }
    function measure() {
        geometry();
        const r = host.getBoundingClientRect();
        target = reducedMotion
            ? 1
            : clamp((innerHeight * config.start - r.top) /
                (Math.max(1, r.height) + innerHeight * (config.start - config.end)));
    }
    function tick(now) {
        frame = 0;
        if (destroyed)
            return;
        const dt = last ? Math.min(64, Math.max(0, now - last)) : 16;
        last = now;
        measure();
        progress =
            reducedMotion || config.smoothingMs === 0
                ? target
                : progress +
                    (target - progress) * (1 - Math.exp(-dt / config.smoothingMs));
        if (Math.abs(target - progress) < 0.00001)
            progress = target;
        paint();
        if (progress !== target)
            frame = requestAnimationFrame(tick);
        else
            last = 0;
    }
    function refresh() {
        if (!destroyed && !frame)
            frame = requestAnimationFrame(tick);
    }
    const observer = new ResizeObserver(refresh);
    function destroy() {
        if (destroyed)
            return;
        destroyed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        removeEventListener("scroll", refresh, true);
        removeEventListener("resize", refresh);
        removeEventListener("pageshow", refresh);
        reduced.removeEventListener("change", mediaChanged);
        svg.remove();
        mounted.delete(host);
        if (changedPosition && host.style.position === "relative")
            host.style.position = oldPosition;
    }
    try {
        geometry();
        measure();
        progress = target;
        paint();
        observer.observe(host);
        addEventListener("scroll", refresh, { passive: true, capture: true });
        addEventListener("resize", refresh);
        addEventListener("pageshow", refresh);
        reduced.addEventListener("change", mediaChanged);
    }
    catch (e) {
        destroy();
        throw e;
    }
    return {
        refresh,
        destroy,
        setOptions(next) {
            config = settings({ ...config, ...next });
            refresh();
        },
        getState() {
            return {
                variant: active.name,
                progress,
                target,
                reducedMotion,
                destroyed,
            };
        },
    };
}
