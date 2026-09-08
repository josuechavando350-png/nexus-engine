# 04 — El Imán del Mapa

Estado: **IMPLEMENTACIÓN REAL AISLADA + INTEGRACIÓN CON EL SISTEMA SEO PROFESIONAL**.

## Objetivo

Mantener una identidad local coherente entre el sitio y una ficha existente de Google Business Profile (GBP), y producir JSON-LD `LocalBusiness`/subtipo desde datos empresariales validados. No promete ranking, no crea ubicaciones ficticias y no fabrica reseñas, ratings, direcciones ni señales de proximidad.

## Implementación

- `local-business.ts` valida el perfil local y genera JSON-LD seguro para `application/ld+json`.
- `google-business-profile.ts` implementa un cliente REST real para My Business Business Information API v1.
- `local-presence.ts` compara la fuente local contra GBP y ejecuta sync gobernado.

## Google Business Profile

El cliente trabaja exclusivamente sobre un resource name existente `locations/{locationId}`. Esta estrategia **no expone create/delete** de ubicaciones.

Operaciones implementadas:

- `GET /v1/locations/{locationId}?readMask=...`
- `GET /v1/locations/{locationId}:googleUpdated?readMask=...`
- `PATCH /v1/locations/{locationId}?updateMask=...&validateOnly=true|false`

Campos de sincronización intencionalmente acotados:

- `title`
- `websiteUri`
- `phoneNumbers.primaryPhone`
- `storefrontAddress`

Los campos omitidos del perfil local no se borran de GBP. `VALIDATE_ONLY` permite verificar el contrato de mutación sin aplicar cambios. `APPLY` no se reintenta automáticamente ante resultados ambiguos y hace un GET posterior para demostrar que la ficha terminó en el estado esperado.

Si GBP informa `metadata.hasGoogleUpdated=true`, NEXUS bloquea la escritura automática. El operador debe revisar el `googleUpdated`/`diffMask` antes de decidir qué fuente es correcta; el motor no acepta ni rechaza cambios de Google por su cuenta.

## JSON-LD

El perfil local soporta `LocalBusiness` y un conjunto explícito de subtipos comunes. Requiere una dirección real o un área de servicio real. El serializador escapa caracteres que podrían cerrar un `<script>`.

Por diseño, el contrato no contiene `aggregateRating` ni `review`; por lo tanto esta estrategia no puede inventarlos accidentalmente. Si en el futuro se incorporan señales de reseñas, deberán provenir de una fuente autorizada y verificable en otro contrato explícito.

## Conectividad con #1–#3

#4 no se importa dentro de #1, #2 o #3. `ConnectedSeoProfessionalSystem` consume un puerto mínimo de presencia local:

- `#4 -> #1`: el origen canónico del negocio limita qué host puede entrar al circuito de adquisición. Un landing de otro origen falla antes del scoring.
- `#1 -> #2`: se conserva el feedback de conversiones calificadas.
- `#2 -> #3`: se conserva el tráfico paid-search materializado.
- `#3 -> #4`: cada evaluación de landing devuelve también el snapshot local/JSON-LD de #4, sin llamada de red a GBP en request-time.

La sincronización GBP se ejecuta fuera de la ruta de request. Así la presencia local queda conectada al sistema sin meter latencia externa en cada visita ni acoplar los motores.

## Seguridad y límites

- OAuth solo entra por `accessTokenProvider`; no hay secretos en repositorio.
- Lecturas tienen tamaño máximo y retries acotados.
- Mutaciones no tienen retry ciego; timeout/5xx puede producir `AMBIGUOUS_OUTCOME`.
- No se crean ubicaciones, no se cambian categorías automáticamente y no se publican coordenadas inventadas.
- No se garantiza aparición, posición ni ranking en Google Maps/Search.

La API de Business Information requiere que el proyecto y la cuenta del cliente tengan acceso autorizado a Business Profile APIs. CI verifica el contrato HTTP con transportes controlados y nunca toca una ficha real.
