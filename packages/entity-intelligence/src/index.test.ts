import { describe, expect, it } from "vitest";
import {
  CloudNaturalLanguageClient,
  EXTERNAL_AUTHORITY,
  KnowledgeGraphClient,
  NON_CLAIM,
  assessEntities,
  createEntityDocument,
  parseCloudNaturalLanguageSnapshot,
  resolveFromKnowledgeGraphPayload,
  validateAnalysisSnapshot,
  validateEntityAssessment,
  validateEntityDocument,
  validateEntityResolution,
} from "./index.js";

function document() {
  return createEntityDocument(
    "https://example.com/defensa-fiscal#top",
    "es-MX",
    [
      { id: "intro", heading: "México fiscal", text: "El SAT es una entidad central para la defensa fiscal." },
      { id: "detail", heading: "Defensa", text: "La defensa fiscal frente al SAT requiere evidencia verificable." },
    ],
    [
      {
        id: "sat",
        name: "SAT",
        aliases: ["Servicio de Administración Tributaria"],
        schemaTypes: ["Organization"],
        minimumSalience: 0.2,
        minimumDistinctSections: 2,
        requireKnowledgeGraph: true,
      },
    ],
  );
}

function cloudPayload(doc = document()) {
  const first = Buffer.byteLength("México fiscal\nEl ", "utf8");
  const second = doc.sections[1]!.byteStart + Buffer.byteLength("Defensa\nLa defensa fiscal frente al ", "utf8");
  return {
    entities: [
      {
        name: "SAT",
        type: "ORGANIZATION",
        salience: 0.8,
        metadata: { mid: "/m/01234", wikipedia_url: "https://es.wikipedia.org/wiki/SAT" },
        mentions: [
          { text: { content: "SAT", beginOffset: first } },
          { text: { content: "SAT", beginOffset: second } },
        ],
      },
    ],
  };
}

function resolvedKgPayload() {
  return {
    itemListElement: [
      {
        result: {
          "@id": "/g/11sat",
          "@type": ["Organization"],
          name: "Servicio de Administración Tributaria",
          identifier: [{ propertyID: "googleKgMID", value: "/m/01234" }],
          url: "https://www.sat.gob.mx/",
        },
      },
    ],
  };
}

describe("entity intelligence", () => {
  it("binds UTF-8 section offsets and canonical document content", () => {
    const doc = document();
    expect(doc.url).toBe("https://example.com/defensa-fiscal");
    expect(doc.sections[0]!.byteEnd).toBe(doc.sections[1]!.byteStart);
    expect(doc.sections[1]!.byteEnd).toBe(Buffer.byteLength(doc.content, "utf8"));
    expect(() => validateEntityDocument(doc)).not.toThrow();
  });

  it("parses Cloud NLP entities with byte-offset section binding", () => {
    const doc = document();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, cloudPayload(doc));
    expect(snapshot.providerAuthority).toBe(EXTERNAL_AUTHORITY);
    expect(snapshot.entities[0]!.mentions.map((mention) => mention.sectionId)).toEqual(["intro", "detail"]);
    expect(() => validateAnalysisSnapshot(doc, snapshot)).not.toThrow();
  });

  it("rejects tampered document and mention section bindings", () => {
    const doc = document();
    expect(() => validateEntityDocument({ ...doc, content: `${doc.content}x` })).toThrow();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, cloudPayload(doc));
    const forgedEntity = {
      ...snapshot.entities[0]!,
      mentions: snapshot.entities[0]!.mentions.map((mention, index) => index === 0 ? { ...mention, sectionId: "detail" } : mention),
    };
    expect(() => validateAnalysisSnapshot(doc, { ...snapshot, entities: [forgedEntity] })).toThrow(/section binding|digest/);
  });

  it("uses exact MID lookup as the strongest conservative resolution", () => {
    const doc = document();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, cloudPayload(doc));
    const entity = snapshot.entities[0]!;
    const resolution = resolveFromKnowledgeGraphPayload(doc, entity, "NLP_MID_LOOKUP", resolvedKgPayload());
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.resolved?.googleKgMid).toBe("/m/01234");
    expect(() => validateEntityResolution(doc, entity, resolution)).not.toThrow();
  });

  it("returns AMBIGUOUS for equally strong search candidates", () => {
    const doc = document();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, { ...cloudPayload(doc), entities: [{ ...cloudPayload(doc).entities[0], metadata: {} }] });
    const entity = snapshot.entities[0]!;
    const payload = {
      itemListElement: [
        { result: { "@id": "/g/a", "@type": ["Organization"], name: "SAT", identifier: [], url: "https://example.com/a" } },
        { result: { "@id": "/g/b", "@type": ["Organization"], name: "Servicio de Administración Tributaria", identifier: [], url: "https://example.com/b" } },
      ],
    };
    const resolution = resolveFromKnowledgeGraphPayload(doc, entity, "KNOWLEDGE_GRAPH_SEARCH", payload);
    expect(resolution.status).toBe("AMBIGUOUS");
    expect(resolution.resolved).toBeNull();
  });

  it("fails closed when a required KG resolution is missing and passes once resolved", () => {
    const doc = document();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, cloudPayload(doc));
    const missing = assessEntities(doc, snapshot, []);
    expect(missing.status).toBe("NEEDS_WORK");
    expect(missing.results[0]!.knowledgeGraphStatus).toBe("MISSING");

    const resolution = resolveFromKnowledgeGraphPayload(doc, snapshot.entities[0]!, "NLP_MID_LOOKUP", resolvedKgPayload());
    const assessment = assessEntities(doc, snapshot, [resolution]);
    expect(assessment.status).toBe("READY");
    expect(assessment.nonClaim).toBe(NON_CLAIM);
    expect(() => validateEntityAssessment(doc, snapshot, [resolution], assessment)).not.toThrow();
  });

  it("rejects forged assessment and forged resolution status by deterministic replay", () => {
    const doc = document();
    const snapshot = parseCloudNaturalLanguageSnapshot(doc, cloudPayload(doc));
    const resolution = resolveFromKnowledgeGraphPayload(doc, snapshot.entities[0]!, "NLP_MID_LOOKUP", resolvedKgPayload());
    expect(() => validateEntityResolution(doc, snapshot.entities[0]!, { ...resolution, status: "AMBIGUOUS" })).toThrow(/replay mismatch/);
    const assessment = assessEntities(doc, snapshot, [resolution]);
    expect(() => validateEntityAssessment(doc, snapshot, [resolution], { ...assessment, status: "NEEDS_WORK" })).toThrow(/replay mismatch/);
  });

  it("rejects unsafe provider URLs and out-of-document offsets", () => {
    const doc = document();
    const unsafe = cloudPayload(doc);
    unsafe.entities[0]!.metadata.wikipedia_url = "javascript:alert(1)";
    expect(() => parseCloudNaturalLanguageSnapshot(doc, unsafe)).toThrow(/HTTP\(S\)/);
    const offset = cloudPayload(doc);
    offset.entities[0]!.mentions[0]!.text.beginOffset = 1_999_999;
    expect(() => parseCloudNaturalLanguageSnapshot(doc, offset)).toThrow(/outside document/);
  });

  it("executes bounded provider clients through injectable transport", async () => {
    const doc = document();
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("language.googleapis.com")) return Response.json(cloudPayload(doc));
      return Response.json(resolvedKgPayload());
    };
    const nlp = new CloudNaturalLanguageClient(async () => "token", fetchImpl, 1_000);
    const snapshot = await nlp.analyze(doc);
    const kg = new KnowledgeGraphClient("nexus-test1", async () => "token", fetchImpl, 1_000);
    const resolution = await kg.resolve(doc, snapshot.entities[0]!);
    expect(resolution.status).toBe("RESOLVED");
    expect(calls.some((url) => url.includes("documents:analyzeEntities"))).toBe(true);
    expect(calls.some((url) => url.includes("cloudKnowledgeGraphEntities:Lookup"))).toBe(true);
  });

  it("rejects provider and document resource abuse", () => {
    const doc = document();
    expect(() => parseCloudNaturalLanguageSnapshot(doc, { entities: Array.from({ length: 1_001 }, () => ({ name: "x", salience: 0 })) })).toThrow(/1000/);
    expect(() => createEntityDocument("https://example.com", "es", Array.from({ length: 501 }, (_, index) => ({ id: `s${index}`, heading: "h", text: "t" })), [])).toThrow(/500/);
  });
});
