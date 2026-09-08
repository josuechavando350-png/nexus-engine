import {
  ProgrammaticSeoError,
  validateProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
} from "../../headless-programmatic-seo/index.js";
import { normalizeProgrammaticPropertyBaseUrl } from "./property-authorization.js";

export type AuthorizedProgrammaticSeoContentRelationship = "OPERATOR_FIRST_PARTY" | "PROPERTY_OWNER_FIRST_PARTY";

export interface AuthorizedProgrammaticSeoSourcePolicy {
  readonly sourceId: string;
  readonly relationship: AuthorizedProgrammaticSeoContentRelationship;
}

export interface AuthorizedProgrammaticSeoCatalogBoundaryOptions {
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly allowedSources: readonly AuthorizedProgrammaticSeoSourcePolicy[];
  readonly catalog: ProgrammaticSeoCatalogProvider;
}

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

export class AuthorizedProgrammaticSeoCatalogBoundary implements ProgrammaticSeoCatalogProvider {
  readonly siteId: string;
  readonly propertyBaseUrl: string;
  readonly allowedSources: readonly AuthorizedProgrammaticSeoSourcePolicy[];
  private readonly sourceIds: ReadonlySet<string>;

  constructor(private readonly options: AuthorizedProgrammaticSeoCatalogBoundaryOptions) {
    if (!options || typeof options !== "object" || !options.catalog || typeof options.catalog.getCatalog !== "function") {
      throw new ProgrammaticSeoError("INVALID_INPUT", "authorized programmatic SEO catalog boundary configuration is invalid");
    }
    this.siteId = identifier(options.siteId, "siteId");
    this.propertyBaseUrl = normalizeProgrammaticPropertyBaseUrl(options.propertyBaseUrl);
    if (!Array.isArray(options.allowedSources) || options.allowedSources.length < 1 || options.allowedSources.length > 32) {
      throw new ProgrammaticSeoError("INVALID_INPUT", "allowedSources must contain 1..32 governed sources");
    }
    const sourceIds = new Set<string>();
    const allowed: AuthorizedProgrammaticSeoSourcePolicy[] = [];
    for (const source of options.allowedSources) {
      if (!source || typeof source !== "object" || (source.relationship !== "OPERATOR_FIRST_PARTY" && source.relationship !== "PROPERTY_OWNER_FIRST_PARTY")) {
        throw new ProgrammaticSeoError("INVALID_INPUT", "programmatic SEO source relationship is invalid");
      }
      const sourceId = identifier(source.sourceId, "allowedSources.sourceId");
      if (sourceIds.has(sourceId)) throw new ProgrammaticSeoError("INVALID_INPUT", `duplicate governed programmatic SEO source ${sourceId}`);
      sourceIds.add(sourceId);
      allowed.push(Object.freeze({ sourceId, relationship: source.relationship }));
    }
    this.allowedSources = Object.freeze(allowed);
    this.sourceIds = sourceIds;
  }

  async getCatalog(siteIdInput: string): Promise<ProgrammaticSeoCatalogSnapshot> {
    const siteId = identifier(siteIdInput, "siteId");
    if (siteId !== this.siteId) throw new ProgrammaticSeoError("POLICY_VIOLATION", "programmatic SEO catalog request is outside the configured site boundary");
    const catalog = await this.options.catalog.getCatalog(siteId);
    validateProgrammaticSeoCatalogSnapshot(catalog);
    if (catalog.siteId !== this.siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "programmatic SEO catalog siteId does not match the authorized property");
    if (normalizeProgrammaticPropertyBaseUrl(catalog.baseUrl) !== this.propertyBaseUrl) {
      throw new ProgrammaticSeoError("POLICY_VIOLATION", "programmatic SEO catalog attempted to publish outside the authorized property base URL");
    }
    if (!this.sourceIds.has(catalog.sourceId)) {
      throw new ProgrammaticSeoError("POLICY_VIOLATION", `programmatic SEO catalog source ${catalog.sourceId} is not governed for this property`);
    }
    return catalog;
  }
}
