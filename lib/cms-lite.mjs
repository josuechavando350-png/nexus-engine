const assertSegment = (value, label) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
};

export const defineCmsSchema = (parse) => {
  if (typeof parse !== 'function') throw new TypeError('CMS schema parser must be a function');
  return Object.freeze({ parse });
};

export const parseCmsDocument = (input, schema) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CMS document must be an object');
  if (!schema || typeof schema.parse !== 'function') throw new Error('CMS schema is required');
  const slug = assertSegment(String(input.slug ?? ''), 'slug');
  const locale = assertSegment(String(input.locale ?? 'es-MX'), 'locale');
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new Error('CMS document data must be an object');
  const updatedAt = input.updatedAt == null ? undefined : String(input.updatedAt);
  if (updatedAt && Number.isNaN(Date.parse(updatedAt))) throw new Error('CMS updatedAt must be ISO-compatible');
  return Object.freeze({ slug, locale, ...(updatedAt ? { updatedAt } : {}), data: schema.parse(input.data) });
};

export const createMemoryCms = (documents) => {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array');
  const map = new Map(documents.map((document) => [`${document.locale}:${document.slug}`, Object.freeze(document)]));
  return Object.freeze({
    get(slug, locale = 'es-MX') {
      return map.get(`${locale}:${slug}`) ?? null;
    },
    list(locale = 'es-MX') {
      return [...map.values()].filter((document) => document.locale === locale).sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    }
  });
};
