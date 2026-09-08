# Decisión de arquitectura

Para la estrategia #3, NEXUS conserva la implementación existente de `ad-context-edge-workers` como fuente canónica.

No se añade un motor paralelo y no se crea dependencia circular entre `@nexus/ontology` y `@nexus/core`. Para cumplir el requisito de que las estrategias SEO operen como un sistema conectado, Core expone un adapter mínimo (`seo-profesional-adapter.ts`) que delega directamente en la personalización canónica, mientras Ontology mantiene el orquestador y el grafo de integración.

La separación es deliberada:

- Core sigue siendo autoridad de Camaleón Web y no importa Ontology.
- #1 y #2 permanecen en Ontology sin importar el motor de Core.
- `ConnectedSeoProfessionalSystem` conoce únicamente un puerto `CamaleonWebPort`, además de las APIs reales de #1 y #2.
- La integración cruzada se demuestra con pruebas, pero no se reimplementa ningún contrato del motor #3.

La razón es técnica: la capacidad existente ya supera el alcance mínimo solicitado y dispone de integración real, modos operativos, controles fail-closed, saneamiento de contexto, protección contra spoofing, telemetría y pruebas adversariales. Duplicarla reduciría calidad y aumentaría deriva; aislarla detrás de un adapter de composición conserva esa calidad y permite conectarla al circuito SEO.
