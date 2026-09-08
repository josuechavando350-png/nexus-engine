# 05 — El Emboscador de Nacimientos

Implementación de inteligencia de dominios recién registrados y outreach gobernado. El nombre comercial no implica vigilancia privada ni mensajería no solicitada: el módulo usa únicamente señales públicas de infraestructura/registro y exige evidencia explícita de opt-in antes de cualquier mutación de WhatsApp.

## Componentes

- `IanaRdapClient` — descubre el servidor RDAP autoritativo mediante el bootstrap DNS de IANA y consulta el dominio por HTTPS. Desde 2025 RDAP es la fuente estándar para datos de registro gTLD; no se depende de WHOIS legacy.
- `NodeDnsDomainIntelligenceClient` — consulta A, AAAA, MX y NS mediante el resolver DNS de Node. No consulta TXT ni intenta extraer correos/contactos.
- `DomainBirthIntelligenceEngine` — clasifica un dominio como recién registrado/activo, recién registrado/inactivo, establecido, no registrado o de edad desconocida. Por defecto exige activación DNS y considera reciente una ventana máxima de siete días, configurable entre una hora y noventa días.
- `WhatsAppCloudApiClient` — cliente de mutación real para `/{phone-number-id}/messages` sobre Graph API. Solo expone mensajes `template`; no existe superficie para texto libre en frío.
- `DomainBirthOutreachEngine` — une la verificación RDAP/DNS con un template aprobado de WhatsApp y un landing del origen empresarial verificado.

## Privacidad y consentimiento

RDAP puede contener entidades/vCards. Este módulo descarta deliberadamente esos contactos y conserva solo: dominio, fechas de registro/cambio/expiración, estados, nameservers, handle del registrar y estado de delegación DNSSEC. **Nunca deriva un número de WhatsApp desde RDAP, WHOIS, DNS o scraping.**

El número destinatario debe provenir de una fuente autorizada (`FIRST_PARTY_CRM`, `USER_REQUEST` o `PARTNER_OPT_IN`) y además debe presentar `WhatsAppConsentEvidence` con:

- `status: OPTED_IN`;
- `purpose: DOMAIN_BIRTH_OUTREACH`, para impedir reutilizar un opt-in genérico para este flujo;
- el mismo número E.164 del destinatario;
- timestamp UTC de captura;
- fuente de consentimiento;
- `proofId` trazable;
- ausencia de revocación.

Sin esa evidencia el cliente falla antes de obtener el token o hacer red.

## Límites de red y mutaciones

- IANA/RDAP y respuestas exitosas de WhatsApp se consumen mediante streaming con límite duro de bytes; un body chunked no puede saltarse el tope por omitir `Content-Length`.
- Lecturas IANA/RDAP pueden reintentarse de forma acotada y descartan el body antes del retry.
- Un POST de WhatsApp nunca se reintenta automáticamente después de timeout, error de transporte o 5xx: el resultado se considera `AMBIGUOUS_OUTCOME` para evitar duplicados. Los 5xx se clasifican antes de parsear el body, porque un body defectuoso no elimina la ambigüedad de la mutación.
- Fallos del proveedor de access token se normalizan a `AUTHENTICATION_FAILED` antes de cualquier request a Meta.
- `PLAN_ONLY` valida clasificación, consentimiento, template y landing sin enviar mensaje.
- `APPLY` realiza exactamente una mutación de template.

## Integración maestra

`master-topology.ts` extiende el core #1–#4 sin modificarlo:

- `#4 -> #5` / `VERIFIED_SENDER_IDENTITY`: el origen usado por #5 debe coincidir exactamente con el origen LocalBusiness canónico de #4.
- `#5 -> #1` / `CONSENTED_DOMAIN_BIRTH_OUTREACH`: el template lleva al landing canónico; ese tráfico vuelve a entrar por el filtro de #1 y continúa por #3/#4.

`SeoProfessionalMasterSystem` es el orquestador acumulativo que expone el core existente y #5 desde un solo runtime. Las siguientes estrategias (#6–#11) se conectarán a este master, no reescribiendo los motores certificados anteriores.

## Límites explícitos

No hay descubrimiento de datos privados, bypass de RDAP/RDRS, extracción de teléfonos, compra/venta de datos, mensajes masivos sin consentimiento, garantía de respuesta, ni afirmación de que un dominio recién registrado representa automáticamente una oportunidad comercial. La entrada de dominios candidatos debe provenir de una fuente legítima/autorizada y RDAP/DNS solo verifica sus señales técnicas.
