import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../application/domain/money.js';
import { Wallet } from '../../application/domain/wallet.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../application/domain/wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from '../../application/domain/ledger-entry.js';
import { InboxMessage } from '../../application/domain/inbox-message.js';
import { OutboxMessage } from '../../application/domain/outbox-message.js';
import { FailureCode } from '../../application/domain/failure-code.js';
import {
  InboxRepository, LedgerRepository, LedgerRow, OutboxRepository, TransactionRepository, UnitOfWork, WalletRepository,
} from '../../application/ports.js';
import { TransientInfrastructureError } from '../../application/domain/erros.js';

type Row = Record<string, any>;
const iso = (d: Date) => d; // pg driver serialises Date as timestamptz
const money = (amount: string, currency: string) => Money.from({ amount: String(amount), currency: String(currency).trim() });
const optDate = (v: unknown) => (v == null ? undefined : new Date(v as string));

class Base {
  constructor(protected readonly em: EntityManager) {}
  /** Runs inside the surrounding transaction (EntityManager.transactional context). */
  protected async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.em.execute(sql, params as any[])) as Row[];
  }
}

class PgWalletRepository extends Base implements WalletRepository {
  private map(r: Row): Wallet {
    return Wallet.rehydrate({
      id: r.id, playerId: r.player_id, currency: String(r.currency).trim(), balance: money(r.balance, r.currency),
      version: Number(r.version), createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
    });
  }
  async findById(id: string) { const r = await this.q('SELECT * FROM wallets WHERE id = ?::uuid', [id]); return r[0] ? this.map(r[0]) : undefined; }
  async findByIdForUpdate(id: string) {
    const r = await this.q('SELECT * FROM wallets WHERE id = ?::uuid FOR UPDATE', [id]);
    return r[0] ? this.map(r[0]) : undefined;
  }
  async insert(w: Wallet) {
    const r = await this.q(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?::uuid, ?::uuid, ?, ?::numeric, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [w.id, w.playerId, w.currency, w.balance.amount, w.version, iso(w.createdAt), iso(w.updatedAt)]);
    return r.length === 1;
  }
  async updateBalance(w: Wallet, expectedVersion: number) {
    const r = await this.q(
      'UPDATE wallets SET balance = ?::numeric, version = ?, updated_at = ? WHERE id = ?::uuid AND version = ? RETURNING id',
      [w.balance.amount, w.version, iso(w.updatedAt), w.id, expectedVersion]);
    if (r.length !== 1) throw new TransientInfrastructureError(`Optimistic version check failed for wallet ${w.id}`);
  }
}

class PgTransactionRepository extends Base implements TransactionRepository {
  private map(r: Row): WagerTransaction {
    const currency = String(r.currency).trim();
    return WagerTransaction.rehydrate({
      id: r.id, providerId: r.provider_id, externalTransactionId: r.external_transaction_id, idempotencyKey: r.idempotency_key,
      payloadHash: String(r.payload_hash).trim(), walletId: r.wallet_id, playerId: r.player_id, roundId: r.round_id, gameId: r.game_id,
      kind: r.kind as WagerTransactionKind, money: money(r.amount, currency),
      referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined, createdAt: new Date(r.created_at),
      status: r.status as WagerTransactionStatus, referenceTransactionId: r.reference_transaction_id ?? undefined,
      failureCode: (r.failure_code ?? undefined) as FailureCode | undefined, processedAt: optDate(r.processed_at),
      observedBalance: r.observed_balance == null ? undefined : money(r.observed_balance, currency),
      pendingAttempts: Number(r.pending_attempts), nextAttemptAt: optDate(r.next_attempt_at),
    });
  }
  async insertIfAbsent(t: WagerTransaction) {
    const r = await this.q(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, status, created_at)
       VALUES (?::uuid, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?::numeric, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash, t.walletId, t.playerId, t.roundId, t.gameId,
        t.kind, t.money.amount, t.money.currency, t.referenceExternalTransactionId ?? null, t.status, iso(t.createdAt)]);
    return r.length === 1;
  }
  async findByIdempotency(key: string, providerId: string, externalId: string) {
    const r = await this.q('SELECT * FROM wager_transactions WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)',
      [key, providerId, externalId]);
    return r.map((x) => this.map(x));
  }
  async findById(id: string) { const r = await this.q('SELECT * FROM wager_transactions WHERE id = ?::uuid', [id]); return r[0] ? this.map(r[0]) : undefined; }
  async findByIdForUpdate(id: string) {
    const r = await this.q('SELECT * FROM wager_transactions WHERE id = ?::uuid FOR UPDATE', [id]);
    return r[0] ? this.map(r[0]) : undefined;
  }
  async findByExternal(providerId: string, externalId: string) {
    const r = await this.q('SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?', [providerId, externalId]);
    return r[0] ? this.map(r[0]) : undefined;
  }
  async save(t: WagerTransaction) {
    await this.q(
      `UPDATE wager_transactions SET status = ?, reference_transaction_id = ?::uuid, failure_code = ?, observed_balance = ?::numeric,
         pending_attempts = ?, next_attempt_at = ?, processed_at = ? WHERE id = ?::uuid`,
      [t.status, t.referenceTransactionId ?? null, t.failureCode ?? null, t.observedBalance?.amount ?? null, t.pendingAttempts,
        t.nextAttemptAt ? iso(t.nextAttemptAt) : null, t.processedAt ? iso(t.processedAt) : null, t.id]);
  }
  async hasProcessedReversalOf(refId: string) {
    const r = await this.q(`SELECT 1 FROM wager_transactions WHERE reference_transaction_id = ?::uuid AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED' LIMIT 1`, [refId]);
    return r.length > 0;
  }
  async findDueForReferenceRetry(now: Date, limit: number) {
    const r = await this.q(`SELECT id, wallet_id FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`, [iso(now), limit]);
    return r.map((x) => ({ id: x.id as string, walletId: x.wallet_id as string }));
  }
}

class PgLedgerRepository extends Base implements LedgerRepository {
  async append(e: WalletLedgerEntry) {
    await this.q(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?)`,
      [e.id, e.walletId, e.transactionId, e.direction, e.money.amount, e.money.currency, e.balanceBefore.amount, e.balanceAfter.amount, iso(e.createdAt)]);
  }
  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerRow[]> {
    const r = await this.q('SELECT * FROM wallet_ledger_entries WHERE wallet_id = ?::uuid AND seq > ?::bigint ORDER BY seq LIMIT ?', [walletId, afterSeq ?? '0', limit]);
    return r.map((x) => {
      const c = String(x.currency).trim();
      return { seq: String(x.seq), entry: WalletLedgerEntry.rehydrate({
        id: x.id, walletId: x.wallet_id, transactionId: x.transaction_id, direction: x.direction as LedgerDirection, money: money(x.amount, c),
        balanceBefore: money(x.balance_before, c), balanceAfter: money(x.balance_after, c), createdAt: new Date(x.created_at),
      }) };
    });
  }
  /** One statement = one snapshot, so stored vs. calculated cannot be skewed by concurrent writers. */
  async reconcile(walletId: string) {
    const r = await this.q(
      `SELECT w.balance AS stored, w.currency AS currency,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS calculated,
              COUNT(l.id) AS entries
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = ?::uuid GROUP BY w.id`, [walletId]);
    if (!r[0]) return undefined;
    return { stored: String(r[0].stored), calculated: String(r[0].calculated), entries: Number(r[0].entries), currency: String(r[0].currency).trim() };
  }
}

class PgInboxRepository extends Base implements InboxRepository {
  async receive(m: InboxMessage) {
    const r = await this.q(
      'INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id',
      [m.consumerName, m.messageId, m.payloadHash, iso(m.receivedAt)]);
    return r.length === 1;
  }
  async find(consumerName: string, messageId: string) {
    const r = await this.q('SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?', [consumerName, messageId]);
    if (!r[0]) return undefined;
    return InboxMessage.rehydrate({ messageId: r[0].message_id, consumerName: r[0].consumer_name, payloadHash: String(r[0].payload_hash).trim(),
      receivedAt: new Date(r[0].received_at), processedAt: optDate(r[0].processed_at) });
  }
  async markProcessed(consumerName: string, messageId: string, at: Date) {
    await this.q('UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?', [iso(at), consumerName, messageId]);
  }
}

class PgOutboxRepository extends Base implements OutboxRepository {
  private map(r: Row): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id, aggregateId: r.aggregate_id, eventType: r.event_type, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      occurredAt: new Date(r.occurred_at), attempts: Number(r.attempts), nextAttemptAt: optDate(r.next_attempt_at), publishedAt: optDate(r.published_at),
    });
  }
  async enqueue(m: OutboxMessage) {
    await this.q(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?::uuid, ?::uuid, ?, ?::jsonb, ?, ?, ?)`,
      [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), iso(m.occurredAt), m.attempts, m.nextAttemptAt ? iso(m.nextAttemptAt) : null]);
  }
  async lockDue(now: Date, limit: number) {
    const r = await this.q(
      `SELECT * FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq LIMIT ? FOR UPDATE SKIP LOCKED`, [iso(now), limit]);
    return r.map((x) => this.map(x));
  }
  async save(m: OutboxMessage) {
    await this.q('UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ?::uuid',
      [m.attempts, m.nextAttemptAt ? iso(m.nextAttemptAt) : null, m.publishedAt ? iso(m.publishedAt) : null, m.id]);
  }
  async stats() {
    const r = await this.q(`SELECT COUNT(*) AS pending, COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0) AS age FROM outbox_messages WHERE published_at IS NULL`);
    return { pending: Number(r[0].pending), oldestAgeSeconds: Number(r[0].age) };
  }
}

export class PgUnitOfWork implements UnitOfWork {
  readonly wallets: WalletRepository; readonly transactions: TransactionRepository; readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository; readonly outbox: OutboxRepository;
  constructor(em: EntityManager) {
    this.wallets = new PgWalletRepository(em); this.transactions = new PgTransactionRepository(em);
    this.ledger = new PgLedgerRepository(em); this.inbox = new PgInboxRepository(em); this.outbox = new PgOutboxRepository(em);
  }
}
