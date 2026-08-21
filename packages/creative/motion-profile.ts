export type MotionCurve = Readonly<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

export type MotionProfile = Readonly<{
  schemaVersion: 1;
  profileId: string;
  durationMs: Readonly<{
    micro: number;
    standard: number;
    deliberate: number;
  }>;
  easing: Readonly<{
    enter: MotionCurve;
    exit: MotionCurve;
    emphasis: MotionCurve;
  }>;
  spring: Readonly<{
    mass: number;
    stiffness: number;
    damping: number;
  }>;
  distancePx: Readonly<{
    micro: number;
    standard: number;
    large: number;
  }>;
  scrollDriven: Readonly<{
    enabled: boolean;
    maximumConcurrentEffects: number;
  }>;
  viewTransitions: Readonly<{
    enabled: boolean;
    crossDocumentAllowed: boolean;
  }>;
  reducedMotion: Readonly<{
    required: true;
    strategy: "REMOVE_NONESSENTIAL" | "REDUCE_DISTANCE";
  }>;
}>;

const finitePositive = (value: number, label: string, allowZero = false): number => {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${label} must be ${allowZero ? "non-negative" : "positive"} and finite`);
  return value;
};

const validateCurve = (curve: MotionCurve, label: string): MotionCurve => {
  for (const [key, value] of Object.entries(curve)) {
    if (!Number.isFinite(value)) throw new Error(`${label}.${key} must be finite`);
  }
  if (curve.x1 < 0 || curve.x1 > 1 || curve.x2 < 0 || curve.x2 > 1) throw new Error(`${label} x coordinates must be in [0,1]`);
  return Object.freeze({ ...curve });
};

export function validateMotionProfile(input: MotionProfile): MotionProfile {
  if (input.schemaVersion !== 1) throw new Error("unsupported MotionProfile schemaVersion");
  const profileId = input.profileId.trim();
  if (!profileId) throw new Error("profileId must be non-empty");
  if (input.reducedMotion.required !== true) throw new Error("reducedMotion.required must remain true");
  if (!Number.isInteger(input.scrollDriven.maximumConcurrentEffects) || input.scrollDriven.maximumConcurrentEffects < 0 || input.scrollDriven.maximumConcurrentEffects > 12) {
    throw new Error("scrollDriven.maximumConcurrentEffects must be an integer in 0..12");
  }

  return Object.freeze({
    ...input,
    profileId,
    durationMs: Object.freeze({
      micro: finitePositive(input.durationMs.micro, "durationMs.micro"),
      standard: finitePositive(input.durationMs.standard, "durationMs.standard"),
      deliberate: finitePositive(input.durationMs.deliberate, "durationMs.deliberate"),
    }),
    easing: Object.freeze({
      enter: validateCurve(input.easing.enter, "easing.enter"),
      exit: validateCurve(input.easing.exit, "easing.exit"),
      emphasis: validateCurve(input.easing.emphasis, "easing.emphasis"),
    }),
    spring: Object.freeze({
      mass: finitePositive(input.spring.mass, "spring.mass"),
      stiffness: finitePositive(input.spring.stiffness, "spring.stiffness"),
      damping: finitePositive(input.spring.damping, "spring.damping"),
    }),
    distancePx: Object.freeze({
      micro: finitePositive(input.distancePx.micro, "distancePx.micro", true),
      standard: finitePositive(input.distancePx.standard, "distancePx.standard", true),
      large: finitePositive(input.distancePx.large, "distancePx.large", true),
    }),
    scrollDriven: Object.freeze({ ...input.scrollDriven }),
    viewTransitions: Object.freeze({ ...input.viewTransitions }),
    reducedMotion: Object.freeze({ ...input.reducedMotion }),
  });
}

export function motionProfileToCss(profile: MotionProfile): string {
  const p = validateMotionProfile(profile);
  const curve = (value: MotionCurve) => `cubic-bezier(${value.x1}, ${value.y1}, ${value.x2}, ${value.y2})`;
  return [
    ":root {",
    `  --nexus-motion-micro: ${p.durationMs.micro}ms;`,
    `  --nexus-motion-standard: ${p.durationMs.standard}ms;`,
    `  --nexus-motion-deliberate: ${p.durationMs.deliberate}ms;`,
    `  --nexus-ease-enter: ${curve(p.easing.enter)};`,
    `  --nexus-ease-exit: ${curve(p.easing.exit)};`,
    `  --nexus-ease-emphasis: ${curve(p.easing.emphasis)};`,
    `  --nexus-distance-micro: ${p.distancePx.micro}px;`,
    `  --nexus-distance-standard: ${p.distancePx.standard}px;`,
    `  --nexus-distance-large: ${p.distancePx.large}px;`,
    "}",
    "@media (prefers-reduced-motion: reduce) {",
    "  *, *::before, *::after {",
    "    scroll-behavior: auto !important;",
    "    animation-duration: 0.01ms !important;",
    "    animation-iteration-count: 1 !important;",
    "    transition-duration: 0.01ms !important;",
    "  }",
    "}",
  ].join("\n");
}
