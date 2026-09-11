import { enqueueSeoAvengersSection } from "../scripts/seo-avengers-200-outbox.mjs";

export function createSeoAwareCmsWriter({ writer, projectDir, sourceRevision, textSelector }) {
  if (!writer || typeof writer.upsert !== "function") throw new TypeError("writer.upsert is required");
  if (typeof textSelector !== "function") throw new TypeError("textSelector is required");
  return Object.freeze({
    async upsert(document) {
      const saved = await writer.upsert(document);
      const selection = textSelector(saved ?? document);
      void enqueueSeoAvengersSection({
        projectDir,
        route: selection.route ?? `/${document.slug}`,
        sectionId: selection.sectionId ?? document.slug,
        locale: document.locale ?? "es-MX",
        text: selection.text,
        keyword: selection.keyword ?? null,
        sourceRevision,
      });
      return saved;
    },
  });
}
