import { WagerTransactionStatus as S } from './domain/wager-transaction.js';
import { FailureCode } from './domain/failure-code.js';
import { DomainError, TransientInfrastructureError } from './domain/erros.js';
import { AppLogger, Clock, IdGenerator, UnitOfWorkRunner } from './ports.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.js';

/** Re-evaluates PENDING_REFERENCE transactions whose backoff elapsed. Safe with N concurrent workers. */
export class ReferenceRetryService {
  constructor(
    private readonly runner: UnitOfWorkRunner, private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly clock: Clock, private readonly ids: IdGenerator, private readonly logger: AppLogger,
  ) {}

  async runOnce(limit = 50, concurrency = 8): Promise<number> {
    const due = await this.runner.run((uow) => uow.transactions.findDueForReferenceRetry(this.clock.now(), limit));
    let handled = 0;
    const queue = [...due];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (await this.retryOne(item.id, item.walletId)) handled++;
      }
    });
    await Promise.all(workers);
    return handled;
  }

  private async retryOne(id: string, walletId: string): Promise<boolean> {
    try {
      return await this.runner.run(async (uow) => {
        // Same lock order as the main flow: wallet first, then the transaction row.
        const wallet = await uow.wallets.findByIdForUpdate(walletId);
        const tx = await uow.transactions.findByIdForUpdate(id);
        const now = this.clock.now();
        if (!wallet || !tx || tx.status !== S.PendingReference || !tx.nextAttemptAt || tx.nextAttemptAt > now) return false; // another worker won
        await this.useCase.apply(uow, wallet, tx, { correlationId: this.ids.next(), source: 'retry', causationId: tx.id });
        return true;
      });
    } catch (e) {
      if (e instanceof TransientInfrastructureError) { this.logger.warn('reference retry deferred (transient)', { transactionId: id }); return false; }
      if (e instanceof DomainError) {
        // Permanent, non-business error: park it as FAILED (terminal, auditable) in its own transaction.
        this.logger.error('reference retry failed permanently', { transactionId: id, code: e.code });
        try {
          await this.runner.run(async (uow) => {
            await uow.wallets.findByIdForUpdate(walletId);
            const tx = await uow.transactions.findByIdForUpdate(id);
            if (tx && tx.status === S.PendingReference) { tx.fail(FailureCode.InternalPermanentError, this.clock.now()); await uow.transactions.save(tx); }
          });
        } catch (inner) { this.logger.error('could not mark transaction FAILED', { transactionId: id }); }
        return true;
      }
      this.logger.error('reference retry error', { transactionId: id, error: (e as Error).message });
      return false;
    }
  }
}
