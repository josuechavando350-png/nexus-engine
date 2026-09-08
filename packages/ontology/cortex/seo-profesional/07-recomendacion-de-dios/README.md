# 07 — Recomendación de Dios

Estrategia de Knowledge Graph + datos estructurados que **adopta**, no duplica, la infraestructura semántica existente de Nexus.

## Implementación canónica conservada

Nexus ya contiene `packages/ontology/semantic-graph.ts`, que construye un Unified Semantic Graph tenant-scoped, valida provenance/revisiones, calcula digest por nodo/arista/grafo y ya expone `projectSchemaOrg`. #7 mantiene ese motor como autoridad. No crea un segundo grafo, no deriva hechos desde FAQ plana y no permite generar Schema.org desde texto libre.

`CanonicalSemanticGraphProvider` construye el grafo mediante `buildUnifiedSemanticGraph`; `VerifiedStructuredKnowledgeEngine` verifica su digest con `verifyUnifiedSemanticGraph` y realiza la proyección mediante `projectSchemaOrg`.

## Grounding y recibo

Cada artefacto emitido queda ligado por SHA-256 a:

- `graphDigest` y `schemaId` del grafo canónico;
- digests de los nodos concretos seleccionados para esa página;
- URL first-party canónica;
- evidencia de texto visible del DOM renderizado;
- reglas de proyección;
- JSON-LD final;
- versión de política Nexus/Google usada para la validación previa.

El recibo no incluye el texto completo de la página. `verifyGroundedStructuredDataArtifact()` vuelve a comprobar el JSON-LD y el digest del recibo.

## Política Rich Results

La primera política soporta de forma explícita `Organization`, `LocalBusiness`/subtipos, `Product` snippet, `Event`, `Article`/`NewsArticle`/`BlogPosting` y `BreadcrumbList`. Cada regla selecciona ids de nodos concretos; no se vuelca un tipo completo del grafo sobre una página.

Guardas adicionales:

- URL de página y `@id` siempre first-party HTTPS;
- `Organization.url`, `LocalBusiness.url` y `Product.url`, si aparecen, deben permanecer en el origen verificado;
- `LocalBusiness` bloquea `review`/`aggregateRating` para no convertir auto-reseñas en marcado enriquecido;
- Product exige `name` y al menos `offers`, `review` o `aggregateRating` con tipos Schema.org válidos;
- Event exige `name`, `startDate` y `location`;
- Breadcrumb exige al menos dos `ListItem` ordenados;
- propiedades visibles clave deben existir literalmente en el DOM renderizado aportado por el puerto de evidencia;
- salida JSON-LD escapa caracteres capaces de cerrar/alterar un `<script type="application/ld+json">`.

La salida se declara `READY_FOR_RICH_RESULTS_TEST`, **no** “aprobada por Google”. Google indica expresamente que el marcado correcto no garantiza que un rich result vaya a mostrarse. La publicación debe seguir validándose con Rich Results Test / URL Inspection cuando corresponda.

Referencias de política auditadas el 8 de septiembre de 2026: Google Search Central — General Structured Data Guidelines, Search Gallery, Organization, LocalBusiness, Product snippet, Event, Article y Breadcrumb.

## Integración

`VerifiedStructuredKnowledgeRuntime` compone por puertos un proveedor del grafo canónico y un proveedor de evidencia de página renderizada. `master-system.ts` solo conocerá este puerto estructural y verificará que su `publisherWebsiteOrigin` coincida con el origen canónico de #4.

No hay promesas de ranking, Knowledge Panel, snippet, carrusel ni CTR. Tampoco hay generación de ratings, reviews, precios, disponibilidad, credenciales o claims ausentes del grafo verificado.
