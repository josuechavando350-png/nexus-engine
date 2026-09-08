# 03 — El Camaleón Web

Estado: **IMPLEMENTADO POR CAPACIDAD CANÓNICA EXISTENTE Y CONECTADO AL SISTEMA SEO PROFESIONAL**.

Esta estrategia no introduce un segundo motor. Durante la auditoría previa a su implementación se encontró que NEXUS ya dispone de una implementación más completa y más endurecida que el Query-Driven UI Engine inicialmente propuesto.

## Implementación canónica

La lógica reusable vive en:

- `packages/core/cortex/ad-context-edge-workers/index.ts`
- `packages/core/cortex/ad-context-edge-workers/personalization.ts`

La integración de producción demostrada en una aplicación real vive en:

- `apps/cano-penal/src/ad-context.ts`
- `apps/cano-penal/src/ad-context-control.ts`
- `apps/cano-penal/src/middleware.ts`
- `apps/cano-penal/src/app/ad-context-copy.ts`
- `apps/cano-penal/src/app/page.tsx`

Para integrarlo con SEO Profesional sin duplicar el motor existe un adapter mínimo y tipado en:

- `packages/core/cortex/ad-context-edge-workers/seo-profesional-adapter.ts`

Ese adapter solo expone `resolve(URL | string)` sobre la implementación canónica. No reimplementa parsing, reglas, políticas, render ni seguridad.

El orquestador que conecta #1, #2 y #3 vive aparte en:

- `packages/ontology/cortex/seo-profesional/connected-system.ts`
- `packages/ontology/cortex/seo-profesional/topology.ts`

Así Core no importa Ontology, Ontology no importa internals de Core en producción, y cada estrategia conserva su autoridad propia.

Las pruebas canónicas incluyen:

- `packages/core/cortex/ad-context-edge-workers/index.test.ts`
- `packages/core/cortex/ad-context-edge-workers/personalization.test.ts`
- `apps/cano-penal/src/middleware.test.ts`
- `apps/cano-penal/src/app/ad-context-copy.test.ts`
- `packages/ontology/cortex/seo-profesional/connected-system.test.ts`
- `packages/ontology/cortex/seo-profesional/topology.test.ts`

## Qué hace realmente

- Evalúa contexto de URL con `URL`/`URLSearchParams` en el borde.
- Reconoce UTM y click IDs de paid search/social sin reflejar identificadores crudos al HTML ni a la decisión serializada.
- Permite reglas exactas predeclaradas por source/medium/campaign y evita reglas solapadas o ambiguas.
- Resuelve una experiencia allowlisted y puede cambiar headline, subheadline, CTA, layout profile y orden de bloques usando contenido predeclarado.
- Ejecuta en middleware real y propaga únicamente headers internos saneados hacia el render.
- Elimina headers de experiencia suministrados por el cliente antes de establecer los propios, evitando spoofing directo.
- Usa `private, no-store` cuando aplica una experiencia personalizada.
- Tiene modos `ACTIVE`, `OBSERVE_ONLY` y `KILLED`.
- Puede usar control remoto durable; si el control no es válido o no está disponible, falla cerrado al contenido por defecto.
- Registra telemetría estructurada y acotada sin copiar el request context crudo.
- Rechaza parámetros duplicados, valores sobredimensionados, contexto contradictorio y reglas de política inseguras.

## Conexión con #1 y #2

`ConnectedSeoProfessionalSystem` ejecuta #1 antes de #3 en cada landing. Si el score supera el máximo de personalización configurado, elimina el contexto de adquisición antes de llamar al adapter de Camaleón, por lo que la experiencia cae al default.

Cuando existe un único click ID de Google verificado por #1, el sistema emite un recibo de atribución HMAC con TTL configurable. El recibo contiene el `riskScore` de #1 y un digest HMAC del click ID, no el identificador crudo. Ese recibo es obligatorio para que una conversión posterior pueda entrar al motor offline de #1. El mismo `googleAdsCustomerId` también se inyecta automáticamente en el motor #2, cerrando el circuito de adquisición.

## Por qué no se creó otro motor

Crear una implementación paralela en `seo-profesional/03-camaleon-web` habría duplicado parsing, políticas, controles de seguridad y semántica de experiencias. Eso aumentaría deriva y superficie de fallo sin aportar una capacidad superior.

Por decisión de arquitectura, **la estrategia #3 adopta la implementación canónica existente**. El único código adicional de Core es un adapter mínimo de composición; no existe un segundo motor ni una dependencia circular entre paquetes.

## Alcance de seguridad y SEO

El Camaleón Web personaliza experiencias para contexto de adquisición legítimo. No debe usarse para mostrar a crawlers contenido engañosamente distinto del visible para usuarios equivalentes, ni para generar afirmaciones, precios, ubicaciones o promesas no aprobadas. Las variantes deben ser contenido real y predeclarado del negocio.
