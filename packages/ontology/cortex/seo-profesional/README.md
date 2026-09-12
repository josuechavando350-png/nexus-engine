# SEO Profesional — Nexus Core

Esta carpeta concentra capacidades de adquisición y SEO ejecutables, medibles y auditables. Ningún módulo puede depender de promesas de ranking, datos inventados, ubicaciones ficticias, tráfico artificial, mensajería no consentida, acceso no autorizado o respuestas hardcodeadas que simulen una integración externa.

## Estrategias

1. `01-detector-de-trampas` — invalid-traffic scoring + Google Ads offline conversions.
2. `02-cazador-con-lupa` — search-term evidence + exact keyword synthesis + atomic Google Ads mutation into paused single-intent ad groups.
3. `03-camaleon-web` — adopta la capacidad canónica existente `packages/core/cortex/ad-context-edge-workers`: query/ad-context driven UI en Edge, personalización allowlisted, fail-closed y render real. No duplica el motor.
4. `04-iman-del-mapa` — perfil LocalBusiness validado + JSON-LD seguro + auditoría/sincronización gobernada de una ubicación existente de Google Business Profile.
5. `05-emboscador-de-nacimientos` — verificación de dominios recientes mediante IANA/RDAP + DNS y outreach por WhatsApp Cloud API exclusivamente con template y evidencia de opt-in.
6. `06-infiltrador-corporativo` — inteligencia de RFQ/RFP/licitaciones exclusivamente sobre fuentes públicas: OCDS primero, HTML público como fallback Playwright, robots/anti-SSRF, cola durable multi-tenant y handoff first-party.
7. `07-recomendacion-de-dios` — adopta el Unified Semantic Graph canónico de Nexus y su proyección Schema.org; añade selección page-specific, evidencia DOM visible, política Google Rich Results y recibos hash que atan grafo + página + JSON-LD.
8. `08-resucitador-de-muertos` — enriquecimiento pasivo de tecnología/SEO sobre homepages públicas de relaciones ya autorizadas, cola distribuida Redis con leases y handoff first-party para revisión; nunca escanea vulnerabilidades ni ejecuta outreach automático.
9. `09-parasito-inteligente` — adopta el CORTEX Headless Programmatic SEO canónico y le añade autorización de propiedad: first-party en el origen canónico o delegación DNS TXT HMAC de corta duración, fuentes editoriales gobernadas y recibo que liga autorización + run pSEO.
10. `10-candado-invisible` — resiliencia Edge portable para el origen first-party: timeout acotado, circuit breaker, bulkhead por isolate, cache policy privada/pública y headers diferenciados Cloudflare/Vercel con stale delivery gobernado; no promete inmunidad ni cero downtime.
11. `11-guardian-latencia-cero` — supervisor portable de handlers request-time dentro de #10: deadlines cooperativos con `AbortSignal`, circuit breaker por operación, fallback acotado, bulkhead por isolate y fail-open del backend de estado; no promete latencia literal cero ni forced GC.
12. `12-incrementalidad-geo-holdout` — adopta el CORTEX #12 canónico de experimentación geo-holdout y añade scope SEO por origen + Google Ads customer, persistencia/control durable y un gate causal que solo habilita la optimización #2 cuando el intervalo 95% del lift incremental es positivo.

Las estrategias se incorporan de forma incremental. Cada una debe mantener contratos tipados, límites de seguridad, pruebas de fallo y una ruta de producción explícita antes de considerarse terminada. Cuando una capacidad canónica existente ya supera la estrategia propuesta, se conserva esa implementación y la carpeta maestra registra su ubicación sin crear una segunda versión peor o divergente.

## Regla de conectividad

SEO Profesional funciona como un sistema, no como doce módulos aislados. El runtime certificado #1–#4 conserva su grafo en `topology.ts`. Desde #5, `master-topology.ts` es el registro acumulativo: contiene todas las estrategias implementadas y exige un grafo fuertemente conectado. `topology.test.ts` compara las carpetas numeradas implementadas contra el registro maestro; añadir una nueva carpeta numerada sin registrarla y conectarla hace fallar CI.

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

#7 se conecta sin duplicar el Knowledge Graph:

- `#4 -> #7` por `VERIFIED_PUBLISHER_IDENTITY`: la URL que publica Schema.org debe pertenecer exactamente al origen LocalBusiness canónico de #4.
- `#7 -> #1` por `GROUNDED_STRUCTURED_LANDING`: el JSON-LD queda ligado por hash a la misma página first-party; esa página continúa sometida a los gates del circuito web existente.

#8 añade enriquecimiento distribuido sin tocar los motores anteriores:

- `#4 -> #8` por `VERIFIED_REVIVAL_OPERATOR_IDENTITY`: el origen del operador y del handoff de reactivación debe coincidir exactamente con el LocalBusiness canónico de #4.
- `#8 -> #1` por `QUALIFIED_REVIVAL_HANDOFF`: un assessment únicamente produce revisión first-party; cualquier navegación posterior vuelve a entrar por #1 y #8 no puede saltarse los gates de adquisición.

#9 reutiliza el motor pSEO ya certificado y solo añade una frontera de autorización:

- `#4 -> #9` por `VERIFIED_PSEO_OPERATOR_IDENTITY`: la identidad del operador que autoriza propiedades debe coincidir con el origen LocalBusiness canónico de #4.
- `#9 -> #1` por `AUTHORIZED_PROGRAMMATIC_LANDING`: una página programática solo puede publicarse dentro de la propiedad configurada y autorizada; cualquier visita posterior sigue entrando por #1.

#10 añade resiliencia de entrega sin reescribir #3 ni crear un framework Edge paralelo:

- `#4 -> #10` por `VERIFIED_EDGE_OPERATOR_IDENTITY`: el runtime Edge solo puede proteger el mismo origen HTTPS canónico definido por #4.

#11 convierte la salida de #10 en una cadena de ejecución protegida, en lugar de un módulo paralelo:

- `#10 -> #11` por `RESILIENT_EDGE_RUNTIME_HANDOFF`: #10 conserva la frontera exterior de timeout/cache/proveedor y entrega su mismo `Request` + `AbortSignal` al guard de handlers #11.
- `#11 -> #1` por `GUARDED_WEB_LANDING`: la respuesta primaria o fallback de #11 vuelve a través de #10 y continúa siendo la misma superficie first-party que entra al circuito de adquisición #1.

#12 reutiliza el framework estadístico durable de CORTEX y lo convierte en un gate operativo de adquisición:

- `#4 -> #12` por `VERIFIED_EXPERIMENT_OPERATOR_IDENTITY`: el experimento debe pertenecer exactamente al mismo origen canónico de #4 y al mismo `googleAdsCustomerId` compartido por #1/#2.
- `#12 -> #2` por `INCREMENTALITY_GATED_OPTIMIZATION`: únicamente un análisis durable con verdict `POSITIVE` se traduce a `ALLOW_OPTIMIZATION`; `INCONCLUSIVE` queda en `HOLD` y `NEGATIVE` en `BLOCK_REGRESSION`, sin llamar al mutador #2.

`connected-system.ts` sigue siendo el core operativo #1–#4. `master-system.ts` lo compone por puertos estructurales con #5, #6, #7, #8, #9, #10, #11 y #12. `serveGuardedEdgeRequest()` materializa la ruta real `#10 -> #11`; `optimizeExactMatchesWithIncrementality()` materializa `#12 -> #2` y no delega a Google Ads si la evidencia no es positiva. Ningún motor necesita importar la implementación interna de otro salvo las reutilizaciones deliberadas de capacidades canónicas.

## Fronteras externas

La sincronización con Google Business Profile no ocurre dentro del request de landing. #4 usa `readMask`/`updateMask`, bloquea escrituras ante updates pendientes y revalida el estado después de `APPLY`.

La inteligencia de dominios #5 usa el bootstrap RDAP de IANA para localizar el servidor autoritativo, conserva únicamente metadatos técnicos/registrales no-contacto y consulta A/AAAA/MX/NS. Nunca extrae destinatarios desde RDAP/WHOIS. WhatsApp exige template, número E.164 y evidencia de opt-in ligada al mismo número; las mutaciones ambiguas no se reintentan a ciegas.

La inteligencia corporativa #6 no entra a portales privados. Prefiere OCDS/JSON; para HTML público usa un adapter Playwright aislado por contexto y gobernado por robots + política de URL pública. No expone login, CAPTCHA bypass, evasión anti-bot, proxy rotation, submit de ofertas ni contacto automático a compradores.

#7 conserva `packages/ontology/semantic-graph.ts` como autoridad semántica. Solo proyecta nodos verificados con `verifyUnifiedSemanticGraph` + `projectSchemaOrg`, exige evidencia Playwright del contenido visible y genera un recibo SHA-256 que ata graph digest, node digests, page evidence, reglas y JSON-LD. La salida se marca `READY_FOR_RICH_RESULTS_TEST`, nunca como “garantizada por Google”.

#8 inspecciona exclusivamente la homepage HTTPS pública de un candidato ya existente en CRM/portfolio. Resuelve DNS, bloquea redes no públicas y pinnea el socket HTTPS al IP autorizado para impedir DNS rebinding. No ejecuta JavaScript ni subrecursos y no prueba puertos, versiones vulnerables, CVEs, admin paths o credenciales. La tecnología detectada no suma score; el assessment se basa en dormancia conocida y señales públicas neutrales. Las tareas se coordinan mediante Redis RESP2 + Lua atómico, `rediss://` en producción y sin retry automático de comandos ambiguos.

#9 no genera páginas por su cuenta. Reutiliza `packages/ontology/cortex/headless-programmatic-seo`, que ya aplica evidencia page-specific, distinctive statements, anti-doorway/near-duplicate gates, self-canonical indexable pages, publicación CAS y rollback. El origen canónico de #4 se considera first-party. Una propiedad distinta requiere un token HMAC-SHA256 publicado como TXT `_nexus-pseo.<host>`, ligado a `siteId`, propiedad, operador y expiración máxima de 30 días. El catálogo además debe provenir de un source ID gobernado como contenido first-party del operador o del propietario de la propiedad. No existe categoría para contenido patrocinado de terceros destinado a explotar reputación de host.

#10 usa únicamente APIs Web (`Request`, `Response`, `AbortController`) y un puerto de estado atómico. El store en memoria incluido no se presenta como coordinación global; en producción se inyecta un backend compartido apropiado. Requests con Authorization, Cookie, sesión o personalización Nexus y responses con `Set-Cookie` nunca pasan a shared cache. Cloudflare recibe `Cloudflare-CDN-Cache-Control` sin `s-maxage` para preservar sus semantics actuales de stale; Vercel recibe `CDN-Cache-Control`. Un cache miss real no puede beneficiarse de `stale-if-error`, por lo que #10 limita daño pero no promete disponibilidad absoluta.

#11 reutiliza el `EdgeCircuitStatePort` de #10 para aislar operaciones lógicas fallidas. No bufferiza cuerpos, libera siempre su reserva de concurrencia en `finally`, limita la espera del backend de estado y propaga el `AbortSignal` exterior. JavaScript no ofrece un API portable para forzar garbage collection ni terminar de forma segura una Promise arbitraria que ignore cancelación; por eso #11 previene amplificación de presión y aplica fallbacks, mientras los límites duros de CPU/memoria siguen siendo responsabilidad del proveedor. Cloudflare documenta actualmente 128 MB por isolate. Vercel deprecó Edge Functions para proyectos nuevos; la integración portable se consume desde la frontera Vercel apropiada (Routing Middleware o Functions/Fluid según el workload) sin atarse a un SDK Edge obsoleto.

#12 no duplica estadística ni guarda identificadores de usuario. Reutiliza `packages/ontology/cortex/geo-holdout`, incluyendo diseño estratificado determinista, digest del diseño, verificación del baseline preregistrado, tamaños mínimos por brazo, difference-in-differences con incertidumbre Welch, registro SQLite durable e `ACTIVE / OBSERVE_ONLY / KILLED`. El wrapper SEO deriva un `scopeDigest` SHA-256 de origen + customer y usa un `experimentId` namespaced para evitar cruces entre cuentas. Trabaja con IDs de geo y outcomes agregados. Un intervalo 95% inconcluso nunca se presenta como lift positivo ni habilita #2; un resultado negativo bloquea la optimización. La validez causal sigue limitada al diseño, los datos y los supuestos del experimento y no implica ranking, tráfico o ingresos futuros.

## Regla de producción

Una integración externa solo se considera activa cuando existe un cliente/adapter real y el runtime recibe configuración/credenciales válidas fuera del repositorio. Las suites pueden usar transportes controlados para verificar contratos sin introducir secretos ni efectuar mutaciones sobre cuentas reales durante CI.
