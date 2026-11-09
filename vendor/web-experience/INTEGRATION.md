# Integración del kit Web Experience en NEXUS ENGINE

Este módulo es un **registro de procedencia + gestor de descargas bajo demanda**. No importa dependencias en Core ni genera bundles por defecto.

## Aislamiento FORJA

FORJA inventaría los archivos regulares rastreados. Los submódulos Git (`mode 160000`) violan ese contrato; por eso este kit no usa `.gitmodules` ni gitlinks. Los cuatro clones se guardan en `vendor/web-experience/<id>/` con reglas exactas de `.gitignore`, fuera del índice y del inventario FORJA. El código versionado del kit consiste en catálogo, gestor, pruebas y documentación.

Git clona solo URLs HTTPS validadas de GitHub (`file:` y `ext:` deshabilitados), usa `--no-checkout` y fija el commit. Hooks de checkout deshabilitados y `GIT_LFS_SKIP_SMUDGE=1`. El gestor comprueba las copias en una carpeta temporal ignorada antes de publicarlas, verifica Git HEAD y LICENSE, y rechaza cambios locales en vez de sobrescribirlos.

## Comandos

```sh
pnpm web-experience list
pnpm web-experience verify all
pnpm web-experience init photoswipe
pnpm web-experience:init
pnpm web-experience:verify
pnpm test:web-experience
```

## Aplicaciones consumidoras

El uso real requiere seleccionar una app, instalar y fijar sus dependencias compatibles en esa app y desarrollar su adaptador. Verificar ciclo de vida, SSR, accesibilidad, teclado/tacto, movimiento reducido, fallback y rendimiento móvil. Scroll Rig requiere GPU y React/Fiber/Three; SeamTransitions son demos experimentales para adaptar. No importar fuentes upstream desde Core, Experience Engine ni Rust.

La corrección de TypeScript en un mock `fetch` de la prueba Cano quedó separada y fusionada en PR #760; **este PR del kit no modifica `apps/cano-penal/`**. Revisar los checks sobre el SHA exacto antes de fusionar; los controles de registro no sustituyen las suites generales.
