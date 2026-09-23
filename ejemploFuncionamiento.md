# Ejemplo de funcionamiento de SmartBancs

## Flujo general

```text
Cliente
  |
  | POST /transactions
  v
API
  |
  | Transaccion SQL
  v
PostgreSQL
  |
  | Despues del COMMIT
  v
Mock de IA
```

## 1. Ejecucion de una transferencia

Ejemplo de peticion:

```json
{
  "sourceAccountId": "11111111-1111-1111-1111-111111111111",
  "targetAccountId": "22222222-2222-2222-2222-222222222222",
  "amountCents": 1000,
  "currency": "USD",
  "idempotencyKey": "demo-001"
}
```

La peticion llega a `services/api/src/server.ts`.

La API realiza estos pasos:

1. Genera un `traceId` para seguir la operacion en los logs.
2. Valida que las cuentas sean diferentes, que el monto sea positivo y que la moneda sea correcta.
3. Abre una transaccion PostgreSQL:

```sql
BEGIN;
```

4. Bloquea las dos cuentas:

```sql
SELECT id, balance_cents, currency
FROM accounts
WHERE id = ANY(...)
ORDER BY id
FOR UPDATE;
```

`FOR UPDATE` evita que dos operaciones modifiquen simultaneamente el mismo saldo.

5. Comprueba que la cuenta origen tenga saldo suficiente.
6. Descuenta el monto de la cuenta origen.
7. Acredita el monto en la cuenta destino.
8. Registra la operacion en la tabla `transactions`.
9. Confirma todo:

```sql
COMMIT;
```

Si algo falla antes del `COMMIT`, se ejecuta:

```sql
ROLLBACK;
```

Esto evita que se descuente dinero sin acreditarlo al destinatario.

### Ejemplo con saldos

Si Alice tiene `500000` centavos y se transfieren `1000` centavos:

```text
Saldo de Alice: 500000 - 1000 = 499000 centavos
Saldo de Bob:   250000 + 1000 = 251000 centavos
```

La API responde:

```json
{
  "transactionId": "uuid",
  "traceId": "uuid",
  "status": "COMPLETED"
}
```

## 2. Idempotencia

La `idempotencyKey` identifica un intento de transferencia.

Si el cliente repite la misma peticion con:

```json
"idempotencyKey": "demo-001"
```

la API busca si la operacion ya existe. Si existe, devuelve la transferencia anterior y no vuelve a modificar los saldos.

Esto es importante porque una aplicacion puede repetir una peticion cuando ocurre un timeout de red.

Resultado del segundo intento:

```json
{
  "transactionId": "mismo-id-de-la-primera-operacion",
  "status": "COMPLETED",
  "idempotent": true
}
```

## 3. Intervencion del mock de IA

El mock de IA esta en `services/ai-mock/src/server.ts` y escucha en el puerto `4001`.

La API primero confirma la transferencia y responde al usuario. Despues ejecuta la solicitud de recomendacion sin esperar su resultado:

```typescript
void requestRecommendation(transactionId, traceId, amountCents);
```

El flujo es:

```text
1. Ejecutar la transaccion SQL.
2. Confirmar con COMMIT.
3. Responder al cliente.
4. Llamar al mock de IA.
5. Guardar la recomendacion.
```

El mock espera 75 milisegundos para simular procesamiento de IA y devuelve una recomendacion.

Para transferencias menores a `100000` centavos devuelve:

```json
{
  "type": "saving_tip",
  "message": "Reserva un porcentaje fijo de tus ingresos para ahorro."
}
```

Para transferencias iguales o superiores a `100000` centavos devuelve:

```json
{
  "type": "budget_alert",
  "message": "Considera dividir transferencias grandes en metas de ahorro."
}
```

La recomendacion se guarda en la tabla `ai_recommendations`.

Lo importante es que si el mock de IA falla, la transferencia no se deshace, porque ya fue confirmada previamente en PostgreSQL.

## 4. Intervencion del ETL

El ETL esta en `scripts/etl.ts`.

El ETL no participa directamente en la transferencia en tiempo real. Es un proceso separado para limpiar datos historicos o transaccionales antes de usarlos para analisis o entrenamiento de IA.

Su flujo es:

```text
data/raw-transactions.json
          |
          v
         ETL
          |
          v
data/clean-transactions.json
```

Entrada de ejemplo:

```json
{
  "amount": "12.50",
  "currency": "usd",
  "occurredAt": "2026-09-22 10:00:00"
}
```

Salida normalizada:

```json
{
  "amountCents": 1250,
  "currency": "USD",
  "occurredAt": "2026-09-22T10:00:00.000Z"
}
```

El ETL:

- Elimina filas sin monto valido.
- Convierte los montos a centavos.
- Convierte la moneda a mayusculas.
- Normaliza las fechas a formato ISO.
- Informa cuantas filas fueron aceptadas y rechazadas.

Se ejecuta con:

```bash
npm install
npm run etl
```

## 5. Diferencia entre transferencia, IA y ETL

| Componente | Momento de ejecucion | Proposito |
|---|---|---|
| API + PostgreSQL | Tiempo real | Ejecutar la transferencia |
| Mock de IA | Despues de la transferencia | Generar una recomendacion |
| ETL | Proceso independiente | Limpiar datos historicos |

## 6. Explicacion corta para la defensa

> La API procesa la transferencia de forma sincronica y atomica en PostgreSQL. Una vez confirmado el `COMMIT`, solicita una recomendacion al servicio de IA de manera asincrona, sin retrasar al usuario. El ETL es un proceso independiente que limpia y normaliza transacciones historicas para analisis y futuros modelos de IA; no esta dentro del camino critico de la transferencia.

## 7. Como probar los dos caminos del mock de IA

Primero verifica que los servicios esten activos:

```powershell
docker compose ps
```

El servicio de IA debe estar disponible en `http://localhost:4001`.

### Camino 1: recomendacion de ahorro

Un monto menor a `100000` centavos genera una recomendacion `saving_tip`:

```powershell
curl.exe -sS -X POST http://localhost:4001/recommendations `
  -H "Content-Type: application/json" `
  -d '{"transactionId":"test-small","traceId":"11111111-1111-1111-1111-111111111111","amountCents":50000}'
```

Respuesta esperada:

```json
{
  "type": "saving_tip",
  "message": "Reserva un porcentaje fijo de tus ingresos para ahorro."
}
```

### Camino 2: alerta de presupuesto

Un monto igual o mayor a `100000` centavos genera una recomendacion `budget_alert`:

```powershell
curl.exe -sS -X POST http://localhost:4001/recommendations `
  -H "Content-Type: application/json" `
  -d '{"transactionId":"test-large","traceId":"22222222-2222-2222-2222-222222222222","amountCents":100000}'
```

Respuesta esperada:

```json
{
  "type": "budget_alert",
  "message": "Considera dividir transferencias grandes en metas de ahorro."
}
```

La regla del mock es:

```text
amountCents < 100000   -> saving_tip
amountCents >= 100000  -> budget_alert
```

## 8. Probar el flujo completo mediante la API

Estas pruebas ejecutan la transferencia real, actualizan los saldos y luego llaman al mock de IA de forma asincrona.

### Transferencia pequena

```powershell
curl.exe -sS -X POST http://localhost:4000/transactions `
  -H "Content-Type: application/json" `
  -d '{"sourceAccountId":"11111111-1111-1111-1111-111111111111","targetAccountId":"22222222-2222-2222-2222-222222222222","amountCents":50000,"currency":"USD","idempotencyKey":"ia-small-001"}'
```

La API debe responder con `status: "COMPLETED"`. Despues, el mock genera `saving_tip`.

### Transferencia grande

```powershell
curl.exe -sS -X POST http://localhost:4000/transactions `
  -H "Content-Type: application/json" `
  -d '{"sourceAccountId":"11111111-1111-1111-1111-111111111111","targetAccountId":"22222222-2222-2222-2222-222222222222","amountCents":100000,"currency":"USD","idempotencyKey":"ia-large-001"}'
```

La API debe responder con `status: "COMPLETED"`. Despues, el mock genera `budget_alert`.

## 9. Verificar logs y recomendaciones guardadas

Para observar la trazabilidad de la API y el mock:

```powershell
docker compose logs -f api ai-mock
```

En los logs debes encontrar eventos similares a:

```text
transaction_completed
ai_call_started
ai_call_succeeded
```

Para comprobar que las recomendaciones fueron guardadas en PostgreSQL:

```powershell
docker compose exec postgres psql -U smartbancs -d smartbancs -c "SELECT transaction_id, recommendation FROM ai_recommendations ORDER BY created_at DESC;"
```

La prueba demuestra que la transferencia se completa primero y que la recomendacion se persiste despues, sin bloquear el flujo principal.

## 10. Probar rechazos, errores y metricas

La API expone las metricas en:

```text
http://localhost:4000/metrics
```

El contador principal es:

```text
smartbancs_transactions_total{status="completed"}
smartbancs_transactions_total{status="rejected"}
smartbancs_transactions_total{status="error"}
smartbancs_transactions_total{status="idempotent"}
```

Tambien se registra la duracion de cada resultado en `smartbancs_transaction_duration_ms`.

### Rechazo por monto invalido: HTTP 400

```powershell
curl.exe -sS -i -X POST http://localhost:4000/transactions `
  -H "Content-Type: application/json" `
  -d '{"sourceAccountId":"11111111-1111-1111-1111-111111111111","targetAccountId":"22222222-2222-2222-2222-222222222222","amountCents":0,"currency":"USD","idempotencyKey":"reject-invalid-001"}'
```

Este caso incrementa `status="rejected"`.

### Rechazo por saldo insuficiente: HTTP 409

```powershell
curl.exe -sS -i -X POST http://localhost:4000/transactions `
  -H "Content-Type: application/json" `
  -d '{"sourceAccountId":"11111111-1111-1111-1111-111111111111","targetAccountId":"22222222-2222-2222-2222-222222222222","amountCents":999999999,"currency":"USD","idempotencyKey":"reject-balance-001"}'
```

Este caso tambien incrementa `status="rejected"` y registra el evento `transaction_rejected` con razon `insufficient_funds`.

### Error simulado del mock de IA

El error de IA no debe convertir la transferencia en error. En PowerShell:

```powershell
$env:AI_MOCK_FAIL = "true"
docker compose up -d --force-recreate ai-mock
```

Ejecuta una transferencia valida y comprueba que responde `201` y `COMPLETED`. Luego consulta:

```powershell
docker compose logs api
curl.exe -sS http://localhost:4000/metrics
```

Debe aparecer `ai_call_failed` en los logs y `smartbancs_ai_calls_total{status="error"}` en las metricas. La transferencia debe seguir apareciendo como `smartbancs_transactions_total{status="completed"}`.

Restaura el mock:

```powershell
$env:AI_MOCK_FAIL = "false"
docker compose up -d --force-recreate ai-mock
```

### Consultar solo los contadores relevantes

En PowerShell se puede filtrar la salida asi:

```powershell
(curl.exe -sS http://localhost:4000/metrics) | Select-String "smartbancs_transactions_total|smartbancs_ai_calls_total|smartbancs_transaction_duration_ms"
```

Ejemplo de resultado esperado:

```text
smartbancs_transactions_total{status="completed"} 1
smartbancs_transactions_total{status="rejected"} 2
smartbancs_transactions_total{status="error"} 0
smartbancs_ai_calls_total{status="success"} 1
smartbancs_ai_calls_total{status="error"} 1
```

Los valores exactos dependen de cuantas pruebas se hayan ejecutado. Lo importante es que cada respuesta rechazada o error incrementa un contador y observa su latencia.

## 11. Smoke test reproducible

Con los servicios levantados, desde la raiz del proyecto se ejecuta:

```powershell
npm install
npm run test:smoke
```

El smoke test comprueba salud de la API, transferencia exitosa, reintento idempotente, conflicto de clave idempotente, validacion de monto, saldo insuficiente y cinco transferencias concurrentes.

Salida esperada:

```json
{
  "passed": true,
  "checks": [
    "health",
    "transfer",
    "idempotency",
    "idempotency-conflict",
    "validation",
    "insufficient-funds",
    "concurrency"
  ]
}
```

## 12. Fallo controlado de IA

La transferencia no depende de que la IA responda. Para simular un error del mock:

```powershell
$env:AI_MOCK_FAIL = "true"
docker compose up -d --force-recreate ai-mock
```

Ejecuta una transferencia y comprueba que la API responde `COMPLETED`. Luego revisa el error asincrono:

```powershell
docker compose logs api
```

Debe aparecer `ai_call_failed`, mientras la transferencia permanece confirmada en PostgreSQL. Para restaurar el comportamiento normal:

```powershell
$env:AI_MOCK_FAIL = "false"
docker compose up -d --force-recreate ai-mock
```
