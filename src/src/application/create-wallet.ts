import { Money, MoneyProps } from './domain/money.js';
import { Wallet } from './domain/wallet.js';
import { WagerTransaction, WagerTransactionKind as K } from './domain/wager-transaction.js';
import { OutboxMessage } from './domain/outbox-message.js';
import { WalletBalanceChanged } from './domain/events/integration-event.js';
import { ValidationError, WalletAlreadyExistsError } from './domain/erros.js';
import { Clock, IdGenerator, UnitOfWorkRunner } from './ports.js';

export const INTERNAL_PROVIDER = 'internal';

export class CreateWalletUseCase {
  constructor(private readonly runner: UnitOfWorkRunner, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async execute(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string) {
    const initial = Money.from(input.initialBalance);
    if (initial.isNegative()) throw new ValidationError('initialBalance cannot be negative');
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: input.playerId, initialBalance: initial, now });

    await this.runner.run(async (uow) => {
      if (!(await uow.wallets.insert(wallet))) throw new WalletAlreadyExistsError();
      if (initial.isPositive()) {
        // Internal OPENING transaction + CREDIT ledger entry + outbox event, all in the same SQL transaction.
        const tx = WagerTransaction.create({
          id: this.ids.next(), providerId: INTERNAL_PROVIDER, externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`, walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening',
          gameId: 'opening', kind: K.Opening, money: initial, now,
        });
        await uow.transactions.insertIfAbsent(tx);
        tx.markProcessed(undefined, now, wallet.balance);
        await uow.transactions.save(tx);
        const entry = wallet.openingEntry({ entryId: this.ids.next(), transactionId: tx.id, at: now })!;
        await uow.ledger.append(entry);
        await uow.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry,
          { eventId: this.ids.next(), correlationId, occurredAt: now })));
      }
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
