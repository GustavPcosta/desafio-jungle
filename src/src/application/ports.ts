import { Wallet } from './domain/wallet.js';
import { WagerTransaction } from './domain/wager-transaction.js';
import { WalletLedgerEntry } from './domain/ledger-entry.js';
import { InboxMessage } from './domain/inbox-message.js';
import { OutboxMessage } from './domain/outbox-message.js';
import { MoneyProps } from './domain/money.js';

export interface Clock { now(): Date }
export interface IdGenerator { next(): string }

export interface AppLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface MetricsPort {
  transactionResult(kind: string, status: string): void;
  duplicateDetected(source: 'http' | 'sqs' | 'inbox'): void;
  idempotencyConflict(): void;
  retry(component: 'reference' | 'outbox' | 'sqs'): void;
  dlqMessage(reason: string): void;
  lockWait(seconds: number): void;
  lockContention(): void;
  processingDuration(source: string, seconds: number): void;
  outboxLag(seconds: number, pending: number): void;
  outboxPublished(): void;
  reconciliationDivergence(): void;
}

export interface LedgerRow { seq: string; entry: WalletLedgerEntry }

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE — per-wallet pessimistic lock, held until the transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** false when (player_id, currency) already exists. */
  insert(wallet: Wallet): Promise<boolean>;
  /** Conditional update: only applies if the stored version equals expectedVersion. */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
export interface TransactionRepository {
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findByIdempotency(key: string, providerId: string, externalId: string): Promise<WagerTransaction[]>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  findByExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  save(tx: WagerTransaction): Promise<void>;
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  findDueForReferenceRetry(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
}
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerRow[]>;
  reconcile(walletId: string): Promise<{ stored: string; calculated: string; entries: number; currency: string } | undefined>;
}
export interface InboxRepository {
  /** false when (consumer_name, message_id) already exists (waits for a concurrent in-flight insert to resolve). */
  receive(msg: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}
export interface OutboxRepository {
  enqueue(msg: OutboxMessage): Promise<void>;
  /** FOR UPDATE SKIP LOCKED — safe for concurrent publishers. */
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(msg: OutboxMessage): Promise<void>;
  stats(): Promise<{ pending: number; oldestAgeSeconds: number }>;
}
export interface UnitOfWork {
  wallets: WalletRepository; transactions: TransactionRepository; ledger: LedgerRepository;
  inbox: InboxRepository; outbox: OutboxRepository;
}
export interface UnitOfWorkRunner { run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>; ping(): Promise<void>; }

export interface EventPublisher { publish(msg: OutboxMessage): Promise<void>; }

export interface TransactionResult {
  transactionId: string; status: string; balance: MoneyProps; failureCode?: string; providerAction?: string; idempotentReplay: boolean;
}
