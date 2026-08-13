export type OrganizationId = string & { readonly __brand: 'OrganizationId' };
export type ResourceKind = 'user'|'agent'|'dataset'|'graph'|'model'|'version'|'workflow'|'simulation'|'edge-device'|'policy'|'alert'|'secret-ref';
export interface ResourceRef { organization: OrganizationId; kind: ResourceKind; id: string }
export interface RequestMeta { requestId: string; idempotencyKey?: string; apiVersion: 'v1' }
export interface NexusControlTransport { command(meta: RequestMeta, command: unknown): Promise<unknown>; query(meta: RequestMeta, query: unknown): Promise<unknown> }
export class NexusControlClient { constructor(private readonly transport:NexusControlTransport){} command(meta:RequestMeta,command:unknown){return this.transport.command(meta,command)} query(meta:RequestMeta,query:unknown){return this.transport.query(meta,query)} }
