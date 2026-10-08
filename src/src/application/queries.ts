import { Money } from './domain/money.js';
import { NotFoundError, ValidationError } from './domain/erros.js';
import { FAILURE_ACTION } from './domain/failure-code.js';
import { AppLogger, MetricsPort, UnitOfWorkRunner } from './ports.js';
import { WagerTransaction } from './domain/wager-transaction.js';

function encodeCursor(seq: string): string { return Buffer.from(JSON.stringify({ s: seq })).toString('base64url'); }
function decodeCursor(c: string): string {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof v?.s === 'string' && /^\d+$/.test(v.s)) return v.s;
  } catch { /* fallthrough */ }
  throw new ValidationError('invalid cursor');
}

export const transactionView = (t: WagerTransaction) => ({
  transactionId: t.id, providerId: t.providerId, externalTransactionId: t.externalTransactionId, walletId: t.walletId,
  playerId: t.playerId, roundId: t.roundId, gameId: t.gameId, kind: t.kind as string, money: t.money.toJSON(), status: t.status as string,
  referenceExternalTransactionId: t.referenceExternalTransactionId, referenceTransactionId: t.referenceTransactionId,
  failureCode: t.failureCode, providerAction: t.failureCode ? FAILURE_ACTION[t.failureCode] : undefined,
  balance: t.observedBalance?.toJSON(), createdAt: t.createdAt.toISOString(), processedAt: t.processedAt?.toISOString(),
});

export class QueryService {
  constructor(private readonly runner: UnitOfWorkRunner, private readonly metrics: MetricsPort, private readonly logger: AppLogger) {}

  async getWallet(id: string) {
    const w = await this.runner.run((uow) => uow.wallets.findById(id));
    if (!w) throw new NotFoundError('Wallet');
    return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be between 1 and 200');
    const after = cursor ? decodeCursor(cursor) : undefined;
    return this.runner.run(async (uow) => {
      if (!(await uow.wallets.findById(walletId))) throw new NotFoundError('Wallet');
      const rows = await uow.ledger.page(walletId, after, limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: page.map(({ entry: e }) => ({
          id: e.id, transactionId: e.transactionId, direction: e.direction as string, money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(), createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
      };
    });
  }

  async getTransaction(id: string) {
    const t = await this.runner.run((uow) => uow.transactions.findById(id));
    if (!t) throw new NotFoundError('Transaction');
    return transactionView(t);
  }

  async getTransactionByExternal(providerId: string, externalId: string) {
    const t = await this.runner.run((uow) => uow.transactions.findByExternal(providerId, externalId));
    if (!t) throw new NotFoundError('Transaction');
    return transactionView(t);
  }

  /** Divergences are never auto-corrected: logged, counted in a metric and flagged in the response. */
  async reconcile(walletId: string) {
    const r = await this.runner.run((uow) => uow.ledger.reconcile(walletId));
    if (!r) throw new NotFoundError('Wallet');
    const stored = Money.from({ amount: r.stored, currency: r.currency });
    const calculated = Money.from({ amount: r.calculated, currency: r.currency });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('reconciliation divergence detected', { walletId, difference: difference.toString(), checkedEntries: r.entries });
    }
    return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(), consistent, checkedEntries: r.entries };
  }
}
