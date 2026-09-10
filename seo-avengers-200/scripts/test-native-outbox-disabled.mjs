import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueSeoAvengersSection } from "./seo-avengers-200-outbox.mjs";

async function exists(path) { try { await access(path); return true; } catch { return false; } }
for (const nexus of [{}, { CONFIG_SEO_AVENGERS_200: false }]) {
  const root = await mkdtemp(join(tmpdir(), "seo-avengers-off-"));
  const project = join(root, "apps", "client");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "@nexus/client", nexus }));
  const result = await enqueueSeoAvengersSection({
    projectDir: project,
    route: "/",
    sectionId: "hero",
    locale: "es-MX",
    text: "Contenido",
    sourceRevision: "abcdef1234567",
  });
  assert.equal(result.status, "DISABLED");
  assert.equal(await exists(join(root, ".artifacts")), false, "disabled tenant must not create .artifacts");
}
console.log("native outbox missing/false switch creates no artifacts: PASS");
