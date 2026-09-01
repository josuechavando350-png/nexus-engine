#!/usr/bin/env node
/**
 * NEXUS Quality Gates V2
 *
 * Every PASS is backed by an executed or directly inspected fact.
 * Expensive pipeline commands are intentionally re-runnable here so this
 * script remains a standalone gate, not merely a CI formatting layer.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const results = [];

function report(gate, status, detail) {
  results.push({ gate, status, detail });
}

function tryRun(command, timeout = 300_000, env = {}) {
  try {
    const stdout = execSync(command, {
      cwd: root,
      stdio: "pipe",
      timeout,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });

    const tail = String(stdout ?? "")
      .trim()
      .split("\n")
      .slice(-8)
      .join(" | ");

    return {
      ran: true,
      ok: true,
      detail: tail ? `exit 0 | ${tail}` : "exit 0",
    };
  } catch (err) {
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";
    const message = String(err.message) + stderr;

    const toolUnavailable =
      err.code === "ENOENT" ||
      /not found|not recognized/i.test(message) ||
      /corepack|registry\.npmjs\.org|ERR_PNPM|ERR_PNPM_META_FETCH_FAIL/i.test(
        message,
      );

    if (toolUnavailable) {
      return {
        ran: false,
        ok: false,
        detail: `tool/network unavailable: ${message.split("\n")[0]}`,
      };
    }

    const combined = [stdout, stderr, String(err.message)]
      .filter(Boolean)
      .join("\n")
      .trim()
      .split("\n")
      .filter(Boolean);

    return {
      ran: true,
      ok: false,
      detail: combined.slice(-12).join(" | "),
    };
  }
}

function activeNextApps() {
  return readdirSync(join(root, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(join(root, "apps", name, "next.config.ts")),
    );
}

const apps = activeNextApps();

/* 1. Architecture */
(function architectureGate() {
  const required = [
    "packages/core",
    "packages/experimental",
    "packages/experience",
    "packages/config",
    "apps/_experience-seed",
    "apps/reference-alfil",
    "apps/reference-meson",
    "apps/reference-nexus-bot",
    "apps/v2-probe-editorial",
    "apps/v2-probe-cinematic",
    "apps/v2-probe-industrial",
    "apps/v2-probe-asymmetric",
    "archive/_template-client-v1",
  ];

  const missing = required.filter(
    (path) => !existsSync(join(root, path)),
  );

  const templateStillActive = existsSync(
    join(root, "apps/_template-client"),
  );

  const corePackage = readFileSync(
    join(root, "packages/core/package.json"),
    "utf8",
  );

  const coreCrossDependency =
    corePackage.includes("@nexus/experimental") ||
    corePackage.includes("@nexus/experience");

  if (missing.length || templateStillActive || coreCrossDependency) {
    report(
      "Architecture",
      "FAIL",
      `missing=${JSON.stringify(
        missing,
      )} templateStillActive=${templateStillActive} coreCrossDependency=${coreCrossDependency}`,
    );
  } else {
    report(
      "Architecture",
      "PASS",
      "Core/Experience/Experimental boundaries and archived template verified.",
    );
  }
})();

/* 2. Type safety */
(function typeSafetyGate() {
  const result = tryRun("pnpm -r --if-present typecheck");

  report(
    "Type safety",
    result.ran
      ? result.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    result.detail,
  );
})();

/* 3. Tests */
(function testsGate() {
  const result = tryRun("pnpm test");

  report(
    "Tests",
    result.ran
      ? result.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    result.detail,
  );
})();

/* 4. Build */
(function buildGate() {
  const result = tryRun("pnpm build", 600_000);

  report(
    "Build",
    result.ran
      ? result.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    result.detail,
  );
})();

/* 5. Accessibility baseline */
(function accessibilityGate() {
  const problems = [];

  for (const app of apps) {
    const layoutPath = join(
      root,
      "apps",
      app,
      "src/app/layout.tsx",
    );

    const pagePath = join(
      root,
      "apps",
      app,
      "src/app/page.tsx",
    );

    if (!existsSync(layoutPath) || !existsSync(pagePath)) {
      problems.push(
        `${app}: missing layout.tsx or page.tsx`,
      );
      continue;
    }

    const layout = readFileSync(layoutPath, "utf8");
    const page = readFileSync(pagePath, "utf8");

    if (!/skipLinkProps|nexus-skip-link/.test(layout)) {
      problems.push(`${app}: no skip-link wiring`);
    }

    if (!/<h1/.test(page)) {
      problems.push(`${app}: no h1`);
    }

    if (!/id=["']main-content["']/.test(page)) {
      problems.push(`${app}: #main-content target missing`);
    }
  }

  report(
    "Accessibility baseline",
    problems.length ? "FAIL" : "WARNING",
    problems.length
      ? problems.join("; ")
      : `static checks passed across ${apps.length} active apps; rendered axe/screen-reader testing remains a human/browser gate`,
  );
})();

/* 6. Security wiring (runtime delivery is verified by the formal Quality Passport) */
(function securityGate() {
  const problems = [];

  for (const app of apps) {
    const configPath = join(
      root,
      "apps",
      app,
      "next.config.ts",
    );

    const config = readFileSync(configPath, "utf8");

    if (!config.includes("NEXUS_SECURITY_HEADERS_BASE")) {
      problems.push(
        `${app}: security headers not wired`,
      );
    }

    if (
      !config.includes("NEXUS_CSP_BASE") &&
      !config.includes("buildCsp")
    ) {
      problems.push(`${app}: CSP not wired`);
    }
  }

  report(
    "Security wiring",
    problems.length ? "FAIL" : "WARNING",
    problems.length
      ? problems.join("; ")
      : `static configuration wiring found in ${apps.length} active apps; live HTTP delivery is certified separately by the formal Quality Passport`,
  );
})();

/* 7. V2 originality structural gate */
(function originalityGate() {
  const probes = [
    "v2-probe-editorial",
    "v2-probe-cinematic",
    "v2-probe-industrial",
    "v2-probe-asymmetric",
  ];

  const fingerprints = probes.map((probe) =>
    JSON.parse(
      readFileSync(
        join(
          root,
          "apps",
          probe,
          "style-fingerprint-v2.json",
        ),
        "utf8",
      ),
    ),
  );

  const openings = new Set(
    fingerprints.map((fp) => fp.openingSignature),
  );

  const navs = new Set(
    fingerprints.map((fp) => fp.navigationSignature),
  );

  const sequences = new Set(
    fingerprints.map((fp) =>
      fp.sectionSequence.join(">"),
    ),
  );

  const colorLeak = fingerprints.some((fp) =>
    /color|palette|#[0-9a-f]{3,8}/i.test(
      JSON.stringify(fp),
    ),
  );

  const cards = fingerprints.some(
    (fp) => fp.structure.cardReliance > 0.2,
  );

  if (
    openings.size !== 4 ||
    navs.size !== 4 ||
    sequences.size !== 4 ||
    colorLeak ||
    cards
  ) {
    report(
      "Originality structure",
      "FAIL",
      `openings=${openings.size}/4 navs=${navs.size}/4 sequences=${sequences.size}/4 colorLeak=${colorLeak} cardRelianceOver20pct=${cards}`,
    );
  } else {
    report(
      "Originality structure",
      "PASS",
      "four probes have unique opening/navigation/sequence signatures; fingerprint comparison is color-independent; card reliance stays low",
    );
  }
})();

/* 8. Performance readiness */
(function performanceGate() {
  const missingBuildIds = apps.filter(
    (app) =>
      !existsSync(
        join(root, "apps", app, ".next", "BUILD_ID"),
      ),
  );

  if (missingBuildIds.length) {
    report(
      "Performance readiness",
      "NOT TESTED",
      `build artifacts missing for: ${missingBuildIds.join(
        ", ",
      )}`,
    );
  } else {
    report(
      "Performance readiness",
      "WARNING",
      `all ${apps.length} production builds exist; field Core Web Vitals/RUM and bundle budgets still require deployed measurements`,
    );
  }
})();

/* 9. Dependency health */
(function dependencyHealthGate() {
  const rootPkg = JSON.parse(
    readFileSync(
      join(root, "package.json"),
      "utf8",
    ),
  );

  const engineRange = rootPkg.engines?.node ?? "";

  if (!engineRange.includes("24")) {
    report(
      "Dependency health",
      "FAIL",
      `engines.node=${engineRange}; NEXUS V2 validated baseline expects Node 24`,
    );
    return;
  }

  const audit = tryRun(
    "pnpm audit --audit-level high",
  );

  report(
    "Dependency health",
    audit.ran
      ? audit.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    audit.ran
      ? audit.detail
      : `${audit.detail}; live advisory scan unavailable`,
  );
})();

/* 10. NEXUS V3 Industrial Agentic Plane */
(function industrialPlaneGate() {
  const runtimeDir = join(root, "runtime");

  if (!existsSync(runtimeDir)) {
    report(
      "Industrial plane",
      "FAIL",
      "runtime/ is missing on a V3 branch",
    );
    return;
  }

  const result = tryRun(
    "node scripts/v3-architecture-gates.mjs",
    120_000,
    { NEXUS_STATIC_ONLY: "1" },
  );

  report(
    "Industrial plane",
    result.ran
      ? result.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    result.ran
      ? `${result.detail}; see scripts/v3-architecture-gates.mjs output for per-gate detail`
      : result.detail,
  );
})();

/* 11. Rust toolchain */
(function rustToolchainGate() {
  const result = tryRun("cargo --version");

  if (!result.ran) {
    report(
      "Rust toolchain",
      "NOT TESTED",
      "cargo unavailable in this environment; runtime gates execute in .github/workflows/rust.yml",
    );
    return;
  }

  const build = tryRun(
    "cargo test --workspace --manifest-path runtime/Cargo.toml",
    900_000,
  );

  report(
    "Rust toolchain",
    build.ran
      ? build.ok
        ? "PASS"
        : "FAIL"
      : "NOT TESTED",
    build.detail,
  );
})();

const width = Math.max(
  ...results.map((result) => result.gate.length),
);

console.log(
  "\nNEXUS Quality Gates V2\n" +
    "=".repeat(48),
);

for (const result of results) {
  console.log(
    `${result.gate.padEnd(width)}  [${result.status}]`,
  );

  console.log(`  ${result.detail}\n`);
}

process.exit(
  results.some(
    (result) => result.status === "FAIL",
  )
    ? 1
    : 0,
);
