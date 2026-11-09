# Evidencia y límites — NEXUS Web Experience Kit (2026-11-09)

## Comprobación local del gestor de clones ignorados

- Linux, Node 22.16.0: `node --check scripts/web-experience.mjs` correcto.
- `node --test tests/web-experience.contract.mjs`: **27/27 aprobadas**, cero fallidas u omitidas.
- Cobertura: catálogo alterado, URLs no confiables, protocolos locales, SHA flotante, ausencia de reglas de ignorados, gitlinks indebidamente rastreados, directorios inesperados, cambios locales, commit y blob de LICENSE, y simulación sin red de descarga y publicación.
- Los dobles de Git de las pruebas offline no equivalen a descargar los upstream realmente; el workflow Node 24 lo comprueba aparte.

## Evidencia remota y límites

El workflow anterior basado en submódulos logró descargar y verificar las cuatro fuentes en run [42648388239](https://github.com/josuechavando350-png/nexus-engine/actions/runs/42648388239), pero **ese resultado no valida el nuevo gestor de clones ignorados**. Consultar la ejecución del workflow `NEXUS Web Experience Sources` en el SHA actual del PR #757 para validar la nueva mecánica.

Los cambios del kit no modifican código de producción. Una reparación preexistente del tipado de `vi.fn<typeof fetch>` en prueba Cano se fusionó por separado en PR #760, por lo que el diff del kit conserva el aislamiento de clientes.

Quedan fuera: adaptadores visuales en aplicaciones, certificación upstream, pruebas de SSR/teclado/tacto/accesibilidad, medición GPU y móvil y revisión comercial de todos los activos de terceros. La discrepancia MIT/ISC de Scroll Rig sigue documentada. Registrar una fuente no equivale a integración visual certificada.

El estado de los checks se evalúa por SHA; no inferir éxito de una ejecución anterior.
