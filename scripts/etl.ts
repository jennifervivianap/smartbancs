import { readFile, writeFile } from 'node:fs/promises';

type Raw = { transactionId?: string; sourceAccountId?: string; targetAccountId?: string; amount?: string | number | null; currency?: string | null; occurredAt?: string | null };
async function main() {
  const input = JSON.parse(await readFile('data/raw-transactions.json', 'utf8')) as Raw[];
  const output = input.flatMap((row) => {
    const amount = Number(row.amount);
    if (!row.transactionId || !row.sourceAccountId || !row.targetAccountId || !Number.isFinite(amount) || amount <= 0) return [];
    return [{ transactionId: row.transactionId.trim(), sourceAccountId: row.sourceAccountId.trim(), targetAccountId: row.targetAccountId.trim(), amountCents: Math.round(amount * 100), currency: (row.currency ?? 'USD').trim().toUpperCase(), occurredAt: new Date(row.occurredAt ?? Date.now()).toISOString() }];
  });
  await writeFile('data/clean-transactions.json', JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ inputRows: input.length, outputRows: output.length, rejectedRows: input.length - output.length }));
}

main();
