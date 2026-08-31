import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateSchema, type SchemaVersion } from "./index";
import { InMemoryOntologyPersistence, type OntologySnapshot } from "./persistence-query";
import { buildUnifiedSemanticGraph, projectSchemaOrg, queryUnifiedSemanticGraph, type SchemaOrgProjectionRule } from "./semantic-graph";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;

async function readBoundedJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) throw new Error(`${path} exceeds the semantic graph input budget`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be a string array`);
  return value as string[];
}

export interface SemanticGraphRuntimeInput {
  readonly schemaFile: string;
  readonly snapshotFile: string;
  readonly asOf: string;
  readonly rootIds: readonly string[];
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly schemaOrgRulesFile?: string;
}

export async function runSemanticGraphAudit(input: SemanticGraphRuntimeInput): Promise<Readonly<Record<string, unknown>>> {
  const schema = validateSchema(object(await readBoundedJson(input.schemaFile), "schema") as unknown as SchemaVersion);
  const snapshot = object(await readBoundedJson(input.snapshotFile), "snapshot") as unknown as OntologySnapshot;
  const persistence = new InMemoryOntologyPersistence();
  persistence.restoreSnapshot(snapshot, schema.scope);
  const graph = buildUnifiedSemanticGraph(persistence, schema, input.asOf);
  const query = queryUnifiedSemanticGraph(graph, {
    rootIds: input.rootIds,
    ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
  });

  let schemaOrg: readonly unknown[] | undefined;
  if (input.schemaOrgRulesFile) {
    const parsed = await readBoundedJson(input.schemaOrgRulesFile);
    if (!Array.isArray(parsed)) throw new Error("schema.org rules must be an array");
    schemaOrg = projectSchemaOrg(graph, parsed as SchemaOrgProjectionRule[]);
  }

  return {
    status: "VERIFIED",
    claim: "ONTOLOGY_DERIVED_SEMANTIC_GRAPH",
    scope: graph.scope,
    graphVersion: graph.graphVersion,
    graphDigest: graph.digest,
    evidenceState: graph.evidenceState,
    query,
    ...(schemaOrg ? { schemaOrg } : {}),
  };
}

function parseArgs(argv: readonly string[]): SemanticGraphRuntimeInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be provided as --key value pairs");
    if (values.has(key)) throw new Error(`duplicate argument ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--schema", "--snapshot", "--as-of", "--roots", "--max-hops", "--max-nodes", "--schema-org-rules"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown argument ${key}`);
  const schemaFile = values.get("--schema");
  const snapshotFile = values.get("--snapshot");
  const asOf = values.get("--as-of");
  const roots = values.get("--roots");
  if (!schemaFile || !snapshotFile || !asOf || !roots) throw new Error("--schema, --snapshot, --as-of and --roots are required");
  const rootIds = strings(roots.split(",").filter(Boolean), "roots");
  if (rootIds.length === 0) throw new Error("--roots must contain at least one object id");
  const maxHops = values.has("--max-hops") ? Number(values.get("--max-hops")) : undefined;
  const maxNodes = values.has("--max-nodes") ? Number(values.get("--max-nodes")) : undefined;
  return {
    schemaFile,
    snapshotFile,
    asOf,
    rootIds,
    ...(maxHops !== undefined ? { maxHops } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(values.get("--schema-org-rules") ? { schemaOrgRulesFile: values.get("--schema-org-rules")! } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSemanticGraphAudit(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
