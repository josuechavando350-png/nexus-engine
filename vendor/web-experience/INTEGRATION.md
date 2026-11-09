# Integracion del kit en NEXUS ENGINE

Los cuatro repositorios se mantienen en `vendor/web-experience/` como submodulos fijados, con el catalogo como fuente de verdad. Son recursos reutilizables optativos, no dependencias globales de todos los clientes.

## Comandos del workspace

```sh
pnpm web-experience list
pnpm web-experience init photoswipe
pnpm web-experience:init
pnpm web-experience:verify
pnpm test:web-experience
```

`web-experience:init` recupera las cuatro fuentes. `web-experience:verify` exige que esten presentes y limpias, y comprueba commits y archivos LICENSE. No instala paquetes npm ni activa componentes en una web. Para comprobar solo el registro sin descargar, usar `pnpm web-experience verify all`.

La suite `pnpm test` ya ejecuta el puente Vitest `tests/web-experience.test.ts`. El comando separado permite ejecutar los 26 contratos sin instalar dependencias del monorepo.

## Comprobacion remota de las fuentes

`.github/workflows/web-experience-sources.yml` ejecuta los contratos con Node 24, comprueba el registro, descarga los cuatro commits y exige que sus licencias y estados Git coincidan. Tambien comprueba que repetir la inicializacion no cambia el checkout. Usa permisos de solo lectura, acciones fijadas por SHA y no ejecuta scripts upstream ni usa secretos de clientes.

La existencia del workflow no acredita un resultado aprobado. Consultar el run del SHA concreto. Tampoco sustituye las validaciones completas de lint, TypeScript, pruebas y build del monorepo, ni ensayos de accesibilidad y rendimiento en una web consumidora.

## Correccion necesaria para validar la integracion

El run Full Validation del commit inicial `f6e0df1b9db759cee07b34f1390643bcee49237b` termino en TypeScript con TS2493 en `apps/cano-penal/src/app/api/nexus/growth/route.test.ts:56`. El mock de fetch se inferia como funcion sin argumentos, pero la prueba inspecciona el segundo argumento de una llamada. El commit `ed1f947316587c2688464ec96cc54e26f4d62794` lo tipa con `vi.fn<typeof fetch>`; no cambia la ruta de produccion ni elimina ninguna asercion. Se conserva ese cambio y su workflow, sin duplicarlos.

## Limites de esta incorporacion

Core, Experience Engine, Rust, NQC, credenciales y despliegues no cambian. PhotoSwipe, Embla y Scroll Rig siguen necesitando montaje y configuracion en cada aplicacion consumidora. SeamTransitions se conserva como coleccion de demos para adaptar, no como paquete npm ni componentes de produccion certificados. Consultar `README.md` y `catalog.json` para requisitos, procedencia y la discrepancia de licencia de Scroll Rig.
