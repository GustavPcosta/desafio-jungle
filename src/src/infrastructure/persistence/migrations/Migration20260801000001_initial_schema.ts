import { Migration } from '@mikro-orm/migrations';

/**
 * Invariants enforced in the schema (not only in application code):
 *  - one wallet per (player_id, currency); balance >= 0; version >= 1
 *  - unique idempotency_key and unique (provider_id, external_transaction_id)
 *  - a transaction can be reversed (REFUND/ROLLBACK) at most once (partial unique index)
 *  - ledger is append-only (triggers block UPDATE/DELETE/TRUNCATE) and arithmetically balanced (CHECK)
 *  - at most one ledger entry per (wallet, transaction)
 *  - inbox PK (consumer_name, message_id)
 */
export class Migration20260801000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL,
        version     integer NOT NULL DEFAULT 1,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      );`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid PRIMARY KEY,
        provider_id                        text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id            text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key                    text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        payload_hash                       char(64) NOT NULL,
        wallet_id                          uuid NOT NULL REFERENCES wallets(id),
        player_id                          uuid NOT NULL,
        round_id                           text NOT NULL,
        game_id                            text NOT NULL,
        kind                               text NOT NULL,
        amount                             numeric(20,2) NOT NULL,
        currency                           char(3) NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid REFERENCES wager_transactions(id),
        status                             text NOT NULL,
        failure_code                       text,
        observed_balance                   numeric(20,2),
        pending_attempts                   integer NOT NULL DEFAULT 0,
        next_attempt_at                    timestamptz,
        created_at                         timestamptz NOT NULL,
        processed_at                       timestamptz,
        CONSTRAINT wt_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wt_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wt_amount_valid CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
        CONSTRAINT wt_reversal_needs_reference CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wt_failure_code_on_failure CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wt_processed_at_on_terminal CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wt_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wt_provider_external_unique UNIQUE (provider_id, external_transaction_id)
      );`);
    // A transaction can be reversed at most once, by any reversal kind (stricter than "same kind").
    this.addSql(`CREATE UNIQUE INDEX wt_single_reversal_idx ON wager_transactions (reference_transaction_id)
                 WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';`);
    this.addSql(`CREATE INDEX wt_wallet_idx ON wager_transactions (wallet_id);`);
    this.addSql(`CREATE INDEX wt_pending_reference_due_idx ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigserial NOT NULL UNIQUE,
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(20,2) NOT NULL CHECK (amount > 0),
        currency       char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at     timestamptz NOT NULL,
        CONSTRAINT ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT'  AND balance_before - amount = balance_after)),
        CONSTRAINT ledger_one_entry_per_wallet_tx UNIQUE (wallet_id, transaction_id)
      );`);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`);
    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;`);
    this.addSql(`CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
                 FOR EACH ROW EXECUTE FUNCTION ledger_immutable();`);
    this.addSql(`CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
                 FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  char(64) NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        seq             bigserial NOT NULL UNIQUE,
        id              uuid PRIMARY KEY,
        aggregate_id    uuid NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at    timestamptz
      );`);
    this.addSql(`CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, seq) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_update_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
