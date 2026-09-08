# SEO Profesional — Nexus Core

Esta carpeta concentra capacidades de adquisición y SEO que deben ser ejecutables, medibles y auditables. Ningún módulo puede depender de promesas de ranking, datos inventados, ubicaciones ficticias, tráfico artificial o respuestas hardcodeadas que simulen una integración externa.

## Estrategias

1. `01-detector-de-trampas` — invalid-traffic scoring + Google Ads offline conversions.
2. `02-cazador-con-lupa` — search-term evidence + exact keyword synthesis + atomic Google Ads mutation into paused single-intent ad groups.

Las estrategias restantes se incorporan de forma incremental. Cada una debe mantener contratos tipados, límites de seguridad, pruebas de fallo y una ruta de producción explícita antes de considerarse terminada.

## Regla de producción

Una integración externa solo se considera activa cuando existe un cliente real para la API/proveedor y el runtime recibe credenciales válidas fuera del repositorio. Las suites pueden usar transportes controlados para verificar contratos HTTP sin introducir secretos ni efectuar mutaciones sobre cuentas reales durante CI.
