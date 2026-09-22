-- DDL: SmartBancs core tables
-- Uses row-level locking (SELECT ... FOR UPDATE) at the application layer
-- on "accounts" to avoid race conditions on balance updates.

CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY,
    owner_name      VARCHAR(120) NOT NULL,
    balance_cents   BIGINT NOT NULL CHECK (balance_cents >= 0),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
    id                  UUID PRIMARY KEY,
    trace_id            UUID NOT NULL,
    source_account_id   UUID NOT NULL REFERENCES accounts(id),
    target_account_id   UUID NOT NULL REFERENCES accounts(id),
    amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'USD',
    idempotency_key     VARCHAR(120),
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    -- PENDING | COMPLETED | FAILED
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transactions_trace_id ON transactions(trace_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency
    ON transactions(source_account_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_recommendations (
    id              UUID PRIMARY KEY,
    transaction_id  UUID NOT NULL REFERENCES transactions(id),
    trace_id        UUID NOT NULL,
    recommendation  JSONB NOT NULL,
    latency_ms       INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_recommendations_tx ON ai_recommendations(transaction_id);

-- Seed data (DML) for local testing
INSERT INTO accounts (id, owner_name, balance_cents, currency)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'Alice Demo', 500000, 'USD'),
    ('22222222-2222-2222-2222-222222222222', 'Bob Demo', 250000, 'USD')
ON CONFLICT (id) DO NOTHING;
