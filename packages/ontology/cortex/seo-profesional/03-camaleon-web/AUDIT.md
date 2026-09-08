# Auditoría — Camaleón Web

## Resultado

**KEEP EXISTING IMPLEMENTATION + CONNECT THROUGH AN ISOLATED ADAPTER**.

La estrategia propuesta originalmente pedía un Query-Driven UI Engine con ejecución en Edge y selección de experiencia a partir de parámetros de URL. La auditoría encontró que NEXUS ya tiene una implementación canónica más completa en `packages/core/cortex/ad-context-edge-workers` y una integración de producción en `apps/cano-penal`.

## Comparación contra el objetivo original

| Requisito | Implementación existente |
| --- | --- |
| Parsing de query en Edge | Sí, con `URL`/`URLSearchParams` y límites de bytes/longitud. |
| Selección determinista de variante | Sí, por reglas exactas y fallback por canal. |
| Variantes allowlisted | Sí. |
| Cambio real de UI | Sí: headline, subheadline, CTA, layout profile y orden de bloques predeclarados. |
| Middleware real | Sí, `apps/cano-penal/src/middleware.ts`. |
| Render real | Sí, la experiencia se propaga al render y existe renderer HTML reusable. |
| Protección contra spoofing | Sí, el middleware elimina headers de experiencia aportados por el cliente. |
| Parámetros duplicados/malformados | Fail-safe al default. |
| Señales contradictorias | Fail-safe al default. |
| Kill switch | Sí. |
| Observe-only | Sí. |
| Control remoto | Sí, con modo más restrictivo y fail-closed. |
| Telemetría | Sí, estructurada y sin request context crudo. |
| Protección de click IDs | Sí, no se reflejan al HTML/telemetría. |
| Cache segura al personalizar | Sí, `private, no-store`. |
| Tests adversariales | Sí. |

## Auditoría de conectividad #1–#3

El requisito adicional es que todas las estrategias SEO permanezcan conectadas sin fusionar sus internals. La solución auditada es:

- `packages/ontology/cortex/seo-profesional/topology.ts` registra el grafo #1 -> #2 -> #3 -> #1 y exige conectividad fuerte.
- `packages/ontology/cortex/seo-profesional/connected-system.ts` fija una sola identidad `googleAdsCustomerId`, ejecuta #1 antes de #3 y conecta las conversiones de #1 con atribución firmada.
- `packages/core/cortex/ad-context-edge-workers/seo-profesional-adapter.ts` es un adapter mínimo que delega en `personalizeAdContext`; no contiene lógica alternativa de Camaleón.
- el recibo de atribución no contiene el click ID crudo: firma assessment, customer, score, tipo de click y un digest HMAC del identificador.
- una conversión con recibo manipulado, customer distinto, tipo de click distinto o click distinto falla antes del sink externo.
- #2 recibe el customer id desde el sistema conectado, evitando optimizar accidentalmente una cuenta distinta a la usada por el feedback de #1.

## Decisión

No se crea otra implementación de Camaleón. El motor actual permanece como fuente canónica. Solo se añade el adapter mínimo necesario para composición y una capa de orquestación separada; no se introducen imports Core -> Ontology ni se modifica la integración de producción existente de `apps/cano-penal`.
