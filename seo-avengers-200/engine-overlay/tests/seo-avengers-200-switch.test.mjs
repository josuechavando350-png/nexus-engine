import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueSeoAvengersSection } from "../scripts/seo-avengers-200-outbox.mjs";

async function missingOrFalseIsZeroIo() {
  const root = await mkdtemp(join(tmpdir(), "nexus-avengers-200-off-"));
  const project = join(root, "apps", "client-off");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "@nexus/client-off", nexus: { clientProject: true, CONFIG_SEO_AVENGERS_200: false } }));
  const result = await enqueueSeoAvengersSection({ projectDir: project, route: "/", sectionId: "hero", locale: "es-MX", text: "hola", sourceRevision: "abcdef1" });
  assert.equal(result.status, "DISABLED");
  await assert.rejects(stat(join(root, ".artifacts")), { code: "ENOENT" });
}

async function explicitTrueQueuesDeterministically() {
  const root = await mkdtemp(join(tmpdir(), "nexus-avengers-200-on-"));
  const project = join(root, "apps", "client-on");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "@nexus/client-on",
    nexus: { clientProject: true, siteId: "client-on", canonicalOrigin: "https://example.com", CONFIG_SEO_AVENGERS_200: true },
  }));
  const input = { projectDir: project, route: "/", sectionId: "hero", locale: "es-MX", text: "contenido", sourceRevision: "abcdef1" };
  const first = await enqueueSeoAvengersSection(input);
  const second = await enqueueSeoAvengersSection(input);
  assert.equal(first.status, "QUEUED");
  assert.equal(second.status, "QUEUED");
  assert.equal(first.inputHash, second.inputHash);
  const envelope = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(envelope.authority, "NEXUS_SEO_AVENGERS_200_SECTION_V1");
  assert.equal(envelope.schema_version, 2);
  assert.equal(envelope.site_id, "client-on");
}

await missingOrFalseIsZeroIo();
await explicitTrueQueuesDeterministically();
console.log("engine overlay switch tests: PASS");
