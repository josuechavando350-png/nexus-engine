"use client";

import { RefObject, useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export function useSmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
    const tick = (time: number) => lenis.raf(time * 1000);
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);
}

export function useLoopScope(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(([entry]) => {
      node.dataset.running = entry.isIntersecting ? "true" : "false";
    }, { threshold: 0.08 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
}

export function useHeroParallax(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.to(".hero-face", { y: 12, ease: "none", scrollTrigger: { trigger: node, start: "top top", end: "bottom top", scrub: true } });
      gsap.to(".hero-hud", { y: 28, ease: "none", scrollTrigger: { trigger: node, start: "top top", end: "bottom top", scrub: true } });
    }, node);
    return () => ctx.revert();
  }, [ref]);
}

export function useCoreExplode(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      const layers = gsap.utils.toArray<HTMLElement>(".core-layer");
      layers.forEach((layer, index) => {
        gsap.to(layer, {
          y: index * 58,
          z: index * 38,
          ease: "none",
          scrollTrigger: { trigger: node, start: "top 86%", end: "bottom 22%", scrub: true },
        });
      });
      gsap.fromTo(".core-connectors path", { strokeDashoffset: 160 }, {
        strokeDashoffset: 0,
        ease: "none",
        scrollTrigger: { trigger: node, start: "top 86%", end: "bottom 22%", scrub: true },
      });
    }, node);
    return () => ctx.revert();
  }, [ref]);
}
