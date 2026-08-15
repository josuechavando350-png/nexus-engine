export type CreativeScope = Readonly<{ tenantId: string; brandId: string }>;

const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new CreativeValidationError(field, `${field} is required`);
}

export function assertScope(scope: CreativeScope): void {
  assertCanonicalId(scope.tenantId, "scope.tenantId");
  assertCanonicalId(scope.brandId, "scope.brandId");
}

export function assertCanonicalId(value: string, field: string): void {
  if (!CANONICAL_ID.test(value)) throw new CreativeValidationError(field, `${field} must be a canonical identifier`);
}

export function canonicalTimestamp(value: string, field: string): number {
  if (!CANONICAL_TIMESTAMP.test(value)) throw new CreativeValidationError(field, `${field} must be canonical ISO 8601 UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new CreativeValidationError(field, `${field} must be canonical ISO 8601 UTC`);
  const canonical = new Date(parsed).toISOString();
  const normalizedInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (canonical !== normalizedInput) throw new CreativeValidationError(field, `${field} must be canonical ISO 8601 UTC`);
  return parsed;
}

export function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CreativeValidationError extends Error {
  readonly code = "INVALID_METADATA" as const;
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "CreativeValidationError";
  }
}
