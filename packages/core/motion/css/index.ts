import { tokenVar } from "../../foundation/tokens";

export type MotionTransitionOptions = {
  property?: string;
  duration?: "fast" | "base" | "slow" | "instant";
  easing?: "standard" | "decelerate" | "accelerate" | "linear";
};

export function motionTransition({
  property = "all",
  duration = "base",
  easing = "standard"
}: MotionTransitionOptions = {}): string {
  return [
    property,
    tokenVar(`motion.duration.${duration}`),
    tokenVar(`motion.easing.${easing}`)
  ].join(" ");
}

export const NEXUS_MOTION_CSS = `
[data-nexus-motion="feedback"] {
  transition:
    opacity ${tokenVar("motion.duration.fast")} ${tokenVar("motion.easing.standard")},
    transform ${tokenVar("motion.duration.fast")} ${tokenVar("motion.easing.standard")};
}

[data-nexus-motion="transition"] {
  transition:
    opacity ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.standard")},
    transform ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.standard")};
}

[data-nexus-motion="enter"] {
  transition:
    opacity ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.decelerate")},
    transform ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.decelerate")};
}

[data-nexus-motion="exit"] {
  transition:
    opacity ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.accelerate")},
    transform ${tokenVar("motion.duration.base")} ${tokenVar("motion.easing.accelerate")};
}

[data-nexus-motion="emphasis"] {
  transition:
    opacity ${tokenVar("motion.duration.slow")} ${tokenVar("motion.easing.standard")},
    transform ${tokenVar("motion.duration.slow")} ${tokenVar("motion.easing.standard")};
}

@media (prefers-reduced-motion: reduce) {
  [data-nexus-motion] {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`.trim();
