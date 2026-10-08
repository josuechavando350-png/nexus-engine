# RMC-016 — Cuánto dinero **aparece en el mercado observado**, y qué NO podemos atribuir a Nexus

**Estado:** evidencia económica matemática limitada, anclada al source D16 original; **no es una estimación de rentabilidad de NQC**, un objetivo mensual certificado, un backtest predictivo ni un resultado neto del operador.

## Autoridades de datos EXACTAS

- Fuente de contabilidad observada: `ci/nqc-census/rmc016-production-evidence.json`; Git blob SHA-1 `5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa`, fuente de autoridad D16 SHA-256 `9dc03b2d2c480d689e5ecf1e4585d2af55a4271db6a3e5ef0851f821085fac63`; authority commitment `0xa952f2a3af9c1cef8103a9ad9586f62bc3548d0bdee2c7c1c7ae60018490396c`.
- Registro de fuentes de gas admisibles: `ci/nqc-census/rmc011-external-capital-provider-registry.json`; Git blob SHA-1 `a9c1427bb05828d08ade537899ee1b8e43b97ed2`. **Número de proveedores autorizados para ejecutar NQC: 0**. Cero proveedores configurados NO significa inexistencia mundial.
- Ventana original delimitada: Ethereum bloques **25,880,316 a 26,095,351**, inclusive **215,036 bloques**; hashes inicial y final anclados. **No se presupone que sea un mes natural completo.**
- **139** eventos de liquidación y **127** transacciones ganadoras de competidores, con política de contar el gas de una transacción una sola vez y sin atribuir oportunidades censuradas a éxitos.
- Fuente D16 exacta: **138,045.17469031 USD** de margen bruto *oracular* histórico registrado; **1,144.134260592713842029 USD** de gas efectivamente pagado por esos competidores; **136,901.040429717286157971 USD** de diferencia parcial. Estas cifras **NO** son beneficio neto realizable de Nexus ni pueden presentarse como un máximo mundial de mercado. La existencia, exactitud y exhaustividad del libro transacción-a-transacción y de los quince componentes completos de coste no se certifican en este PR.

## Falsación económica cuantitativa, no promesa

Calculamos con aritmética entera WAD, **sin convertir el modelo en una predicción comercial**, la fracción mínima de cada agregado histórico necesaria para igualar objetivos nominales durante **la misma ventana observada**:

- 15,000 USD nominales / margen bruto registrado; y 15,000 USD / diferencia parcial después del gas de los ganadores.
- 55,000 USD nominales / las mismas dos bases.

Cada cociente se expresa en puntos básicos **redondeando hacia arriba**. Es solo una **condición necesaria optimista** de representación del valor histórico. No mide qué operaciones serían capturables, ni si podemos financiar nuestro gas, ni cómo se comporta ese mercado frente a otro periodo, ni si el gas/las rutas de los competidores serían los nuestros.

Todos los costes faltantes —premio de flash, swaps, slippage, impacto de precio, builder, MEV, financiación, revert fallidos, infraestructura y responsabilidades de terceros— y la competencia obligarían a una reconciliación más exigente. Algunos costos podrían variar a favor o contra Nexus; ningún modelo de este PR estima su valor.

**La captura real, el beneficio realizado y la capacidad mensual conservadora atribuida a NQC continúan en USD 0 demostrado.** El 0 es un límite conservador de certificación por falta de evidencia, no una predicción de cero ganancias futuras.

El umbral estadístico `P(monthly_net_pnl >= 15000 USD) >= 0.90` o `>= 55000 USD` NO se demuestra con un único periodo, y no se permite calcularlo desde porcentajes de mercado bruto.

## Punto de ingeniería

Este informe distingue explícitamente:
1. Mercado externo económicamente activo y margen *oracular* histórico observado.
2. Economía del ganador histórico **incompletamente reconciliada** (margen menos únicamente gas observado).
3. Economía ejecutable hipotética por NQC (**aún desconocida** por financiación/inclusión/costes).
4. Beneficio realmente realizado por NQC (**cero demostrado**).

Debe recuperar las **127 filas originales de economía por transacción**, no inventarlas desde un hash, y someter cada coste/fuente de financiación a auditoría. El `RMC016_WINNER_NET_EVIDENCE_CONTRACT.md` en el repositorio advierte expresamente que el archivo que publica solo hashes no basta para certificar toda la economía por transacción. Este PR **no pretende suplir esos datos**.

Ninguna mutación de la cadena, llave privada, intercambio, contrato pago, registro de un sponsor, cierre de Census o modificación de `main`. Esta es una prueba verificable del **obstáculo económico que tendríamos que vencer**, no un pronóstico de ingresos.
