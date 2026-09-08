# Decisión de arquitectura

Para la estrategia #3, NEXUS conserva la implementación existente de `ad-context-edge-workers` como fuente canónica.

No se añade un motor paralelo, no se introduce un wrapper y no se crea una dependencia nueva entre `@nexus/ontology` y `@nexus/core`.

La razón es técnica: la capacidad existente ya supera el alcance mínimo solicitado y dispone de integración real, modos operativos, controles fail-closed, saneamiento de contexto, protección contra spoofing, telemetría y pruebas adversariales. Duplicarla reduciría calidad y aumentaría deriva.
