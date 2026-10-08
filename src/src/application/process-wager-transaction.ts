import { Money, MoneyProps } from './domain/money.js';
import { Wallet } from './domain/wallet.js';
import {
  WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S,
} from './domain/wager-transaction.js';
import { FailureCode, FAILURE_ACTION } from './domain/failure-code.js';
import { InboxMessage } from './domain/inbox-message.js';
import { OutboxMessage } from './domain/outbox-message.js';
import { LedgerDirection } from './domain/ledger-entry.js';
import {
  EventContext, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from './domain/events/integration-event.js';
import {
  IdempotencyConflictError, PermanentMessageError, ValidationError, WalletNotFoundError,
} from './domain/erros.js';
import {
  AppLogger, Clock, IdGenerator, MetricsPort, TransactionResult, UnitOfWork, UnitOfWorkRunner,
} from './ports.js';

export interface SubmitWagerCommand {
  idempotencyKey: string; providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: K; money: MoneyProps; referenceExternalTransactionId?: string;
}
export interface InboxContext { consumerName: string; messageId: string; payloadHash: string; }
export interface ProcessContext { correlationId: string; source: 'http' | 'sqs' | 'retry'; causationId?: string; inbox?: InboxContext; }

export interface ReferenceRetryPolicy { maxAttempts: number; ttlMs: number; baseDelayMs: number; maxDelayMs: number; }
export const DEFAULT_RETRY_POLICY: ReferenceRetryPolicy = { maxAttempts: 10, ttlMs: 60 * 60_000, baseDelayMs: 2_000, maxDelayMs: 5 * 60_000 };

type RefResolution =
  | { kind: 'found'; ref: WagerTransaction }
  | { kind: 'pending' }                      // reference missing or itself still waiting
  | { kind: 'rejected'; code: FailureCode }; // reference can never be valid

/** Single use case shared by the HTTP entry point and the SQS consumer (and the PENDING_REFERENCE worker). */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly runner: UnitOfWorkRunner, private readonly clock: Clock, private readonly ids: IdGenerator,
    private readonly metrics: MetricsPort, private readonly logger: AppLogger,
    private readonly retryPolicy: ReferenceRetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async execute(cmd: SubmitWagerCommand, ctx: ProcessContext): Promise<TransactionResult> {
    const started = performance.now();
    if (cmd.kind === K.Opening) throw new ValidationError('OPENING is internal and cannot be submitted');
    const money = Money.from(cmd.money); // InvalidMoneyError (400) on bad input
    const tx = WagerTransaction.create({ ...cmd, id: this.ids.next(), money, now: this.clock.now() });
    try {
      const result = await this.runner.run((uow) => this.processInTx(uow, tx, cmd, ctx));
      this.metrics.processingDuration(ctx.source, (performance.now() - started) / 1000);
      return result;
    } catch (e) {
      if (e instanceof IdempotencyConflictError) this.metrics.idempotencyConflict();
      throw e;
    }
  }

  private async processInTx(uow: UnitOfWork, tx: WagerTransaction, cmd: SubmitWagerCommand, ctx: ProcessContext): Promise<TransactionResult> {
    // 1. Inbox dedup (SQS only) — same SQL transaction as the financial change.
    if (ctx.inbox) {
      const received = await uow.inbox.receive(InboxMessage.receive({ ...ctx.inbox, now: this.clock.now() }));
      if (!received) {
        const existing = await uow.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (existing && existing.payloadHash !== ctx.inbox.payloadHash) {
          throw new PermanentMessageError('INBOX_PAYLOAD_MISMATCH', `messageId ${ctx.inbox.messageId} redelivered with a different payload`);
        }
        this.metrics.duplicateDetected('inbox');
        const found = await uow.transactions.findByIdempotency(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
        if (found.length > 0) return this.toResult(found[0], found[0].observedBalance, true);
        // inbox row committed together with the transaction, so this is unreachable; fall through defensively
      }
    }

    // 2. Per-wallet pessimistic lock (the unit of concurrency is the walletId).
    const t0 = performance.now();
    const wallet = await uow.wallets.findByIdForUpdate(cmd.walletId);
    const waited = (performance.now() - t0) / 1000;
    this.metrics.lockWait(waited);
    if (waited > 0.025) this.metrics.lockContention();
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    // 3. Persistent idempotency: unique constraints decide, never memory.
    const inserted = await uow.transactions.insertIfAbsent(tx);
    if (!inserted) {
      const existing = await uow.transactions.findByIdempotency(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
      if (existing.length === 0 || existing.some((e) => !e.matchesPayload(tx.payloadHash))) {
        throw new IdempotencyConflictError(cmd.idempotencyKey);
      }
      this.metrics.duplicateDetected(ctx.source === 'sqs' ? 'sqs' : 'http');
      const first = existing[0];
      return this.toResult(first, first.observedBalance ?? wallet.balance, true);
    }

    // 4. Business rules, ledger, outbox.
    await this.apply(uow, wallet, tx, ctx);
    if (ctx.inbox) await uow.inbox.markProcessed(ctx.inbox.consumerName, ctx.inbox.messageId, this.clock.now());
    return this.toResult(tx, tx.observedBalance ?? wallet.balance, false);
  }

  /** Applies business rules to a transaction that is PENDING or PENDING_REFERENCE. Wallet must be locked. */
  async apply(uow: UnitOfWork, wallet: Wallet, tx: WagerTransaction, ctx: ProcessContext): Promise<void> {
    const now = this.clock.now();
    const wasPending = tx.status === S.Pending;
    if (wallet.playerId !== tx.playerId) return this.reject(uow, wallet, tx, FailureCode.WalletMismatch, ctx);
    if (tx.money.currency !== wallet.currency) return this.reject(uow, wallet, tx, FailureCode.CurrencyMismatch, ctx);

    let ref: WagerTransaction | undefined;
    if (tx.requiresReference() || tx.referenceExternalTransactionId) {
      const res = await this.resolveReference(uow, tx);
      if (res.kind === 'rejected') return this.reject(uow, wallet, tx, res.code, ctx);
      if (res.kind === 'pending') return this.pendingReference(uow, wallet, tx, ctx, wasPending);
      ref = res.ref;
    }

    const mctx = (): { entryId: string; transactionId: string; at: Date } => ({ entryId: this.ids.next(), transactionId: tx.id, at: now });
    switch (tx.kind) {
      case K.Loss:
        return this.finish(uow, wallet, tx, ref, undefined, ctx);
      case K.Bet: {
        if (!wallet.canDebit(tx.money)) return this.reject(uow, wallet, tx, FailureCode.InsufficientFunds, ctx);
        return this.finish(uow, wallet, tx, ref, this.move(wallet, LedgerDirection.Debit, tx, mctx()), ctx);
      }
      case K.Win:
        return this.finish(uow, wallet, tx, ref, this.move(wallet, LedgerDirection.Credit, tx, mctx()), ctx);
      case K.Refund: {
        if (await uow.transactions.hasProcessedReversalOf(ref!.id)) return this.reject(uow, wallet, tx, FailureCode.AlreadyReversed, ctx);
        return this.finish(uow, wallet, tx, ref, this.move(wallet, LedgerDirection.Credit, tx, mctx()), ctx);
      }
      case K.Rollback: {
        if (await uow.transactions.hasProcessedReversalOf(ref!.id)) return this.reject(uow, wallet, tx, FailureCode.AlreadyReversed, ctx);
        const direction = tx.ledgerDirectionFor(ref);
        if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
          return this.reject(uow, wallet, tx, FailureCode.ReversalInsufficientFunds, ctx);
        }
        return this.finish(uow, wallet, tx, ref, this.move(wallet, direction, tx, mctx()), ctx);
      }
      default:
        return this.reject(uow, wallet, tx, FailureCode.InternalPermanentError, ctx);
    }
  }

  private move(wallet: Wallet, direction: LedgerDirection, tx: WagerTransaction, m: { entryId: string; transactionId: string; at: Date }) {
    return direction === LedgerDirection.Debit ? wallet.debit(tx.money, m) : wallet.credit(tx.money, m);
  }

  private async resolveReference(uow: UnitOfWork, tx: WagerTransaction): Promise<RefResolution> {
    const ref = await uow.transactions.findByExternal(tx.providerId, tx.referenceExternalTransactionId!);
    if (!ref) return { kind: 'pending' };
    if (ref.id === tx.id) return { kind: 'rejected', code: FailureCode.ReferenceMismatch };
    // Same provider is guaranteed by the lookup; check player, wallet, currency and round.
    if (ref.playerId !== tx.playerId || ref.walletId !== tx.walletId || ref.money.currency !== tx.money.currency || ref.roundId !== tx.roundId) {
      return { kind: 'rejected', code: FailureCode.ReferenceMismatch };
    }
    const allowed: Record<string, K[]> = {
      [K.Win]: [K.Bet], [K.Loss]: [K.Bet], [K.Refund]: [K.Bet], [K.Rollback]: [K.Bet, K.Win, K.Refund],
    };
    if (!(allowed[tx.kind] ?? []).includes(ref.kind)) return { kind: 'rejected', code: FailureCode.ReferenceKindNotAllowed };
    if (ref.status === S.PendingReference || ref.status === S.Pending) return { kind: 'pending' };
    if (ref.status !== S.Processed) return { kind: 'rejected', code: FailureCode.ReferenceNotProcessed };
    if (tx.requiresReference() && !ref.money.equals(tx.money)) return { kind: 'rejected', code: FailureCode.ReferenceAmountMismatch };
    return { kind: 'found', ref };
  }

  private async pendingReference(uow: UnitOfWork, wallet: Wallet, tx: WagerTransaction, ctx: ProcessContext, first: boolean): Promise<void> {
    const now = this.clock.now();
    tx.recordPendingAttempt();
    const p = this.retryPolicy;
    const expired = tx.pendingAttempts >= p.maxAttempts || now.getTime() - tx.createdAt.getTime() >= p.ttlMs;
    if (expired) return this.reject(uow, wallet, tx, FailureCode.ReferenceNotFound, ctx);
    const delay = Math.min(p.baseDelayMs * 2 ** (tx.pendingAttempts - 1), p.maxDelayMs);
    tx.markPendingReference(new Date(now.getTime() + delay), wallet.balance);
    await uow.transactions.save(tx);
    if (first) await uow.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, this.eventCtx(ctx))));
    this.metrics.transactionResult(tx.kind, tx.status);
    if (!first) this.metrics.retry('reference');
  }

  private async finish(uow: UnitOfWork, wallet: Wallet, tx: WagerTransaction, ref: WagerTransaction | undefined,
    entry: ReturnType<Wallet['debit']> | undefined, ctx: ProcessContext): Promise<void> {
    const now = this.clock.now();
    tx.markProcessed(ref?.id, now, wallet.balance);
    await uow.transactions.save(tx);
    if (entry) {
      await uow.wallets.updateBalance(wallet, wallet.version - 1);
      await uow.ledger.append(entry);
    }
    await uow.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, this.eventCtx(ctx))));
    if (entry) await uow.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, this.eventCtx(ctx))));
    this.metrics.transactionResult(tx.kind, tx.status);
  }

  private async reject(uow: UnitOfWork, wallet: Wallet, tx: WagerTransaction, code: FailureCode, ctx: ProcessContext): Promise<void> {
    tx.reject(code, this.clock.now(), wallet.balance);
    await uow.transactions.save(tx);
    await uow.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, this.eventCtx(ctx))));
    this.metrics.transactionResult(tx.kind, tx.status);
  }

  private eventCtx(ctx: ProcessContext): EventContext {
    return { eventId: this.ids.next(), correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: this.clock.now() };
  }

  toResult(tx: WagerTransaction, balance: Money | undefined, replay: boolean): TransactionResult {
    return {
      transactionId: tx.id, status: tx.status, balance: (balance ?? Money.zero(tx.money.currency)).toJSON(),
      failureCode: tx.failureCode, providerAction: tx.failureCode ? FAILURE_ACTION[tx.failureCode] : undefined, idempotentReplay: replay,
    };
  }
}
