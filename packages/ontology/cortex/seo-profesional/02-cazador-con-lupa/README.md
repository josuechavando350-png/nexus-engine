# 02 — El Cazador con Lupa

Implementación real del **Exact Match Synthesizer** para campañas de búsqueda de Google Ads.

## Qué hace

1. Lee `search_term_view` mediante Google Ads API y conserva el término de búsqueda literal observado, junto con impresiones, clics, conversiones, valor y costo.
2. Normaliza únicamente Unicode, mayúsculas/minúsculas y espacios para deduplicar. No genera sinónimos ni inventa consultas.
3. Agrega el mismo término por campaña cuando apareció en varios grupos de anuncios y selecciona como origen el grupo con mejor señal de conversiones/clics.
4. Aplica una política explícita de evidencia: mínimo de clics, conversiones, tasa de conversión, CPA máximo, valor/costo mínimo y tope de candidatos por ejecución.
5. Verifica el inventario remoto de keywords `EXACT` antes de mutar para no duplicar una keyword exacta ya existente en la campaña.
6. Usa `GoogleAdsService.Mutate` con nombres temporales para crear de forma **atómica**:
   - un grupo de anuncios `SEARCH_STANDARD` nuevo;
   - una keyword positiva con `matchType: EXACT` que contiene exactamente el término observado.
7. El nuevo grupo queda **PAUSED**. La estrategia no activa un grupo incompleto sin creatividad. La keyword sí se crea realmente; el grupo debe recibir anuncios/activos aprobados antes de habilitarlo.
8. Obliga al llamador a elegir `VALIDATE_ONLY` o `APPLY`; no existe un modo implícito que pueda mutar una cuenta por accidente.

## Integración Google Ads

- Hereda `GOOGLE_ADS_API_VERSION` y el contrato OAuth existentes de `bidding-supervisor/google-ads-rest.ts`.
- En la versión actual del repositorio la integración apunta a Google Ads API `v25`.
- Lecturas: `POST /v25/customers/{customerId}/googleAds:search`.
- Mutación heterogénea/atómica: `POST /v25/customers/{customerId}/googleAds:mutate`.
- Las lecturas soportan `nextPageToken` y tienen límites de páginas, filas y tamaño de respuesta.
- Las mutaciones no se reintentan a ciegas. Un timeout, fallo de transporte o `5xx` después de enviar la mutación se reporta como resultado ambiguo para evitar duplicar cambios cuyo estado remoto no se conoce.
- `partialFailure` se envía como `false`: el lote completo se aplica o falla.

## Exact Match no significa coincidencia byte por byte

La keyword que Nexus crea usa `matchType: EXACT`, pero la semántica de Google Ads para Exact Match puede incluir variantes cercanas según las reglas vigentes de la plataforma. Nexus no promete que Google solo servirá ante una cadena idéntica carácter por carácter.

## Alcance de Search

`search_term_view` es el origen correcto para datos de términos a nivel de grupo de anuncios en campañas de búsqueda y no incluye Performance Max. Este módulo no convierte datos de Performance Max en keywords de Search de forma automática.

## Límites y protecciones

- Máximo 100,000 observaciones procesadas por síntesis.
- Máximo 100 candidatos seleccionados por política.
- Máximo 50 candidatos por mutación atómica (100 operaciones: grupo + keyword).
- Keywords: máximo 80 caracteres y 10 palabras antes de llegar a la API.
- IDs y fechas validados antes de formar GAQL.
- No se interpola texto de usuario libre dentro de filtros GAQL; los únicos valores interpolados son fechas canónicas e IDs numéricos validados.
- Respuestas HTTP acotadas a 32 MiB.
- Sin secretos, customer IDs ni campañas reales embebidos en el repositorio.

## Ruta de producción

```ts
const engine = new ExactMatchSynthesizerEngine(googleAdsExactMatchClient);
const result = await engine.run({
  customerId,
  campaignIds: [campaignId],
  policy: {
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    minimumClicks: 20,
    minimumConversions: 3,
    minimumConversionRate: 0.1,
    maximumCostPerConversionMicros: 5_000_000,
    minimumConversionValuePerCost: 2,
    maximumCandidates: 10,
  },
  materialization: { executionMode: "VALIDATE_ONLY" },
});
```

Después de revisar el plan, el operador puede ejecutar el mismo flujo con `executionMode: "APPLY"`. No se necesita cambiar código ni sustituir un stub: ambos modos llegan al contrato real de Google Ads; `VALIDATE_ONLY` pide a Google validar la mutación sin aplicarla.
