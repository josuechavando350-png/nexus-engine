# NEXUS — MASTER STATE

Última actualización: 2026-08-22

## Estado operativo

NEXUS mantiene una sola línea activa de ingeniería. V2–V10 quedan como historia de evolución, no como una cadena de architecture-gates que defina la calidad actual.

Protecciones activas del motor:
- frontera técnica V3 del runtime;
- tests normales de invariantes extraídos de V4–V6 y V8–V10;
- asset guard fail-closed para referencias declaradas;
- inputs herméticos y build determinista;
- Quality Passport y evidencia real de navegador;
- H07 clean-room operability proof;
- supply-chain/SBOM y workspace Rust bloqueado;
- adversarial matrix, field RUM, decision trace, fleet anomaly y Shadow Mode recuperados del trabajo de #80/#81;
- `nexus modify` medido y reversible;
- CMS-lite y scaffold de clientes con pruebas.

## Regla de evidencia

Nada se considera implementado o listo por flags, documentación o nombres de versión. La evidencia debe provenir de ejecución real sobre el SHA candidato. Missing/NOT_TESTED no equivale a PASS.

## Firma del Quality Passport

La firma de producción está pendiente de una decisión explícita entre Sigstore/cosign keyless y KMS/HSM no exportable. La comparación y recomendación vigentes viven en `docs/SIGNING_DECISION.md`. No existe un signer de producción autorizado hasta esa decisión.

## Clientes

Los siguientes clientes reales deben entrar en `apps/` desde el inicio de su entrega, para que scaffold, assets, build, browser evidence y Quality Passport midan el trabajo real y no una importación posterior.

## Historia

Planes, reportes y registros de las versiones V2–V10 con valor histórico viven bajo `archive/history/`. Snapshots SHA y validaciones temporales no forman parte de la superficie operativa.
