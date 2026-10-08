# NQC — Directiva economica de maxima exigencia (2026-10-07)

**Estado:** mandato estrategico del operador; objetivo futuro, **NO** certificacion de P&L,
probabilidad de captura, capacidad disponible, garantia de beneficios ni condicion
para aprobar fraudulentamente una fase.

## Mandato economico explicito

- **Piso objetivo del primer mes completo de produccion:** **USD 500,000 NETOS REALIZADOS**.
- **Ventana de medida:** los primeros 30 dias consecutivos completos (UTC) despues del
  inicio verificable de produccion real autorizada, no desde las simulaciones,
  el Census o el primer test. Conservar timestamp de inicio inmutable.
- **Meses siguientes:** buscar un beneficio neto mensual creciente frente al mes
  anterior, sujeto a riesgo, disponibilidad real, competencia y no estacionariedad.
  Una disminucion o incumplimiento se reporta sin alterar resultados.
- **Techo:** **NINGUN TOPE ARTIFICIAL** de USD, mercados, volumen o crecimiento.
  La optimizacion busca el mayor beneficio neto verificable y ajustado por riesgo
  que la capacidad economica real permita. "Sin techo" no implica capacidad,
  apalancamiento o dinero infinito.
- **Capital propio del operador:** **OWN_CAPITAL = USD 0**; tambien para gas
  previo a la transaccion, colateral, perdidas de reversion y operaciones fallidas.
  No atribuir fondos inexistentes a un flash loan o a un builder.
- **Estándar de trabajo:** maximo rigor tecnico y estadistico, verificaciones
  independientes, artefactos inmutables, adversarialidad, determinismo,
  aritmetica exacta y controles fail-closed. La expresion "IQ infinito" se
  interpreta como aspiracion a maxima calidad, nunca como capacidad literal.

## Definicion de NETO REALIZADO

Para cada oportunidad efectivamente ejecutada y conciliada, partir de cobros
y pagos liquidables reales convertidos a USD con precios, timestamp y evidencia.
Descontar **todos** los costos: tarifas del protocolo y capital, flash fees,
swap fees, price impact, gas/prioridad, builder/MEV, financiacion, cobertura,
inventario, fallos/reverts, gastos por cadena, exposicion residual, fallas
operativas y otros costos reales. No sumar oportunidades correlacionadas,
no extrapolar capacidad ni confundir TVL/prestamos con ingresos. Conservar
trazabilidad de transacciones, liquidez, reservas, posiciones y capital.

Objetivo de referencia diario para 30 dias: >= USD 16,666.67 netos/dia en
promedio (USD 500,000 en 30 dias); **esto es un umbral objetivo**, no una
tasa observada.

## Orden de autoridad: verdad antes que meta

1. PFT y Real Market Census identifican universos, condiciones de mercado,
   fuentes externas y oportunidad **reconstruible**, sin generar ingresos.
2. RMC-011 certifica sus fuentes; RMC-012 prueba elegibilidad/colisiones;
   RMC-013 prueba economia ejecutable con rutas/gas/capital externos;
   RMC-014 autentica la cadena estructural; RMC-015/016 aportan evidencia
   temporal y capacidad conservadora; **solo RMC-017** puede certificar cierre.
3. Shadow debe generar predicciones ex ante y calibrar la probabilidad de captura
   con muestras independientes sin look-ahead; Canary prueba inclusion, seguridad,
   costos y P&L **real** con autoridad operativa explicita.
4. Toda meta de USD 500,000/mes, crecimiento y fiabilidad se contrasta con
   resultados reales, costos completos, intervalos de incertidumbre, competencia,
   riesgo de cola y capacidad capital-feasible.
5. Nunca utilizar este mandato para modificar un verificador, inventar un
   financiador de gas, fabricar trading, reducir bloqueos, sustituir datos,
   hacer cherry-picking, extrapolar P&L o declarar un status PASS falso.
6. Si no hay oportunidades ejecutables, la cota inferior comprobada de
   ingresos es USD 0. **Un Census puede estar terminado tecnicamente y el
   objetivo economico permanecer NO DEMOSTRADO.**

## Disciplina de riesgo y escalado

- Maximizar utilidad real *ajustada por riesgo* bajo limites verificables de
  perdida maxima, liquidez, gas, latencia, competidores, finalizacion y
  correlacion. Rechazar EV neto adversarial o tail-adjusted no positivo.
- Escalar por capacidad demostrada, no por porcentajes imaginados de la deuda
  total. Ampliar familias, cadenas, venues y capital externo solo con evidencia
  y sin relajar las condiciones de seguridad.
- El objetivo de fiabilidad P(M1_realized_net_usd >= 500,000) >= 0.90 se puede
  **proponer como criterio de aspiracion**; solo se declarara probado tras un
  metodo empirico, out-of-sample, con tamano muestral y modelado de dependencia
  adecuados. Nunca adoptar p=1 por defecto.
- Reportar a diario **objetivo, observado, incertidumbre, capacidad realmente
  ejecutable, captura efectiva, gastos y brecha**. No presentar una simulacion
  como transaccion ejecutada.

## Estado inicial al aprobar el mandato

**USD 500,000/primer mes = OBJETIVO, NO RESULTADO**.
**Ingreso real NQC y probabilidad de cumplimiento = NO CERTIFICADOS**.
**REAL_MARKET_CENSUS_CLOSED = false** hasta el certificado RMC-017 exacto.

Este documento establece prioridad economica y estandar de ejecucion, sin
alterar la evidencia inmutable ni los predicados de admision terminal.
