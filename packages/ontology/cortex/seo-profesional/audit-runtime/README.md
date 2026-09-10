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
- Failover de conectividad del navegador: siempre intenta salida directa primero y solo avanza por `config.network_proxies` cuando la navegación falla por pérdida de conectividad/transporte. Un HTTP 401, 403, 429 o 5xx es una respuesta válida y **no** dispara failover.
- Auditoría pasiva del transporte TLS: registra protocolo TLS, emisor/sujeto del certificado y dirección del servidor cuando Playwright los expone. Si el WAF first-party publica `x-nexus-waf-ja3` / `x-nexus-waf-ja4`, esos valores se incorporan como evidencia del servidor.
- Reporte estructurado con issues, resumen de indexabilidad y evidencia de transporte.

## Activación

La clase `SeoProfessionalAuditRuntime` nace inactiva. `run()` falla con `NOT_ACTIVE` hasta que el operador invoque `activate()` con requester y reason. Las activaciones pueden expirar y se revalidan durante el crawl.

El entrypoint del repositorio añade una segunda compuerta: solo arranca cuando `NEXUS_SEO_AUDIT_ENABLED=1` y recibe un archivo JSON explícito.

`config.network_proxies` acepta hasta cuatro endpoints ordenados `http://`, `https://` o `socks5://`. Son rutas de respaldo de conectividad, no una estrategia round-robin: cada navegación comienza por la ruta directa y solo conmuta ante errores de red/timeout. Los endpoints no pueden contener path, query ni fragment; las credenciales HTTP(S) se pasan a Playwright pero nunca se serializan en el reporte.

## Auditoría de firmas de red

El adapter **observa** la identidad de transporte utilizada por el navegador real; no modifica ClientHello ni selecciona huellas JA3/JA4 arbitrarias. Para validar reglas del WAF, la infraestructura first-party puede adjuntar las cabeceras diagnósticas `x-nexus-waf-ja3` y `x-nexus-waf-ja4` a la respuesta del entorno de auditoría. El runtime conserva esos valores junto con el protocolo TLS y la dirección de servidor observados, con `fingerprintMutation: false` explícito en el recibo.

Este diseño permite comprobar que el perímetro clasifica y alerta correctamente sin introducir un motor de suplantación de huella dentro del crawler.

## Ejecución

```bash
pnpm --filter @nexus/ontology build
pnpm --filter @nexus/capture build

NEXUS_SEO_AUDIT_ENABLED=1 \
node scripts/cortex-seo-professional-audit.mjs \
  --config specs/seo-professional-audit.example.json \
  --out seo-audit.json
```

Este runtime no modifica `packages/core`, `packages/experience`, `runtime/`, `pnpm-workspace.yaml` ni aplicaciones cliente. La simulación humana existe exclusivamente como prueba de UX/telemetría first-party y el adapter de navegador bloquea requests de mutación (`POST`, `PUT`, `PATCH`, `DELETE`, etc.).
