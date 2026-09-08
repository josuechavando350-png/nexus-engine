# 01 — Detector de Trampas

Implementación de producción para **invalid-traffic scoring** y envío de **conversiones offline cualificadas**. El módulo no intenta identificar a una persona o empresa como “competidor” ni promete bloquear el fraude de Google Ads; clasifica señales técnicas observables y permite negar/desafiar solicitudes de alto riesgo mediante el `fraud-risk-gate` existente de NEXUS.

## Flujo de tráfico

1. `InvalidTrafficClickScorer` recibe URL, IP de cliente validada por la capa de confianza, método y cabeceras HTTP.
2. `CidrNetworkClassifier` clasifica la IP con reglas CIDR proporcionadas por operación (residencial, móvil, negocio, datacenter, VPN o TOR).
3. Se agregan señales acotadas de automatización, navegación no-documento, prefetch/prerender, click IDs de Google malformados o múltiples y replay del mismo click ID.
4. El resultado se limita a 0..1000 y se firma con el contrato existente de `fraud-risk-gate`, ligado a una clave de red mediante HMAC.
5. El `fraud-risk-gate` de producción puede convertir ese score en `ALLOW`, `CHALLENGE` o `DENY` sin confiar en cabeceras de cliente sin verificar.

El resultado de scoring no devuelve IP ni valor bruto de `gclid`/`gbraid`/`wbraid`. El replay key es un HMAC y no un click ID persistido en claro.

### Reglas CIDR

El motor no contiene una lista estática de centros de datos porque esas redes cambian. Producción debe alimentar `CidrNetworkClassifier` con rangos actuales provenientes de una fuente operativa autorizada. Inventar rangos o congelar una lista desactualizada degradaría el detector.

`BoundedMemoryClickReplayStore` es funcional y útil para un único proceso. En un despliegue multi-instancia/Edge debe inyectarse un `ClickReplayStore` compartido con operación atómica `seenOrRemember` para detectar replay entre nodos.

## Conversiones offline

`QualifiedOfflineConversionEngine` solo envía una conversión cuando:

- el valor supera el mínimo configurado;
- el score de tráfico inválido no supera el máximo configurado; y
- la etapa del lead está permitida.

Hay dos sinks reales:

- `GoogleAdsOfflineConversionClient`: llama al endpoint `customers/{customerId}:uploadClickConversions`, envía `partialFailure: true`, `orderId`, valor, moneda, fecha y `gclid`/`gbraid`/`wbraid`. No reintenta mutaciones con resultado ambiguo.
- `GoogleDataManagerOfflineConversionSink`: reutiliza el cliente real `GoogleDataManagerRestClient` de NEXUS para `https://datamanager.googleapis.com/v1/events:ingest`.

Google restringe `UploadClickConversions` para ciertos developer tokens que no tenían actividad previa de conversiones offline al 15 de junio de 2026. El cliente detecta `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` y devuelve `LEGACY_API_RESTRICTED`, permitiendo configurar Data Manager como ruta de producción en esas cuentas.

## Credenciales

Developer token, OAuth access/refresh credentials y secretos HMAC deben entrar mediante el gestor de secretos/runtime. Ningún secreto pertenece al repositorio, fixtures o logs.

## Qué certifican las pruebas

Las pruebas contractuales verifican scoring, CIDR IPv4/IPv6, replay, firma y binding de red, ausencia de click IDs/IPs en resultados, gating de leads, payload HTTP exacto de Google Ads, errores parciales/restricción de API y el flujo real de Data Manager con transporte controlado. CI no realiza conversiones sobre una cuenta publicitaria real.
