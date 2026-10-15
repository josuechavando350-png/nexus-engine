# NQC G2L — Compound III USDC: liquidaciones descontadas sin inventario material en un bloque

**Veredicto: MALO | confianza técnica: ALTA en el bloque declarado | confianza comercial: BAJA | validación económica: 4/10, SIN CAMBIO.** NQC P&L REALIZADO USD 0, OWN_CAPITAL USD 0. No hubo transacciones, wallets, gas pagado ni despliegues.

## Evidencia REAL obtenida (no laboratorio sintético)

- Ethereum **bloque 26199216**; hash `0xdc72c612a7b041b10d22fdd6198579e2004f0252eb15980abe9a02bff7b00e9a`; stateRoot `0x03e6941f6cc2f8fd5af07465c5f0be64cdaae218ba0f10ade09e10be992f7d65`.
- Dos RPC autorizados previamente en PR #745: `ethereum-rpc.publicnode.com` y `eth.drpc.org`; las lecturas de Compound y Uniswap se fijaron en ese MISMO bloque. El segundo trabajo reconfirmó hash y stateRoot al inicio y final.
- **Compound III Comet USDC** `0xc3d688b66703497daa19211eedff47f25384cdc3`: `getReserves = 8,444,303.286429 USDC`; `targetReserves = 20,000,000 USDC`; compras no pausadas; 13 activos enumerados con reservas de ambos RPC.
- Nueve activos admitieron `quoteCollateral(asset, 1,000 USDC)` coincidente en ambos RPC; en los nueve casos el colateral devuelto **excede enormemente** las reservas físicas. Aplicando la aritmética entera y una cota superior conservadora a sus compras máximas, el conjunto de los nueve inventarios admite **menos de 0.018435 USDC de principal de compra en total** a este bloque. Esto no es beneficio NQC.
- **WETH**: cuota Compound para 1,000 USDC = **0.430231548441256777 WETH**. Inventario físico WETH = **0.000000001932917990 WETH**. La compra hipotética de 1,000 USDC no es ejecutable.
- **Uniswap V3 QuoterV2** `0x61ffe014ba17989e743c5f6cb21bf9697530b21e`, mismo bloque: vender esos 0.430231548... WETH inexistentes en inventario daría **1,046.357378 USDC** a fee 0.05% o **1,041.247983 USDC** a fee 0.3%; la diferencia bruta respecto a 1,000 USDC (+46.357378 / +41.247983) es contrafactual y **NO CAPTURABLE**. Vender TODO el inventario WETH auténtico da solo **0.000004 USDC** por cualquiera de las dos rutas, antes de gas.
- **deUSD** `0x15700b564ca08d9439c58ca5053166e8317aa138`: la llamada `quoteCollateral` respondió **JSON-RPC code 3** con **Panic(0x12): división por cero** (bytes originales `0x4e487b71...12`). Fuente anterior PR #745 había ocultado esta causa como `RPC_NULL_OR_ERROR_eth_call`.
- **deUSD y sdeUSD** `0x5c5b196abe0d54485975d1ec29617d42d9198326` comparten precio oráculo bruto `1` y liquidationFactor `0.92e18`; storefrontPriceFactor `0.6e18`. En la fórmula original de Compound, el precio descontado es `floor(1*(1-0.048))=0`, lo que explica el revert observado en deUSD. El fallo de sdeUSD es **deducción del mismo estado y parámetros**, no una cotización sdeUSD ejecutada.
- Los dos últimos activos tenían inventario de colateral exactamente **cero**. No existe en este bloque una compra de tamaño material demostrada. No se afirma imposibilidad de otras cadenas, fechas o mercados.

## Procedencia inmutable y trazabilidad

1. Ejecución de Compound `38772131759`: https://github.com/josuechavando350-png/nexus-engine/actions/runs/38772131759 — artefacto `11992076897`, ZIP SHA-256 `e3418bd93060570bc80bb1a4496a345eeaa3685e1240094f48a5e1c0b7e90651`; commit `08fd0595339cafea16f8f3f22a38cda65dfedb64`.
2. Ejecución de DEX `38772907917`: https://github.com/josuechavando350-png/nexus-engine/actions/runs/38772907917 — artefacto `11992242549`, ZIP SHA-256 `1e3a77ce48250a80490f74bf1afd8b47240f988d3824fb6cee04564d53144495`; commit `0c67a6d1982f1771829c0f4ccd5cba1a93f96fea`.
3. Paquete forense reproducido en conversación: `NQC_COMPOUND_III_REAL_QUOTES_FALSIFICATION_2026-10-15.zip`; SHA256 `77d275799fa8ee4976e4ea5f20f46735a19b9085c5686998e020498326ce0656`, prueba adversarial **9/9**, regeneración idéntica en ambiente limpio. Este ZIP es adjunto de la conversación y **no** está incorporado como binario al repositorio.
4. PR histórico de mercado: #745, intacto. Solo se creó la rama `nqc/compound3-one-shot-quote-20261015`, con dos workflows de lectura de una ejecución cada uno; sin cron.

## Decisión

**FAIL para capacidad de comprar colateral económicamente material en este Comet USDC y este bloque concreto**. Los fallos no prueban imposibilidad universal. No invertir más esfuerzo en repetir el mismo snapshot con la misma cartera de activos. **Siguiente prueba económica útil:** censo de transiciones `AbsorbCollateral` → aparición de reservas → `BuyCollateral`/intercambio en un período acotado, y competencia temporal. Exigir una cohorte prospectiva con cuota DEX ejecutable, coste total y financiador sin recurso antes de subir de 4/10 o hablar de ingresos.
