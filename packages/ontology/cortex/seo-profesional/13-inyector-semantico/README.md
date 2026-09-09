# 13 — Inyector Semántico

`EntityGraphInterleaver` no crea un segundo Knowledge Graph. Consume únicamente `GroundedStructuredDataArtifact` producido por #7, exige `READY_FOR_RICH_RESULTS_TEST`, verifica el mismo origen canónico y materializa un único `<script type="application/ld+json">` idempotente dentro del HTML.

## schema-dts

`schema-dts` es una librería de **tipos TypeScript**, no un validador runtime. Por eso Nexus separa ambas responsabilidades:

1. #7 realiza la validación/grounding runtime, evidencia DOM y recibo hash.
2. #13 expone `SchemaDtsGraphShape` y `assertSchemaDtsGraphShape` como frontera runtime mínima.
3. En la aplicación TypeScript que ensambla la ruta se puede imponer el contrato oficial sin cargar código en runtime:

```ts
import type { Graph } from "schema-dts";
const graph: Graph = artifact.jsonLd;
```

Ese chequeo es compile-time; no se presenta como validación de datos no confiables.

## Seguridad e indexación

El serializador neutraliza `<`, `>` y separadores Unicode para impedir cierre de `<script>`. #13 también deriva elegibilidad para Google Indexing API exclusivamente de `JobPosting` o de `BroadcastEvent` anidado en `VideoObject`; cualquier otro Schema.org continúa siendo útil para rich results/semántica, pero no habilita #16.
