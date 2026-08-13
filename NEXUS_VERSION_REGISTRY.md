# NEXUS — VERSION REGISTRY

| Versión | Estado | Rama canónica | Artifact principal | Reporte | Validación | SHA |
|---|---|---|---|---|---|---|
| V1 | CERRADA / histórica | `nexus-v1.2` | pendiente de compactar como `NEXUS_V1_FULL_REPO.zip` | evidencia histórica | CI histórico | pendiente registro final |
| V2 | IMPLEMENTADA | `nexus-v2` | `NEXUS_V2_FULL_REPO.zip` | `NEXUS_V2_REPORT.md` | `NEXUS_V2_VALIDATION.txt` | registrado en artefacto V2 |
| V3 | IMPLEMENTADA FUENTE / NO CERRADA POR GATES | `nexus-v3` | `NEXUS_V3_FULL_REPO.zip` | `NEXUS_V3_REPORT.md` | `NEXUS_V3_VALIDATION.txt` | `NEXUS_V3_SHA256.txt` |
| V4 | BUILD CANDIDATE | `nexus-v4` | `NEXUS_V4_BUILD_CANDIDATE.zip` | `NEXUS_V4_REPORT.md` | `NEXUS_V4_VALIDATION.txt` | `NEXUS_V4_SHA256.txt` |
| V5 | BUILD CANDIDATE | `nexus-v5` | `NEXUS_V5_BUILD_CANDIDATE.zip` | `NEXUS_V5_REPORT.md` | `NEXUS_V5_VALIDATION.txt` | `NEXUS_V5_SHA256.txt` |
| V6 | BUILD CANDIDATE | `nexus-v6` | `NEXUS_V6_BUILD_CANDIDATE.zip` | `NEXUS_V6_REPORT.md` | `NEXUS_V6_VALIDATION.txt` | `NEXUS_V6_SHA256.txt` |

## Política de preservación
No sobrescribir artifacts anteriores. No reutilizar SHAs. No llamar PASS a NOT TESTED/NOT MEASURED. Los fixes permanecen como commits de la rama mayor hasta cerrar sus gates.
