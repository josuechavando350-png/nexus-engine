export type CmsScalar = string | number | boolean | null;
export type CmsValue = CmsScalar | CmsValue[] | { [key: string]: CmsValue };

export interface CmsDocument<T extends Record<string, CmsValue> = Record<string, CmsValue>> {
  slug: string;
  locale: string;
  updatedAt?: string;
  data: T;
}

export interface CmsSchema<T extends Record<string, CmsValue>> {
  parse(input: unknown): T;
}

const assertSegment = (value: string, label: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
};

export const defineCmsSchema = <T extends Record<string, CmsValue>>(parse: (input: unknown) => T): CmsSchema<T> => ({ parse });

export const parseCmsDocument = <T extends Record<string, CmsValue>>(
  input: unknown,
  schema: CmsSchema<T>
): CmsDocument<T> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CMS document must be an object');
  const raw = input as Record<string, unknown>;
  const slug = assertSegment(String(raw.slug ?? ''), 'slug');
  const locale = assertSegment(String(raw.locale ?? 'es-MX'), 'locale');
  if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) throw new Error('CMS document data must be an object');
  const updatedAt = raw.updatedAt == null ? undefined : String(raw.updatedAt);
  if (updatedAt && Number.isNaN(Date.parse(updatedAt))) throw new Error('CMS updatedAt must be ISO-compatible');
  return { slug, locale, ...(updatedAt ? { updatedAt } : {}), data: schema.parse(raw.data) };
};

export const createMemoryCms = <T extends Record<string, CmsValue>>(documents: CmsDocument<T>[]) => {
  const map = new Map(documents.map((document) => [`${document.locale}:${document.slug}`, document]));
  return Object.freeze({
    get(slug: string, locale = 'es-MX') {
      return map.get(`${locale}:${slug}`) ?? null;
    },
    list(locale = 'es-MX') {
      return [...map.values()].filter((document) => document.locale === locale).sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    }
  });
};
