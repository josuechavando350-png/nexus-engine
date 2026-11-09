# Evidencia y límites — 2026-11-09

## Ejecutado localmente

Entorno de comprobación disponible: Node v22.16.0 en Linux. El repositorio declara Node 24; no se confunden ambos entornos.

- `node --check scripts/web-experience.mjs`: correcto.
- `node --test tests/web-experience.contract.mjs`: 26 pruebas, 26 aprobadas, 0 fallidas, 0 omitidas.
- `node scripts/web-experience.mjs list`: devuelve exactamente los cuatro recursos y sus commits.
- Las pruebas de registro usan índices Git temporales reales con gitlinks; las pruebas de estado usan un checkout local de prueba.
- La comprobación de argumentos de descarga usa un doble de Git: demuestra selección y controles, no una descarga real de los cuatro upstream.
- Los commits y archivos de licencia del catálogo se consultaron mediante el conector GitHub.

## No ejecutado en este entorno

- Descarga real de los cuatro submódulos: el entorno local no resuelve github.com.
- Instalación de dependencias npm o integración en una aplicación.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build` completos del monorepo.
- Suite en Node 24, CI completo, pruebas de navegador, accesibilidad visual o rendimiento móvil.

Este documento no declara CI verde ni autorización de despliegue. El cambio deja fuentes opcionales registradas y un gestor probado localmente; no cuatro funcionalidades visuales activas en producción.
