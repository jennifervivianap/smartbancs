# Reto Tecnico SmartBancs TCS

## Ejecutar

Requisitos: Docker Desktop con Compose.

```bash
docker compose up --build -d
curl http://localhost:4000/health
curl -X POST http://localhost:4000/transactions -H "Content-Type: application/json" -d "{\"sourceAccountId\":\"11111111-1111-1111-1111-111111111111\",\"targetAccountId\":\"22222222-2222-2222-2222-222222222222\",\"amountCents\":1000,\"currency\":\"USD\",\"idempotencyKey\":\"demo-001\"}"
curl http://localhost:4000/metrics
docker compose logs api ai-mock
docker compose down
```
Para comprobar que las recomendaciones fueron guardadas en PostgreSQL:

```powershell
docker compose exec postgres psql -U smartbancs -d smartbancs -c "SELECT transaction_id, recommendation FROM ai_recommendations ORDER BY created_at DESC limit 5;"

Para ejecutar el ETL con Node.js y npm instalados: `npm install` y `npm run etl`.

Con los servicios levantados, el smoke test de integración se ejecuta con `npm run test:smoke`.

La explicacion tecnica esta en [DOCUMENTO_TECNICO.md](DOCUMENTO_TECNICO.md), la declaracion de IA en [DECLARACION_IA.md](DECLARACION_IA.md).
