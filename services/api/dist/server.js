"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const pg_1 = require("pg");
const pino_1 = __importDefault(require("pino"));
const prom_client_1 = require("prom-client");
const crypto_1 = require("crypto");
const logger = (0, pino_1.default)({ level: process.env.LOG_LEVEL ?? 'info' });
const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL, max: 20, connectionTimeoutMillis: 1000 });
const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:4001/recommendations';
const registry = new prom_client_1.Registry();
(0, prom_client_1.collectDefaultMetrics)({ register: registry });
const transactions = new prom_client_1.Counter({ name: 'smartbancs_transactions_total', help: 'Transactions processed', labelNames: ['status'], registers: [registry] });
const transactionDuration = new prom_client_1.Histogram({ name: 'smartbancs_transaction_duration_ms', help: 'Transaction duration', buckets: [10, 50, 100, 250, 500, 1000, 2000], registers: [registry] });
const aiCalls = new prom_client_1.Counter({ name: 'smartbancs_ai_calls_total', help: 'AI calls', labelNames: ['status'], registers: [registry] });
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '32kb' }));
function traceIdOf(req) {
    const header = req.header('x-trace-id');
    return header && /^[0-9a-f-]{36}$/i.test(header) ? header : (0, crypto_1.randomUUID)();
}
async function rollback(client) {
    try {
        await client.query('ROLLBACK');
    }
    catch { /* connection will be released */ }
}
async function requestRecommendation(transactionId, traceId, amountCents) {
    const started = Date.now();
    logger.info({ event: 'ai_call_started', transactionId, traceId });
    try {
        const response = await fetch(aiServiceUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transactionId, traceId, amountCents }),
            signal: AbortSignal.timeout(300)
        });
        if (!response.ok)
            throw new Error(`AI status ${response.status}`);
        const result = await response.json();
        await pool.query('INSERT INTO ai_recommendations (id, transaction_id, trace_id, recommendation, latency_ms) VALUES ($1, $2, $3, $4, $5)', [(0, crypto_1.randomUUID)(), transactionId, traceId, result.recommendation, Date.now() - started]);
        aiCalls.inc({ status: 'success' });
        logger.info({ event: 'ai_call_succeeded', transactionId, traceId, durationMs: Date.now() - started });
    }
    catch (error) {
        aiCalls.inc({ status: 'error' });
        logger.error({ event: 'ai_call_failed', transactionId, traceId, error: String(error) });
    }
}
app.get('/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', service: 'api' });
    }
    catch {
        res.status(503).json({ status: 'unavailable' });
    }
});
app.get('/metrics', async (_req, res) => { res.set('Content-Type', registry.contentType); res.end(await registry.metrics()); });
app.post('/transactions', async (req, res) => {
    const started = Date.now();
    const traceId = traceIdOf(req);
    const { sourceAccountId, targetAccountId, amountCents, currency = 'USD', idempotencyKey } = req.body ?? {};
    logger.info({ event: 'transaction_received', traceId });
    if (!sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
        transactions.inc({ status: 'rejected' });
        return res.status(400).json({ error: 'Invalid transaction request', traceId });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (idempotencyKey) {
            const existing = await client.query('SELECT id, trace_id, status, target_account_id, amount_cents, currency FROM transactions WHERE source_account_id = $1 AND idempotency_key = $2', [sourceAccountId, idempotencyKey]);
            if (existing.rowCount) {
                const previous = existing.rows[0];
                if (previous.target_account_id !== targetAccountId || Number(previous.amount_cents) !== amountCents || previous.currency.trim() !== currency) {
                    await rollback(client);
                    client.release();
                    return res.status(409).json({ error: 'Idempotency key already used with different transaction data', traceId });
                }
                await client.query('COMMIT');
                client.release();
                return res.status(200).json({ transactionId: previous.id, traceId: previous.trace_id, status: previous.status, idempotent: true });
            }
        }
        const ids = [sourceAccountId, targetAccountId].sort();
        const accounts = await client.query('SELECT id, balance_cents, currency FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
        if (accounts.rowCount !== 2) {
            await rollback(client);
            client.release();
            return res.status(404).json({ error: 'Account not found', traceId });
        }
        const source = accounts.rows.find((account) => account.id === sourceAccountId);
        const target = accounts.rows.find((account) => account.id === targetAccountId);
        if (source.currency.trim() !== currency || target.currency.trim() !== currency) {
            await rollback(client);
            client.release();
            return res.status(400).json({ error: 'Currency mismatch', traceId });
        }
        if (BigInt(source.balance_cents) < BigInt(amountCents)) {
            await rollback(client);
            client.release();
            return res.status(409).json({ error: 'Insufficient funds', traceId });
        }
        const transactionId = (0, crypto_1.randomUUID)();
        await client.query('UPDATE accounts SET balance_cents = balance_cents - $1, updated_at = now() WHERE id = $2', [amountCents, sourceAccountId]);
        await client.query('UPDATE accounts SET balance_cents = balance_cents + $1, updated_at = now() WHERE id = $2', [amountCents, targetAccountId]);
        await client.query('INSERT INTO transactions (id, trace_id, source_account_id, target_account_id, amount_cents, currency, idempotency_key, status, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())', [transactionId, traceId, sourceAccountId, targetAccountId, amountCents, currency, idempotencyKey ?? null, 'COMPLETED']);
        await client.query('COMMIT');
        client.release();
        transactions.inc({ status: 'completed' });
        transactionDuration.observe(Date.now() - started);
        logger.info({ event: 'transaction_completed', transactionId, traceId, durationMs: Date.now() - started });
        void requestRecommendation(transactionId, traceId, amountCents);
        return res.status(201).json({ transactionId, traceId, status: 'COMPLETED' });
    }
    catch (error) {
        await rollback(client);
        client.release();
        transactions.inc({ status: 'error' });
        logger.error({ event: 'transaction_failed', traceId, error: String(error) });
        return res.status(500).json({ error: 'Transaction failed', traceId });
    }
});
app.listen(Number(process.env.PORT ?? 4000), () => logger.info({ event: 'api_started', port: process.env.PORT ?? 4000 }));
