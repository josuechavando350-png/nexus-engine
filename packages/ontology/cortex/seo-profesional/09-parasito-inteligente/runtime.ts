import { createHash } from "node:crypto";
import type { OntologyScope } from "../../../index.js";
import type { OntologyTransactionPort } from "../../../transaction.js";
import {
  ProgrammaticSeoEngine,
  createProgrammaticSeoPolicy,
  type CreateProgrammaticSeoPolicyInput,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoMode,
  type ProgrammaticSeoPolicy,
  type ProgrammaticSeoPublisher,
  type ProgrammaticSeoResult,
} from "../../headless-programmatic-seo/index.js";
import {
  AuthorizedProgrammaticSeoCatalogBoundary,
  type AuthorizedProgrammaticSeoSourcePolicy,
} from "./authorized-catalog.js";
import {
  normalizeProgrammaticOperatorOrigin,
  normalizeProgrammaticPropertyBaseUrl,
  type ProgrammaticPropertyAuthorizationEvidence,
  type ProgrammaticPropertyAuthorizationPort,
} from "./property-authorization.js";

export const AUTHORIZED_PROGRAMMATIC_SEO_RUNTIME_POLICY = "seo9-authorized-pseo-runtime-v1" as const;

export interface AuthorizedProgrammaticSeoRuntimeOptions {
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly operatorWebsiteOrigin: string;
  readonly scope: OntologyScope;
  readonly policy: CreateProgrammaticSeoPolicyInput;
  readonly transactions: OntologyTransactionPort;
  readonly catalog: ProgrammaticSeoCatalogProvider;
  readonly publisher: ProgrammaticSeoPublisher;
  readonly authorizer: ProgrammaticPropertyAuthorizationPort;
  readonly allowedSources: readonly AuthorizedProgrammaticSeoSourcePolicy[];
  readonly now?: () => number;
}

export interface AuthorizedProgrammaticSeoRunInput {
  readonly runId: string;
  readonly mode?: ProgrammaticSeoMode;
}

export interface AuthorizedProgrammaticSeoResult {
  readonly programmatic: ProgrammaticSeoResult;
  readonly authorization: ProgrammaticPropertyAuthorizationEvidence | null;
  readonly receiptDigest: string;
  readonly policyVersion: typeof AUTHORIZED_PROGRAMMATIC_SEO_RUNTIME_POLICY;
}

function receipt(programmatic: ProgrammaticSeoResult, authorization: ProgrammaticPropertyAuthorizationEvidence | null): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    programmaticDigest: programmatic.digest,
    authorizationDigest: authorization?.proofDigest ?? null,
    policyVersion: AUTHORIZED_PROGRAMMATIC_SEO_RUNTIME_POLICY,
  }), "utf8").digest("hex")}`;
}

export class AuthorizedProgrammaticSeoRuntime {
  readonly policy: ProgrammaticSeoPolicy;
  private readonly siteId: string;
  private readonly propertyBaseUrl: string;
  private readonly propertyOrigin: string;
  private readonly operatorWebsiteOrigin: string;
  private readonly engine: ProgrammaticSeoEngine;

  constructor(private readonly options: AuthorizedProgrammaticSeoRuntimeOptions) {
    if (!options || typeof options !== "object" || !options.authorizer || typeof options.authorizer.verify !== "function") {
      throw new TypeError("authorized programmatic SEO runtime configuration is invalid");
    }
    this.siteId = options.siteId.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(this.siteId)) throw new TypeError("authorized programmatic SEO siteId is malformed");
    this.propertyBaseUrl = normalizeProgrammaticPropertyBaseUrl(options.propertyBaseUrl);
    this.propertyOrigin = new URL(this.propertyBaseUrl).origin;
    this.operatorWebsiteOrigin = normalizeProgrammaticOperatorOrigin(options.operatorWebsiteOrigin);
    this.policy = createProgrammaticSeoPolicy(options.policy);
    const catalog = new AuthorizedProgrammaticSeoCatalogBoundary({
      siteId: this.siteId,
      propertyBaseUrl: this.propertyBaseUrl,
      allowedSources: options.allowedSources,
      catalog: options.catalog,
    });
    this.engine = new ProgrammaticSeoEngine(options.transactions, options.scope, this.policy, catalog, options.publisher, options.now ?? Date.now);
  }

  identity() {
    return Object.freeze({
      strategy: 9 as const,
      provider: "AUTHORIZED_HEADLESS_PROGRAMMATIC_SEO" as const,
      engine: "CORTEX_HEADLESS_PROGRAMMATIC_SEO" as const,
      siteId: this.siteId,
      propertyOrigin: this.propertyOrigin,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
    });
  }

  private authorize(): Promise<ProgrammaticPropertyAuthorizationEvidence> {
    return this.options.authorizer.verify({
      siteId: this.siteId,
      propertyBaseUrl: this.propertyBaseUrl,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
    });
  }

  async build(input: AuthorizedProgrammaticSeoRunInput): Promise<AuthorizedProgrammaticSeoResult> {
    const mode = input.mode ?? this.policy.mode;
    const authorization = mode === "KILLED" ? null : await this.authorize();
    const programmatic = await this.engine.build({ runId: input.runId, siteId: this.siteId, mode });
    return Object.freeze({
      programmatic,
      authorization,
      receiptDigest: receipt(programmatic, authorization),
      policyVersion: AUTHORIZED_PROGRAMMATIC_SEO_RUNTIME_POLICY,
    });
  }

  async rollbackLastMutation(input: Readonly<{ runId: string }>): Promise<AuthorizedProgrammaticSeoResult> {
    const authorization = await this.authorize();
    const programmatic = await this.engine.rollbackLastMutation({ runId: input.runId, siteId: this.siteId });
    return Object.freeze({
      programmatic,
      authorization,
      receiptDigest: receipt(programmatic, authorization),
      policyVersion: AUTHORIZED_PROGRAMMATIC_SEO_RUNTIME_POLICY,
    });
  }
}
