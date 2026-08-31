import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { operatorCommandSchema, type NexusOperatorRuntime, type OperatorRequestContext } from "./operator-gateway.js";
import { nexusBuild, nexusCapture, nexusComparator, nexusGates, nexusPassport, nexusProjectNew, nexusProjects, nexusStatus, type ToolDependencies } from "./tools.js";
import { REMOTE_READINESS_DEFAULT_TOOLS, type NexusToolName } from "./policy.js";

function resultContent(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
}

export interface NexusMcpServerOptions {
  allowProjectWrite?: boolean;
  enabledTools?: ReadonlySet<NexusToolName>;
  operatorRuntime?: NexusOperatorRuntime;
  operatorContext?: OperatorRequestContext;
}

export function createNexusMcpServer(dependencies: ToolDependencies, options: NexusMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "nexus-mcp-server", version: "0.1.0" });
  const enabled = options.enabledTools ?? new Set<NexusToolName>(REMOTE_READINESS_DEFAULT_TOOLS);
  if (enabled.has("nexus_status")) server.registerTool("nexus_status", {
    title: "NEXUS repository status",
    description: "Returns the current branch, exact HEAD SHA, worktree state, open pull requests, CI checks, and failing checks.",
    inputSchema: { includePullRequests: z.boolean().optional().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => resultContent(await nexusStatus(input, dependencies)));
  if (enabled.has("nexus_projects")) server.registerTool("nexus_projects", {
    title: "NEXUS workspace projects",
    description: "Returns workspace apps classified using the repository's explicit client-project admission rule.",
    inputSchema: { includeArchived: z.literal(false).optional().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => resultContent(await nexusProjects(input, dependencies)));
  if (enabled.has("nexus_gates")) server.registerTool("nexus_gates", {
    title: "NEXUS Quality Gates",
    description: "Executes allowlisted repository gates and returns evidence for every gate.",
    inputSchema: { target: z.string().min(1).optional(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), gates: z.array(z.enum(["lint", "typecheck", "test", "build", "quality-gates", "browser"])).min(1).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => resultContent(await nexusGates(input, dependencies)));
  if (enabled.has("nexus_passport")) server.registerTool("nexus_passport", {
    title: "NEXUS Quality Passport",
    description: "Reads and verifies the existing NEXUS Quality Passport source of truth for a target and SHA.",
    inputSchema: { target: z.string().min(1), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), passportPath: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => resultContent(await nexusPassport(input, dependencies)));
  if (enabled.has("nexus_capture")) server.registerTool("nexus_capture", {
    title: "NEXUS browser capture",
    description: "Captures mobile and desktop screenshots through the existing NEXUS Playwright capture adapter.",
    inputSchema: { source: z.union([z.object({ target: z.string().min(1) }).strict(), z.object({ url: z.string().url() }).strict()]), sourceSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), viewports: z.object({ mobile: z.object({ width: z.number().int().min(240), height: z.number().int().min(240) }).optional(), desktop: z.object({ width: z.number().int().min(240), height: z.number().int().min(240) }).optional() }).optional(), fullPage: z.literal(true).optional().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => resultContent(await nexusCapture(input, dependencies)));
  if (enabled.has("nexus_build")) server.registerTool("nexus_build", {
    title: "NEXUS target build",
    description: "Runs the existing NEXUS target build pipeline and returns a SHA-bound artifact identity manifest.",
    inputSchema: { target: z.string().min(1), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), clean: z.literal(true).optional().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => resultContent(await nexusBuild(input, dependencies)));
  if (enabled.has("nexus_comparator")) server.registerTool("nexus_comparator", {
    title: "NEXUS geometric comparator availability",
    description: "Reports the verified availability of the NEXUS geometric comparator; it does not synthesize comparisons.",
    inputSchema: { source: z.union([z.object({ target: z.string().min(1) }).strict(), z.object({ url: z.string().url() }).strict()]), sourceSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), viewports: z.array(z.object({ name: z.string().min(1), width: z.number().int().min(240), height: z.number().int().min(240) })).min(1).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => resultContent(await nexusComparator(input, dependencies)));
  if (options.allowProjectWrite && enabled.has("nexus_project_new")) server.registerTool("nexus_project_new", {
    title: "Create NEXUS client project",
    description: "Creates and commits a client app through the existing NEXUS scaffold on an isolated nexus-mcp/* branch.",
    inputSchema: {
      slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).refine((value) => !value.includes("--") && !["_", "reference-", "v2-probe-", "probe-", "test-"].some((prefix) => value.startsWith(prefix)), "slug uses a reserved or invalid project prefix"),
      business: z.object({ name: z.string().trim().min(1), industry: z.string().trim().min(1), location: z.string().trim().min(1), contact: z.object({ phone: z.string().trim().min(1).optional(), email: z.string().email().optional(), website: z.string().url().optional(), address: z.string().trim().min(1).optional() }).strict(), confirmedServices: z.array(z.object({ name: z.string().trim().min(1), description: z.string().trim().min(1).optional() }).strict()).min(1) }).strict(),
      artDirection: z.object({ palette: z.array(z.object({ hex: z.string().regex(/^#[A-Fa-f0-9]{6}$/), role: z.string().trim().min(1), rationale: z.string().trim().min(1) }).strict()).min(2).refine((items) => new Set(items.map((item) => item.role)).size === items.length, "palette roles must be unique"), typography: z.object({ display: z.string().trim().min(1), body: z.string().trim().min(1), rationale: z.string().trim().min(1) }).strict(), heroComposition: z.object({ direction: z.string().trim().min(1), rationale: z.string().trim().min(1) }).strict(), sectionRhythm: z.object({ direction: z.string().trim().min(1), rationale: z.string().trim().min(1) }).strict(), motion: z.object({ direction: z.string().trim().min(1), reducedMotionBehavior: z.string().trim().min(1), rationale: z.string().trim().min(1) }).strict(), prohibitions: z.array(z.string().trim().min(1)).min(1) }).strict(),
      baseSha: z.string().regex(/^[a-f0-9]{40}$/), branchName: z.string().regex(/^nexus-mcp\/[a-z0-9][a-z0-9/_-]*$/).optional(), commitMessage: z.string().trim().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => resultContent(await nexusProjectNew(input, dependencies)));
  if (enabled.has("nexus_operator")) {
    if (!options.operatorRuntime || !options.operatorContext) throw new Error("nexus_operator requires a server-owned operator runtime and request context");
    server.registerTool("nexus_operator", {
      title: "NEXUS governed operator gateway",
      description: "Executes a bounded typed NEXUS operator command through canonical status/project/build/gate/capture/passport/comparator/project-creation surfaces. Free-form text is data only and is never executed as shell, GitHub, deployment, or state mutation input.",
      inputSchema: { command: operatorCommandSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => resultContent(await options.operatorRuntime!.execute(input.command, dependencies, options.operatorContext!)));
  }
  return server;
}
