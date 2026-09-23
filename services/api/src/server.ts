import express, { Request, Response } from 'express';
import { Pool, PoolClient } from 'pg';
import pino from 'pino';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { randomUUID } from 'crypto';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20, connectionTimeoutMillis: 1000 });
const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:4001/recommendations';
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const transactions = new Counter({ name: 'smartbancs_transactions_total', help: 'Transactions processed', labelNames: ['status'], registers: [registry] });
const transactionDuration = new Histogram({ name: 'smartbancs_transaction_duration_ms', help: 'Transaction duration', buckets: [10, 50, 100, 250, 500, 1000, 2000], registers: [registry] });
const aiCalls = new Counter({ name: 'smartbancs_ai_calls_total', help: 'AI calls', labelNames: ['status'], registers: [registry] });

const app = express();
app.use(express.json({ limit: '32kb' }));

function traceIdOf(req: Request): string {
  const header = req.header('x-trace-id');
  return header && /^[0-9a-f-]{36}$/i.test(header) ? header : randomUUID();
}

function observeTransaction(status: string, started: number): void {
  transactions.inc({ status });
  transactionDuration.observe(Date.now() - started);
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* connection will be released */ }
}

async function requestRecommendation(transactionId: string, traceId: string, amountCents: number): Promise<void> {
  const started = Date.now();
  logger.info({ event: 'ai_call_started', transactionId, traceId });
  try {
    const response = await fetch(aiServiceUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId, traceId, amountCents }),
      signal: AbortSignal.timeout(300)
    });
    if (!response.ok) throw new Error(`AI status ${response.status}`);
    const result = await response.json() as { recommendation: object };
    await pool.query('INSERT INTO ai_recommendations (id, transaction_id, trace_id, recommendation, latency_ms) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), transactionId, traceId, result.recommendation, Date.now() - started]);
    aiCalls.inc({ status: 'success' });
    logger.info({ event: 'ai_call_succeeded', transactionId, traceId, durationMs: Date.now() - started });
  } catch (error) {
    aiCalls.inc({ status: 'error' });
    logger.error({ event: 'ai_call_failed', transactionId, traceId, error: String(error) });
  }
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'api' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});
app.get('/metrics', async (_req, res) => { res.set('Content-Type', registry.contentType); res.end(await registry.metrics()); });

app.post('/transactions', async (req, res) => {
  const started = Date.now();
  const traceId = traceIdOf(req);
  const { sourceAccountId, targetAccountId, amountCents, currency = 'USD', idempotencyKey } = req.body ?? {};
  logger.info({ event: 'transaction_received', traceId });
  if (!sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    observeTransaction('rejected', started);
    logger.warn({ event: 'transaction_rejected', traceId, reason: 'invalid_request' });
    return res.status(400).json({ error: 'Invalid transaction request', traceId });
  }
  let client: PoolClient;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    if (idempotencyKey) {
      const existing = await client.query('SELECT id, trace_id, status, target_account_id, amount_cents, currency FROM transactions WHERE source_account_id = $1 AND idempotency_key = $2', [sourceAccountId, idempotencyKey]);
      if (existing.rowCount) {
        const previous = existing.rows[0];
        if (previous.target_account_id !== targetAccountId || Number(previous.amount_cents) !== amountCents || previous.currency.trim() !== currency) {
          await rollback(client);
          client.release();
          observeTransaction('rejected', started);
          logger.warn({ event: 'transaction_rejected', traceId, reason: 'idempotency_conflict' });
          return res.status(409).json({ error: 'Idempotency key already used with different transaction data', traceId });
        }
        await client.query('COMMIT');
        client.release();
        observeTransaction('idempotent', started);
        return res.status(200).json({ transactionId: previous.id, traceId: previous.trace_id, status: previous.status, idempotent: true });
      }
    }
    const ids = [sourceAccountId, targetAccountId].sort();
    const accounts = await client.query('SELECT id, balance_cents, currency FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    if (accounts.rowCount !== 2) {
      await rollback(client);
      client.release();
      observeTransaction('rejected', started);
      logger.warn({ event: 'transaction_rejected', traceId, reason: 'account_not_found' });
      return res.status(404).json({ error: 'Account not found', traceId });
    }
    const source = accounts.rows.find((account) => account.id === sourceAccountId);
    const target = accounts.rows.find((account) => account.id === targetAccountId);
    if (source.currency.trim() !== currency || target.currency.trim() !== currency) {
      await rollback(client);
      client.release();
      observeTransaction('rejected', started);
      logger.warn({ event: 'transaction_rejected', traceId, reason: 'currency_mismatch' });
      return res.status(400).json({ error: 'Currency mismatch', traceId });
    }
    if (BigInt(source.balance_cents) < BigInt(amountCents)) {
      await rollback(client);
      client.release();
      observeTransaction('rejected', started);
      logger.warn({ event: 'transaction_rejected', traceId, reason: 'insufficient_funds' });
      return res.status(409).json({ error: 'Insufficient funds', traceId });
    }
    const transactionId = randomUUID();
    await client.query('UPDATE accounts SET balance_cents = balance_cents - $1, updated_at = now() WHERE id = $2', [amountCents, sourceAccountId]);
    await client.query('UPDATE accounts SET balance_cents = balance_cents + $1, updated_at = now() WHERE id = $2', [amountCents, targetAccountId]);
    await client.query('INSERT INTO transactions (id, trace_id, source_account_id, target_account_id, amount_cents, currency, idempotency_key, status, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())', [transactionId, traceId, sourceAccountId, targetAccountId, amountCents, currency, idempotencyKey ?? null, 'COMPLETED']);
    await client.query('COMMIT');
    client.release();
    observeTransaction('completed', started);
    logger.info({ event: 'transaction_completed', transactionId, traceId, durationMs: Date.now() - started });
    void requestRecommendation(transactionId, traceId, amountCents);
    return res.status(201).json({ transactionId, traceId, status: 'COMPLETED' });
  } catch (error) {
    if (client!) {
      await rollback(client);
      client.release();
    }
    observeTransaction('error', started);
    logger.error({ event: 'transaction_failed', traceId, error: String(error) });
    return res.status(500).json({ error: 'Transaction failed', traceId });
  }
});

app.listen(Number(process.env.PORT ?? 4000), () => logger.info({ event: 'api_started', port: process.env.PORT ?? 4000 }));
