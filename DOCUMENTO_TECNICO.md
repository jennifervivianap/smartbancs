# Documento tecnico SmartBancs

## Resumen

El MVP recibe transferencias por REST, actualiza dos cuentas de forma atomica en PostgreSQL y dispara recomendaciones de IA despues del commit. La recomendacion no bloquea la transferencia.

## Arquitectura

`Cliente -> API TypeScript -> PostgreSQL` y `API -> AI Mock` de forma asincrona. Docker Compose levanta PostgreSQL, la API y el mock de IA. Para produccion, un broker durable desacoplaria la API del adaptador hacia Bancs.

## Concurrencia

La API usa `BEGIN/COMMIT`, bloqueo `SELECT ... FOR UPDATE` y orden determinista de IDs antes de bloquear. Esto evita carreras y reduce deadlocks cuando ocurren transferencias inversas. El dinero se maneja en centavos enteros. La clave de idempotencia evita duplicar un reintento.

## Bancs

La API publica un evento de transferencia completada; un adaptador consume lotes con reintentos, backoff, circuit breaker e idempotencia. La conciliacion compara eventos y saldos con Bancs. Asi se evita consultar el core legado en cada request.

## IA

El mock simula inferencia y devuelve recomendaciones. La API responde inmediatamente despues del commit y llama a IA sin `await` en el camino de respuesta. Los errores de IA quedan en logs y metricas. En produccion se agregarian versionado de modelo, validacion offline, monitoreo de data drift, canary release y limites de CPU/memoria.

## Observabilidad

Logs JSON contienen `event`, `traceId`, `transactionId`, estado y duracion. `/metrics` expone volumen de transacciones, duracion y llamadas a IA. El mismo `traceId` permite seguir una operacion en API, base de datos y IA.

## Incidente

Ante timeouts/deadlocks: medir p95/p99 y errores por traceId, revisar `pg_stat_activity`, pool y recursos, aislar consumidores no criticos como IA, terminar sesiones bloqueadas identificadas y usar reintentos limitados con backoff. Despues se corrige el orden de locks, se acortan transacciones y se agregan pruebas de carga y alertas.

## Limites del MVP

No demuestra 10 000 TPS en un equipo local. Demuestra el patron escalable; para esa carga se requieren replicas, broker, pool controlado, cache, particionamiento, autoscaling y pruebas de rendimiento.
