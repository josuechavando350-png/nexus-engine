# NQC V2 — Verificar el enrutamiento de oráculos que Aave utiliza, sin presumir acceso SVR

## Pregunta económica pendiente

NQC ejecutó una liquidación histórica WETH/USDC en el prefijo exacto después de Chainlink tx0, antes del liquidador ganador. PR727 certificó la causalidad EVM y PR731 acreditó lecturas rápidas de 54 cuentas Aave con Multicall3 y paridad entre dos RPC. Ninguno demuestra que **los feeds publicados en catálogos de Chainlink** sean los que actualmente consume el Aave V3 Ethereum Core, ni que la información esté disponible antes de la inclusión de una actualización.

Este experimento de SOLO LECTURA sigue la ruta efectiva de Aave para los tres activos de deuda/colateral de los ejemplos NQC: WETH, USDC, USDT. Los activos se fijan antes del primer acceso de red. No se seleccionan mercados por observar un resultado rentable.

## Procedimiento

1. Escribir `assets-and-ABI-sealed-before-network.json` con activos/Pool canónicos, selectores Keccak y hora local (nanosegundos UTC/monotónico), **antes de consultar Ethereum**.
2. dRPC y PublicNode públicos: verificar chainId=1, diferencia de head <=3 bloques y obtener exactamente el mismo bloque min-tip-minus-2 con número/hash/parent/stateRoot/timestamp. Usar ese mismo hash con EIP-1898 `requireCanonical:true` para TODAS las llamadas a contratos y code.
3. Leer `Pool.ADDRESSES_PROVIDER()` y exigir dirección ABI correcta, bytecode EVM no vacío y hash de bytecode idéntico en ambos RPC.
4. Del provider autenticado leer `getPriceOracle()`; autenticar la dirección y bytecode del Oracle idéntico en ambas fuentes. Leer `BASE_CURRENCY()`, `BASE_CURRENCY_UNIT()`, sin asumir a priori dólares, decimales ni paridad de stablecoins.
5. Para cada activo fijo, leer en el Oracle `getSourceOfAsset(asset)` y `getAssetPrice(asset)`, con paridad byte-a-byte de las respuestas en ambos RPC y código desplegado idéntico del contrato fuente. El Oracle devuelve su propia unidad de precio; **NO sustituirla por `latestRoundData()` ni deducir conversiones USD sin resolver la moneda base**.
6. Inspeccionar opcionalmente la interfaz de la fuente: `aggregator()`, `decimals()`, `latestRoundData()`. La compatibilidad con esa ABI puede indicar un proxy o wrapper, pero NO prueba acceso a un reporte SVR, ni que la fuente forme parte de una OFA. Si un selector explícitamente REVIERTE en ambas fuentes, registrar `SOURCE_SELECTOR_UNAVAILABLE`. Si HTTP403, HTTP429, timeout, discrepancia o respuesta RPC inválida, la auditoría COMPLETA permanece INCOMPLETE; un fallo del proveedor NO puede convertirse en 'feed no existe'.
7. Si `aggregator()` devuelve una dirección no nula y el código es auténtico, verificar SOLO un salto adicional de bytecode desplegado. Cualquier ruta de proxy más profunda queda sin demostrar: no inferir contractVersion, guardias de fallback ni subastas privadas a partir del bytecode.
8. Volver a autenticar el bloque final, exigir que siga canónico, conservar cada request con sus hashes SHA256 y latencia; registrar el manifiesto de cada archivo del CI y su commit/tree exactos.

## Límites rígidos

- Métodos autorizados: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getCode`, `eth_call`. Solo el Pool, su provider autenticado, su Oracle autenticado y fuentes/aggregators autenticados. Solo tres activos y selectores fijados. Sin `eth_sendTransaction`, EOA, `eth_getLogs` indiscriminado, firma, despliegue, sesión privada ni token transfers.
- Presupuesto máximo 38 solicitudes por proveedor; ritmo mínimo 400 ms entre despachos, sin retry tras 429 ni cambiar la identidad del cliente para saltar límites. Respuestas y runtime de tamaño acotado.
- Resultados consistentes en un bloque ya minado no prueban first-seen SVR, builder cutoff, pago del bid, coste de fallos, contrapartes financiadoras ni rentabilidad comercial. Es un censo de tres fuentes **específicas**, no de todos los activos de Aave, mercados ni posiciones.

PFT CLOSED, RMC OPEN, Shadow P2 NO CERTIFICADO, LIVE NO AUTORIZADO; OWN_CAPITAL USD0 incluyendo gas, sin sponsor contratado. MXN2,000 del usuario intactos; Comercial 5.9 sin aumento, P&L realizado NQC USD0. El motor de NQC permanece privado para su uso exclusivo y no se cede a competidores. No modificar visibilidad ni configuración del repositorio.
