# NEXUS — VERSION REGISTRY

| Versión | Estado | Rama canónica | Artifact principal | Reporte / plan | Validación | SHA / evidencia |
|---|---|---|---|---|---|---|
| V1 | CERRADA / histórica | `nexus-v1.2` | pendiente de compactar como `NEXUS_V1_FULL_REPO.zip` | evidencia histórica | CI histórico | pendiente registro final |
| V2 | IMPLEMENTADA | `nexus-v2` | `NEXUS_V2_FULL_REPO.zip` | `NEXUS_V2_REPORT.md` | `NEXUS_V2_VALIDATION.txt` | registrado en artefacto V2 |
| V3 | IMPLEMENTADA / revalidada en cadena V3→V10 | `main` | fuentes + artefactos reproducibles desde `main` | `NEXUS_V3_REPORT.md` | `pnpm v3-gates` dentro de CI V10 | evidencia ligada al SHA exacto de CI |
| V4 | IMPLEMENTADA / revalidada en cadena V3→V10 | `main` | fuentes + artefactos reproducibles desde `main` | `NEXUS_V4_REPORT.md` | `pnpm v4-gates` dentro de CI V10 | evidencia ligada al SHA exacto de CI |
| V5 | IMPLEMENTADA / revalidada en cadena V3→V10 | `main` | fuentes + artefactos reproducibles desde `main` | `NEXUS_V5_REPORT.md` | `pnpm v5-gates` dentro de CI V10 | evidencia ligada al SHA exacto de CI |
| V6 | IMPLEMENTADA / revalidada en cadena V3→V10 | `main` | fuentes + artefactos reproducibles desde `main` | `NEXUS_V6_REPORT.md` | `pnpm v6-gates` dentro de CI V10 | evidencia ligada al SHA exacto de CI |
| V7 | IMPLEMENTADA / audit-hardening activo | `main` | paquetes V7 con build real y declaraciones | `NEXUS_V7_ARCHITECTURE_PLAN.md` | `pnpm v7-gates` dentro de CI V10 | validación V10 sobre SHA exacto de `main` |
| V8 | IMPLEMENTADA / audit-hardening activo | `main` | paquetes creative/experience + artefactos de build | `NEXUS_V8_ARCHITECTURE_PLAN.md` | `pnpm v8-gates` dentro de CI V10 | validación V10 sobre SHA exacto de `main` |
| V9 | IMPLEMENTADA / audit-hardening activo | `main` | measurement/capture/benchmark/evidence con build real | `NEXUS_V9_ARCHITECTURE_PLAN.md` | `pnpm v9-gates` dentro de CI V10 | validación V10 sobre SHA exacto de `main` |
| V10 | CANDIDATO DE PRODUCCIÓN / auditoría adversarial en reparación | `main` | repositorio completo + evidencia CI/SBOM/clean-room | `NEXUS_V10_ARCHITECTURE_PLAN.md` | `pnpm v10-gates` + CI V3→V10 + H07 | el SHA definitivo se registra únicamente después de cerrar la auditoría adversarial |

## Política de preservación
No sobrescribir artifacts anteriores. No reutilizar SHAs. No llamar PASS a NOT TESTED/NOT MEASURED. Los fixes permanecen como commits de la rama mayor hasta cerrar sus gates.

## Política de evidencia actual
A partir de V7, la fuente canónica es `main`; las ramas históricas se conservan como procedencia, no como estado operativo actual. La evidencia de cierre debe corresponder al SHA exacto validado por GitHub Actions. El SHA final de V10 no se fija anticipadamente: se registra cuando todos los hallazgos adversariales estén cerrados y el mismo commit haya pasado la validación completa post-merge.
