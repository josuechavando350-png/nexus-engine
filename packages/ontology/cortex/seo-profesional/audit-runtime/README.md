# Bot de SEO profesional — audit runtime

Subsistema auxiliar y **apagado por defecto** para auditoría técnica SEO first-party. No forma parte del pipeline normal de cliente ni del grafo numerado de estrategias #1–#11.

## Frontera

- La lógica de dominio vive en `packages/ontology/cortex/seo-profesional/audit-runtime`.
- La automatización real de navegador vive en `packages/capture/seo-audit-playwright-adapter.ts` y satisface el puerto estructural `SeoAuditBrowserPort`.
- No existe dependencia desde `@nexus/core`, `packages/experience`, `runtime/` ni aplicaciones cliente hacia este subsistema.
- No se ejecuta en import, build, CI ni request-time. Requiere activación explícita de una instancia y el entrypoint operativo requiere `NEXUS_SEO_AUDIT_ENABLED=1`.

## Capacidades

- Crawl first-party acotado por origen, profundidad y número de páginas.
- Evaluación obligatoria de `robots.txt`; 404 equivale a política vacía y fallos/malformed policy cierran la ejecución.
- Descubrimiento y auditoría de `sitemap.xml` / sitemap indexes con límites de tamaño y cantidad.
- Auditoría de status, title, description, canonical, robots/noindex, `lang`, headings, imágenes sin `alt`, JSON-LD y texto visible.
- Descubrimiento de enlaces internos sin seguir `nofollow`.
- Telemetría UX opcional de escritura: pausas, variabilidad, correcciones y trayectoria Bézier del puntero. Se limita al origen first-party, no envía formularios y nunca hace submit.
- Reporte estructurado con issues y resumen de indexabilidad.

## Activación

La clase `SeoProfessionalAuditRuntime` nace inactiva. `run()` falla con `NOT_ACTIVE` hasta que el operador invoque `activate()` con requester y reason. Las activaciones pueden expirar y se revalidan durante el crawl.

El entrypoint del repositorio añade una segunda compuerta: solo arranca cuando `NEXUS_SEO_AUDIT_ENABLED=1` y recibe un archivo JSON explícito.

Este runtime no modifica `packages/core`, `packages/experience`, `runtime/`, `pnpm-workspace.yaml` ni aplicaciones cliente. La simulación humana existe exclusivamente como prueba de UX/telemetría first-party y el adapter de navegador bloquea requests de mutación (`POST`, `PUT`, `PATCH`, `DELETE`, etc.).
