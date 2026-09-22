import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 4001);
const delayMs = Number(process.env.AI_MOCK_DELAY_MS ?? 75);
const shouldFail = process.env.AI_MOCK_FAIL === 'true';
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ai-mock' }));
app.post('/recommendations', async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (shouldFail) return res.status(503).json({ error: 'AI mock failure' });
  const amountCents = Number(req.body.amountCents ?? 0);
  const recommendation = amountCents >= 100000
    ? { type: 'budget_alert', message: 'Considera dividir transferencias grandes en metas de ahorro.' }
    : { type: 'saving_tip', message: 'Reserva un porcentaje fijo de tus ingresos para ahorro.' };
  res.json({ traceId: req.body.traceId, transactionId: req.body.transactionId, recommendation });
});
app.listen(port, () => console.log(JSON.stringify({ event: 'ai_mock_started', port })));
