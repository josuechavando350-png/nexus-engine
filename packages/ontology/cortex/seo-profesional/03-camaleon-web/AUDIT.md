# Auditoría — Camaleón Web

## Resultado

**KEEP EXISTING IMPLEMENTATION**.

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

## Decisión

No se crea otra implementación. El motor actual permanece como fuente canónica y la estrategia #3 queda registrada en la carpeta maestra SEO. No se modifican sus contratos, código, dependencias ni integración de producción.
