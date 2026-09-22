const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
const sourceAccountId = '11111111-1111-1111-1111-111111111111';
const targetAccountId = '22222222-2222-2222-2222-222222222222';

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const idempotencyKey = `smoke-${Date.now()}`;
const payload = {
  sourceAccountId,
  targetAccountId,
  amountCents: 1,
  currency: 'USD',
  idempotencyKey
};

async function main() {
  const health = await request('/health');
  assert(health.status === 200 && health.body.status === 'ok', 'API health check failed');

  const first = await request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert(first.status === 201 && first.body.status === 'COMPLETED', 'Initial transfer failed');

  const repeated = await request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert(repeated.status === 200 && repeated.body.idempotent === true, 'Idempotency replay failed');
  assert(repeated.body.transactionId === first.body.transactionId, 'Idempotency returned a different transaction');

  const conflicting = await request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, amountCents: 2 })
  });
  assert(conflicting.status === 409, 'Conflicting idempotency key was not rejected');

  const invalid = await request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, idempotencyKey: `invalid-${Date.now()}`, amountCents: 0 })
  });
  assert(invalid.status === 400, 'Invalid amount was not rejected');

  const insufficient = await request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, idempotencyKey: `insufficient-${Date.now()}`, amountCents: 999999999 })
  });
  assert(insufficient.status === 409, 'Insufficient funds were not rejected');

  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => request('/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, idempotencyKey: `concurrent-${Date.now()}-${index}` })
  })));
  assert(concurrent.every((result) => result.status === 201), 'Concurrent transfers did not complete successfully');

  console.log(JSON.stringify({
    passed: true,
    checks: ['health', 'transfer', 'idempotency', 'idempotency-conflict', 'validation', 'insufficient-funds', 'concurrency']
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
