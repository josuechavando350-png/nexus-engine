/** Opt-in adapters. Dependencies are supplied by the consuming app, never Core. */
export interface LightboxPort {
  init(): void;
  destroy(): void;
}

export interface GalleryOptions {
  gallery: HTMLElement;
  children: string;
  showHideAnimationType?: "none";
  showAnimationDuration?: number;
  hideAnimationDuration?: number;
  zoomAnimationDuration?: number;
}

/** Keep ordinary image links in the document as the no-JavaScript fallback. */
export function mountPhotoSwipe(
  gallery: HTMLElement,
  createLightbox: (options: GalleryOptions) => LightboxPort,
  reducedMotion: boolean,
): () => void {
  const lightbox = createLightbox({
    gallery,
    children: "a[data-pswp-width][data-pswp-height]",
    ...(reducedMotion ? {
      showHideAnimationType: "none" as const,
      showAnimationDuration: 0,
      hideAnimationDuration: 0,
      zoomAnimationDuration: 0,
    } : {}),
  });
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    lightbox.destroy();
  };
  try {
    lightbox.init();
  } catch (error) {
    try { destroy(); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
  return destroy;
}

export interface CarouselOptions {
  loop: boolean;
  align: "start";
  duration?: number;
}

export interface CarouselPort {
  scrollPrev(jump?: boolean): void;
  scrollNext(jump?: boolean): void;
  canScrollPrev(): boolean;
  canScrollNext(): boolean;
  on(event: "select" | "reInit", callback: () => void): unknown;
  off(event: "select" | "reInit", callback: () => void): unknown;
  destroy(): void;
}

/** Buttons stay native and labelled by the app; no autoplay or scroll hijacking. */
export function mountEmbla(
  viewport: HTMLElement,
  createCarousel: (element: HTMLElement, options: CarouselOptions) => CarouselPort,
  controls: { previous: HTMLButtonElement; next: HTMLButtonElement },
  reducedMotion: boolean,
): () => void {
  const api = createCarousel(viewport, {
    loop: false,
    align: "start",
    ...(reducedMotion ? { duration: 0 } : {}),
  });
  const previousDisabled = controls.previous.disabled;
  const nextDisabled = controls.next.disabled;
  const previous = () => api.scrollPrev(reducedMotion);
  const next = () => api.scrollNext(reducedMotion);
  const update = () => {
    controls.previous.disabled = !api.canScrollPrev();
    controls.next.disabled = !api.canScrollNext();
  };
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    controls.previous.removeEventListener("click", previous);
    controls.next.removeEventListener("click", next);
    try {
      api.off("select", update);
      api.off("reInit", update);
    } finally {
      controls.previous.disabled = previousDisabled;
      controls.next.disabled = nextDisabled;
      api.destroy();
    }
  };
  try {
    controls.previous.addEventListener("click", previous);
    controls.next.addEventListener("click", next);
    api.on("select", update);
    api.on("reInit", update);
    update();
  } catch (error) {
    try { destroy(); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
  return destroy;
}

/** Explicit signals supplied by the app; do not infer device capability. */
export interface ImmersivePolicy {
  enabled: boolean;
  reducedMotion: boolean;
  reducedData: boolean;
  webglAvailable: boolean;
}

export function canUseImmersiveExperience(policy: ImmersivePolicy): boolean {
  return policy?.enabled === true && policy.reducedMotion === false &&
    policy.reducedData === false && policy.webglAvailable === true;
}
