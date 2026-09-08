# SEO Profesional — Nexus Core

Esta carpeta concentra capacidades de adquisición y SEO que deben ser ejecutables, medibles y auditables. Ningún módulo puede depender de promesas de ranking, datos inventados, ubicaciones ficticias, tráfico artificial o respuestas hardcodeadas que simulen una integración externa.

## Estrategias

1. `01-detector-de-trampas` — invalid-traffic scoring + Google Ads offline conversions.
2. `02-cazador-con-lupa` — search-term evidence + exact keyword synthesis + atomic Google Ads mutation into paused single-intent ad groups.
3. `03-camaleon-web` — adopta la capacidad canónica existente `packages/core/cortex/ad-context-edge-workers`: query/ad-context driven UI en Edge, personalización allowlisted, fail-closed y render real. No duplica el motor.
4. `04-iman-del-mapa` — perfil LocalBusiness validado + JSON-LD seguro + auditoría/sincronización gobernada de una ubicación existente de Google Business Profile.

Las estrategias restantes se incorporan de forma incremental. Cada una debe mantener contratos tipados, límites de seguridad, pruebas de fallo y una ruta de producción explícita antes de considerarse terminada. Cuando una capacidad canónica existente ya supera la estrategia propuesta, se conserva esa implementación y la carpeta maestra registra su ubicación sin crear una segunda versión peor o divergente.

## Regla de conectividad

SEO Profesional funciona como un sistema, no como once módulos aislados. `topology.ts` registra todas las estrategias implementadas y exige un grafo fuertemente conectado: cada estrategia debe tener entrada, salida y camino hacia todas las demás. `topology.test.ts` compara además las carpetas numeradas implementadas contra el registro; añadir una nueva carpeta `05-*`, `06-*`, etc. sin registrarla y conectarla hace fallar CI.

Para #1–#4 el circuito es:

- `#4 -> #1` por `VERIFIED_LOCAL_ENTITY_CONTEXT`: el origen canónico del negocio definido por la presencia local limita qué host puede entrar al circuito de adquisición.
- `#1 -> #2` por `QUALIFIED_CONVERSION_FEEDBACK`: #1 filtra tráfico inválido y envía únicamente conversiones calificadas al mismo cliente de Google Ads que #2 optimiza.
- `#2 -> #3` por `PAID_SEARCH_TRAFFIC`: las keywords/grupos exactos materializados por #2 generan tráfico pagado que #3 interpreta como contexto de adquisición.
- `#3 -> #4` por `LOCAL_STRUCTURED_PRESENCE`: cada landing devuelve la experiencia de #3 junto con el snapshot LocalBusiness/JSON-LD de #4, sin llamada a GBP en request-time.
- `#3 -> #1` por `ATTRIBUTED_LANDING_FEEDBACK` se conserva como feedback directo del circuito previo.

`connected-system.ts` impone el wiring operativo sin hacer que los motores importen sus implementaciones entre sí. El mismo `googleAdsCustomerId` queda fijado a nivel sistema. En landing, #4 fija el origen permitido, #1 evalúa riesgo, #3 resuelve la experiencia y #4 aporta el snapshot estructurado. Por encima del umbral de riesgo, se suprime el contexto de adquisición y #3 sirve la experiencia por defecto.

Para conversiones diferidas se emite un recibo de atribución firmado que contiene únicamente assessment id, customer id, score, tipo de click y un HMAC del click ID: nunca devuelve el click ID crudo. La conversión posterior debe presentar el mismo click y un recibo válido antes de llegar al sink de #1.

La sincronización con Google Business Profile no ocurre dentro del request de landing. #4 lee y actualiza una ubicación existente fuera de esa ruta, usa `readMask`/`updateMask`, bloquea escrituras si Google reporta updates pendientes y revalida el estado después de `APPLY`.

## Regla de producción

Una integración externa solo se considera activa cuando existe un cliente real para la API/proveedor y el runtime recibe credenciales válidas fuera del repositorio. Las suites pueden usar transportes controlados para verificar contratos HTTP sin introducir secretos ni efectuar mutaciones sobre cuentas reales durante CI.
