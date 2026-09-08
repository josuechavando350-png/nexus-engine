# SEO Profesional — Nexus Core

Esta carpeta concentra capacidades de adquisición y SEO ejecutables, medibles y auditables. Ningún módulo puede depender de promesas de ranking, datos inventados, ubicaciones ficticias, tráfico artificial, mensajería no consentida, acceso no autorizado o respuestas hardcodeadas que simulen una integración externa.

## Estrategias

1. `01-detector-de-trampas` — invalid-traffic scoring + Google Ads offline conversions.
2. `02-cazador-con-lupa` — search-term evidence + exact keyword synthesis + atomic Google Ads mutation into paused single-intent ad groups.
3. `03-camaleon-web` — adopta la capacidad canónica existente `packages/core/cortex/ad-context-edge-workers`: query/ad-context driven UI en Edge, personalización allowlisted, fail-closed y render real. No duplica el motor.
4. `04-iman-del-mapa` — perfil LocalBusiness validado + JSON-LD seguro + auditoría/sincronización gobernada de una ubicación existente de Google Business Profile.
5. `05-emboscador-de-nacimientos` — verificación de dominios recientes mediante IANA/RDAP + DNS y outreach por WhatsApp Cloud API exclusivamente con template y evidencia de opt-in.
6. `06-infiltrador-corporativo` — inteligencia de RFQ/RFP/licitaciones exclusivamente sobre fuentes públicas: OCDS primero, HTML público como fallback Playwright, robots/anti-SSRF, cola durable multi-tenant y handoff first-party.

Las estrategias restantes se incorporan de forma incremental. Cada una debe mantener contratos tipados, límites de seguridad, pruebas de fallo y una ruta de producción explícita antes de considerarse terminada. Cuando una capacidad canónica existente ya supera la estrategia propuesta, se conserva esa implementación y la carpeta maestra registra su ubicación sin crear una segunda versión peor o divergente.

## Regla de conectividad

SEO Profesional funciona como un sistema, no como once módulos aislados. El runtime certificado #1–#4 conserva su grafo en `topology.ts`. Desde #5, `master-topology.ts` es el registro acumulativo: contiene todas las estrategias implementadas y exige un grafo fuertemente conectado. `topology.test.ts` compara las carpetas numeradas implementadas contra el registro maestro; añadir una nueva carpeta `07-*`, `08-*`, etc. sin registrarla y conectarla hace fallar CI.

El core #1–#4 permanece exactamente conectado así:

- `#4 -> #1` por `VERIFIED_LOCAL_ENTITY_CONTEXT`: el origen canónico del negocio definido por la presencia local limita qué host puede entrar al circuito de adquisición.
- `#1 -> #2` por `QUALIFIED_CONVERSION_FEEDBACK`: #1 filtra tráfico inválido y envía únicamente conversiones calificadas al mismo cliente de Google Ads que #2 optimiza.
- `#2 -> #3` por `PAID_SEARCH_TRAFFIC`: las keywords/grupos exactos materializados por #2 generan tráfico pagado que #3 interpreta como contexto de adquisición.
- `#3 -> #4` por `LOCAL_STRUCTURED_PRESENCE`: cada landing devuelve la experiencia de #3 junto con el snapshot LocalBusiness/JSON-LD de #4, sin llamada a GBP en request-time.
- `#3 -> #1` por `ATTRIBUTED_LANDING_FEEDBACK` se conserva como feedback directo.

#5 extiende ese circuito sin reescribirlo:

- `#4 -> #5` por `VERIFIED_SENDER_IDENTITY`: el origen del sender/landing de WhatsApp debe ser exactamente el origen LocalBusiness canónico de #4.
- `#5 -> #1` por `CONSENTED_DOMAIN_BIRTH_OUTREACH`: un contacto que ya otorgó opt-in puede recibir un template aprobado que dirige al landing canónico; cualquier visita resultante vuelve a entrar por #1.

#6 amplía el mismo master sin tocar los motores anteriores:

- `#4 -> #6` por `VERIFIED_SELLER_IDENTITY`: la identidad del vendedor usada por la inteligencia de compras públicas debe coincidir con el origen canónico de #4.
- `#6 -> #1` por `QUALIFIED_PROCUREMENT_HANDOFF`: una oportunidad pública calificada solo produce un enlace first-party opaco; cualquier visita vuelve a entrar por el circuito web de #1.

`connected-system.ts` sigue siendo el core operativo #1–#4. `master-system.ts` lo compone por puertos estructurales con #5 y #6 y continuará como punto acumulativo para #7–#11. Ningún motor necesita importar la implementación interna de otro.

## Fronteras externas

La sincronización con Google Business Profile no ocurre dentro del request de landing. #4 usa `readMask`/`updateMask`, bloquea escrituras ante updates pendientes y revalida el estado después de `APPLY`.

La inteligencia de dominios #5 usa el bootstrap RDAP de IANA para localizar el servidor autoritativo, conserva únicamente metadatos técnicos/registrales no-contacto y consulta A/AAAA/MX/NS. Nunca extrae destinatarios desde RDAP/WHOIS. WhatsApp exige template, número E.164 y evidencia de opt-in ligada al mismo número; las mutaciones ambiguas no se reintentan a ciegas.

La inteligencia corporativa #6 no entra a portales privados. Prefiere OCDS/JSON; para HTML público usa un adapter Playwright aislado por contexto y gobernado por robots + política de URL pública. No expone login, CAPTCHA bypass, evasión anti-bot, proxy rotation, submit de ofertas ni contacto automático a compradores.

## Regla de producción

Una integración externa solo se considera activa cuando existe un cliente/adapter real y el runtime recibe configuración/credenciales válidas fuera del repositorio. Las suites pueden usar transportes controlados para verificar contratos sin introducir secretos ni efectuar mutaciones sobre cuentas reales durante CI.
