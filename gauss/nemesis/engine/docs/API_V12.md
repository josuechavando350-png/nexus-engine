# Cambios v12

## Motor 27: homología superior sobre F2

`runMotor('27', {action:'filtered', payload:{simplices:[...], maxOperations:10000000}})`
calcula intervalos del complejo simplicial filtrado suministrado. Cada simplex
es `{vertices:[0,1,...],value:0}`. Deben incluirse todas sus caras con valores
menores o iguales. Se aceptan IDs enteros no negativos; no se modifica la entrada.
Se ordena por valor y después dimensión para respetar caras anteriores a cofaces.

`action:'rips'` acepta `{points:[[x,y,...],...],maxHomology:2,maxRadius:3}`.
Construye los símplices hasta dimensión `maxHomology+1`, necesaria para calcular
las muertes en la última dimensión solicitada. La distancia es euclidiana.

Los resultados incluyen `bars`, con `dimension`, `birth`, `death`, `birthSimplex`
y `deathSimplex`. Los intervalos son `[birth,death)` y se conservan los de
longitud cero. `death:null` significa clase esencial en el complejo suministrado;
para Rips truncado significa supervivencia al radio máximo, no inmortalidad.

Reducción de columnas de la matriz frontera sobre F2. Límites: 10000 símplices,
dimensión 9 para complejos explícitos; Rips hasta H4, 64 puntos de 64 coordenadas.
Hay límites de operaciones, enumeración y almacenamiento; excederlos produce
error, nunca un barcode parcial presentado como completo. No hay procesamiento
fuera de memoria ni actualización incremental. #70 no se modifica en v12.

Pruebas independientes: círculo triangular, esferas H1–H4 como fronteras de
símplices, relleno de esas esferas, cuadrado Rips y rechazo de entradas inválidas.

## Motor 89: código Rust pendiente de ejecución

Consultar `native/fhe/README.md`. Código con TFHE, evaluador booleano y sumador.
La verificación JavaScript no acredita el backend Rust. El script
`node scripts/verify-native-fhe.mjs` produce evidencia explícita de éxito o fallo.

Referencia del algoritmo de persistencia:
https://math.uchicago.edu/~shmuel/AAT-readings/Data%20Analysis%20/persistence1.pdf
