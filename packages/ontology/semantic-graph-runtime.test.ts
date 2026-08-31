import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSchema, type OntologyScope, type SchemaVersion } from "./index";
import { InMemoryOntologyPersistence } from "./persistence-query";
import { runSemanticGraphAudit } from "./semantic-graph-runtime";

const scope: OntologyScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };

function rawSchema(): SchemaVersion {
  return {
    version: "20.0.0",
    scope,
    properties: [{ id: "name", name: "name", valueKind: "STRING", cardinality: "REQUIRED", unique: false, immutable: false }],
    interfaces: [],
    objects: [{ id: "entity.person", name: "Person", propertyIds: ["name"], interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
}

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-semantic-graph-"));
  const schemaFile = join(directory, "schema.json");
  const snapshotFile = join(directory, "snapshot.json");
  const persistence = new InMemoryOntologyPersistence();
  persistence.upsertObject({ id: "p1", typeId: "entity.person", scope, revision: 1, properties: { name: "Ada" } });
  const snapshot = persistence.exportSnapshot(scope, "2026-08-31T08:30:00.000Z");
  await writeFile(schemaFile, JSON.stringify(rawSchema()), "utf8");
  await writeFile(snapshotFile, JSON.stringify(snapshot), "utf8");
  return { directory, schemaFile, snapshotFile, snapshot };
}

describe("semantic graph runtime boundary", () => {
  it("consumes a canonical integrity-bound snapshot and returns verified scoped evidence", async () => {
    const { schemaFile, snapshotFile } = await fixtures();
    const result = await runSemanticGraphAudit({
      schemaFile,
      snapshotFile,
      asOf: "2026-08-31T08:30:00.000Z",
      rootIds: ["p1"],
      maxHops: 0,
      maxNodes: 1,
    });
    expect(result.status).toBe("VERIFIED");
    expect(result.evidenceState).toBe("OBSERVED_ONTOLOGY_STATE");
    expect(result.scope).toEqual(scope);
    expect((result.query as { nodes: readonly { id: string }[] }).nodes.map((node) => node.id)).toEqual(["p1"]);
  });

  it("fails closed on snapshot tampering before graph materialization", async () => {
    const { schemaFile, snapshotFile, snapshot } = await fixtures();
    const tampered = structuredClone(snapshot);
    (tampered.objects[0]!.properties as Record<string, unknown>).name = "Mallory";
    await writeFile(snapshotFile, JSON.stringify(tampered), "utf8");
    await expect(runSemanticGraphAudit({ schemaFile, snapshotFile, asOf: "2026-08-31T08:30:00.000Z", rootIds: ["p1"] })).rejects.toThrow(/snapshot digest mismatch/);
  });

  it("rejects cross-tenant snapshot restore rather than remapping it implicitly", async () => {
    const { schemaFile, snapshotFile } = await fixtures();
    const foreignSchema = rawSchema();
    const validated = validateSchema({ ...foreignSchema, scope: { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" } });
    await writeFile(schemaFile, JSON.stringify({ ...foreignSchema, scope: validated.scope }), "utf8");
    await expect(runSemanticGraphAudit({ schemaFile, snapshotFile, asOf: "2026-08-31T08:30:00.000Z", rootIds: ["p1"] })).rejects.toThrow(/not explicitly authorized/);
  });

  it("rejects symlinked runtime inputs to avoid path substitution", async () => {
    const { directory, schemaFile, snapshotFile } = await fixtures();
    const linkedSchema = join(directory, "schema-link.json");
    await symlink(schemaFile, linkedSchema);
    await expect(runSemanticGraphAudit({ schemaFile: linkedSchema, snapshotFile, asOf: "2026-08-31T08:30:00.000Z", rootIds: ["p1"] })).rejects.toThrow(/symbolic link/);
  });
});
