import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 4001);
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ai-mock' }));
app.post('/ ', async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 75));
  const amountCents = Number(req.body.amountCents ?? 0);
  const recommendation = amountCents >= 100000
    ? { type: 'budget_alert', message: 'Considera dividir transferencias grandes en metas de ahorro.' }
    : { type: 'saving_tip', message: 'Reserva un porcentaje fijo de tus ingresos para ahorro.' };
  res.json({ traceId: req.body.traceId, transactionId: req.body.transactionId, recommendation });
});
app.listen(port, () => console.log(JSON.stringify({ event: 'ai_mock_started', port })));
