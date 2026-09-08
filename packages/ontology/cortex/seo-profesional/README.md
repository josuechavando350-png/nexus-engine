# SEO Profesional — Nexus Core

Esta carpeta concentra capacidades de adquisición y SEO que deben ser ejecutables, medibles y auditables. Ningún módulo puede depender de promesas de ranking, datos inventados, ubicaciones ficticias, tráfico artificial o respuestas hardcodeadas que simulen una integración externa.

## Estrategias

1. `01-detector-de-trampas` — invalid-traffic scoring + Google Ads offline conversions.
2. `02-cazador-con-lupa` — search-term evidence + exact keyword synthesis + atomic Google Ads mutation into paused single-intent ad groups.
3. `03-camaleon-web` — adopta la capacidad canónica existente `packages/core/cortex/ad-context-edge-workers`: query/ad-context driven UI en Edge, personalización allowlisted, fail-closed y render real. No duplica el motor.

Las estrategias restantes se incorporan de forma incremental. Cada una debe mantener contratos tipados, límites de seguridad, pruebas de fallo y una ruta de producción explícita antes de considerarse terminada. Cuando una capacidad canónica existente ya supera la estrategia propuesta, se conserva esa implementación y la carpeta maestra registra su ubicación sin crear una segunda versión peor o divergente.

## Regla de conectividad

SEO Profesional funciona como un sistema, no como once módulos aislados. `topology.ts` registra todas las estrategias implementadas y exige un grafo fuertemente conectado: cada estrategia debe tener entrada, salida y camino hacia todas las demás. `topology.test.ts` compara además las carpetas numeradas implementadas contra el registro; añadir una nueva carpeta `04-*`, `05-*`, etc. sin registrarla y conectarla hace fallar CI.

Para #1–#3 el circuito inicial es:

- `#1 -> #2` por `QUALIFIED_CONVERSION_FEEDBACK`: #1 filtra tráfico inválido y envía únicamente conversiones calificadas al mismo cliente de Google Ads que #2 optimiza.
- `#2 -> #3` por `PAID_SEARCH_TRAFFIC`: las keywords/grupos exactos materializados por #2 generan tráfico pagado que #3 interpreta como contexto de adquisición.
- `#3 -> #1` por `ATTRIBUTED_LANDING_FEEDBACK`: cada landing personalizado vuelve a entrar por la evaluación de tráfico de #1.

`connected-system.ts` impone el wiring operativo de las tres capacidades sin hacer que un motor importe al otro. El mismo `googleAdsCustomerId` queda fijado a nivel sistema. En landing, #1 evalúa riesgo antes de #3; por encima del umbral, se suprime el contexto de adquisición y #3 sirve la experiencia por defecto. Para conversiones diferidas se emite un recibo de atribución firmado que contiene únicamente assessment id, customer id, score, tipo de click y un HMAC del click ID: nunca devuelve el click ID crudo. La conversión posterior debe presentar el mismo click y un recibo válido antes de llegar al sink de #1.

## Regla de producción

Una integración externa solo se considera activa cuando existe un cliente real para la API/proveedor y el runtime recibe credenciales válidas fuera del repositorio. Las suites pueden usar transportes controlados para verificar contratos HTTP sin introducir secretos ni efectuar mutaciones sobre cuentas reales durante CI.
