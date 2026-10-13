# NQC RMC V2 — Francotirador en modo observación (sin transacciones)

## Estado verificable — 13 de octubre de 2026

**GitHub:** PR #692 (borrador), rama `nqc/rmc-v2-live-readonly-sniper-20261013`. Las pruebas en GitHub Actions ejecutaron una **primera muestra real** [run 38482739768](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38482739768), correspondiente al bloque Ethereum **26,186,773**; posteriormente [run 38483200340](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38483200340), bloque **26,186,794**. Ambas muestras consiguieron tres respuestas RPC coincidentes, cuatro borrowers examinados y **cero posiciones con HF inferior a 1**. La segunda corrida agregó 27 pruebas del diario append-only a las 32 pruebas del lector.

**Estado operacional:** pruebas de lectura reales realizadas en runners efímeros de GitHub Actions. **La vigilancia permanente 24/7 NO está desplegada**, ni la cuenta DigitalOcean está conectada por SSH desde este flujo. No existe evidencia de liquidación en vivo, alerta capturada, ganancia neta positiva ni Shadow P2 certificado.

## Objetivo comercial y límite de la evidencia

Objetivo del usuario: **USD 45,000–55,000 NETOS operativos al mes**. Eso exige USD 1,500–1,833.33 diarios para un mes de 30 días. Es un objetivo a falsar, **no una previsión**, resultado conseguido ni garantía. Este lector mide exclusivamente `Aave Pool.getUserAccountData(address)`, con el HF real en bloques identificados.

La vigilancia de cuatro borrowers históricamente seleccionados NO tiene cobertura suficiente para pronosticar el universo de mercados ni las capturas competitivas. Una observación con HF inferior a 1 produciría un **candidato de estado**, no autorización para ejecutar. Toda oportunidad requiere validación de posición, capital disponible, deuda, colateral, rutas on-chain, coste real, simulación atómica, builder/competidores y patrocinio de gas sin recurso.

## Implementación

- `sniper_readonly_observer.py`: métodos RPC estrictamente limitados a `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber` y `eth_call`. Pinning EIP-1898 (`blockHash`, `requireCanonical=true`), confirmaciones, lecturas raw ABI, doble comprobación de encabezado, rechazo de divergencia/staleness. Tres endpoints pueden concordar sin demostrar, por ello, operadores independientes.
- `sniper_readonly_journal.py`: **candidato** de servicio recurrente cada 300 segundos. Los JSON de observación se crean con `O_EXCL` y fsync. Cada entrada en `journal.jsonl` conserva `previous_entry_sha256`, digest del JSON y estado de fuente. Auditoría fail-closed al reiniciar. Las observaciones con fallo del proveedor no se interpretan como cero candidatos.
- `deploy/systemd/nqc-v2-sniper-readonly.service`: unidad systemd para Ubuntu 24.04, con `DynamicUser=yes`, acceso de escritura limitado a `StateDirectory`, `NoNewPrivileges`, sin capacidades Linux, con límites de CPU y memoria. **Solo plantilla: no instalada ni activada en los droplets.**
- Tests: `python3 -m unittest discover -s ci/nqc-census/rmc-v2-shadow -p 'test_sniper_readonly_observer.py' -v` y `-p 'test_sniper_readonly_journal.py'`.

## Infraestructura existente, coste y autorizaciones

La cuenta DigitalOcean muestra **cuatro droplets activos** de **USD 24 mensuales de precio nominal cada uno**, total USD 96/mes si siguen activos durante el ciclo completo, antes de impuestos, transferencias o servicios asociados. Este dato hace relevante no afirmar que todo el proyecto funciona a coste personal cero. Ningún recurso nuevo se creó con este trabajo.

Host posible para **un futuro despliegue**, sin garantía de acceso operativo: `codex-nqc-rmc-328dd6`, etiqueta `scanner`, 2 vCPU, 4 GB RAM, Ubuntu 24.04, DigitalOcean Frankfurt. Antes de instalar:

1. Obtener autorización explícita para operar una carga recurrente sobre ese host, confirmar quién cubre el coste existente y verificar su estado actual, sus procesos y su salud.
2. Disponer de acceso remoto tipo SSH o conexión de administración autorizada. El plugin DigitalOcean utilizado aquí permite inventario, pero **no ofrece ejecución remota de comandos**.
3. Revisar un commit exacto del PR #692, instalar archivos bajo `/opt/nqc/nexus-engine/`, verificar los test locales, copiar la unidad systemd y **habilitarla manualmente solo con autorización operativa y coste conocidos**.
4. Validar `systemctl is-active`, `journalctl -u nqc-v2-sniper-readonly`, auditoría del `journal.jsonl`, avance de bloques, pérdida de proveedor, ausencia de transacciones y estabilidad ≥24h.
5. Mantener `P2_shadow_certified=false`, `RMC_closed=false`, `nqc_realized_pnl_usd=0` hasta tener evidencias que permitan revisarlos.

Por seguridad, **no depositar ETH ni conectar MetaMask**, no insertar una clave privada en archivos/env vars de GitHub o del servidor, y no habilitar transacciones. El servicio no incorpora capacidad de construcción o publicación de transacciones.

## Gating hacia el primer disparo real

El prototipo 24/7 una vez instalado medirá **estados de borrowers**, no ganará una liquidación por sí solo. El siguiente desarrollo deberá incorporar descubrimiento de borrowers recién activos, muestreo de alta frecuencia, marcas de tiempo ancladas, simulación pretrade, resultados netos conservadores, pruebas de captura frente a competidores y financiación completa —incluido gas nativo— sin aportación ni responsabilidad financiera personal del operador.

El éxito histórico de un fork WETH/WETH con devolución del préstamo y excedente físico **no sustituye** a esos gates ni prueba que el bot gane la misma operación en producción.

**Puntuación comercial mantenida: 5.9/10. RMC OPEN, P2 OPEN, P&L real USD 0.**
