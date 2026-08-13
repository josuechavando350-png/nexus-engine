import { tokenVar } from "../tokens";

/**
 * @status core
 *
 * Box-model normalization only. No client identity, no composition, no
 * color literal, no font-family literal. Promoted to Core in NEXUS V1.2
 * after this exact shape was found hand-written nearly identically 4
 * independent times (`_experience-seed` + 3 experience probes during
 * V1.1) — see docs/research/V1_1_VISUAL_DIVERSITY_REPORT.md.
 *
 * `surface.base`/`content.primary` are Experience-specific roles read
 * via token references — this sets no fallback color, so an unthemed
 * Experience renders with browser defaults, not a "safe" NEXUS look.
 */
export const NEXUS_RESET_CSS = `*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  min-height: 100%;
}

body {
  margin: 0;
  min-height: 100vh;
  overflow-x: hidden;

  background: ${tokenVar("surface.base")};
  color: ${tokenVar("content.primary")};

  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

button,
input,
textarea,
select {
  font: inherit;
}

button {
  cursor: pointer;
  border: none;
  background: none;
}

a {
  color: inherit;
}

img,
picture,
svg,
video {
  display: block;
  max-width: 100%;
}`;
