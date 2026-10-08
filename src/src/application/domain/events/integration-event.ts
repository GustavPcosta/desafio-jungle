import { LedgerDirection, WalletLedgerEntry } from '../ledger-entry.js';
import { MoneyProps } from '../money.js';
import { Wallet } from '../wallet.js';
import { WagerTransaction } from '../wager-transaction.js';

export interface IntegrationEventProps<T> {
  eventId: string; aggregateId: string; correlationId: string; causationId?: string; occurredAt: Date; data: T;
}
export interface EventContext { eventId: string; correlationId: string; causationId?: string; occurredAt: Date; }

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string; readonly aggregateId: string; readonly correlationId: string;
  readonly causationId?: string; readonly occurredAt: Date; readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId; this.aggregateId = props.aggregateId; this.correlationId = props.correlationId;
    this.causationId = props.causationId; this.occurredAt = props.occurredAt; this.data = Object.freeze({ ...props.data });
  }

  /** Serialized envelope stored in the outbox payload. */
  toJSON() {
    return {
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId, correlationId: this.correlationId,
      causationId: this.causationId, occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data as T,
    };
  }
}

const base = (aggregateId: string, ctx: EventContext) => ({
  eventId: ctx.eventId, aggregateId, correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: ctx.occurredAt,
});

export interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({ ...base(wallet.id, ctx), data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    } });
  }
}

export interface WagerTransactionEventData {
  transactionId: string; providerId: string; externalTransactionId: string; walletId: string; playerId: string; roundId: string;
  kind: string; status: string; money: MoneyProps; failureCode?: string; referenceExternalTransactionId?: string;
}
function txData(t: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: t.id, providerId: t.providerId, externalTransactionId: t.externalTransactionId, walletId: t.walletId,
    playerId: t.playerId, roundId: t.roundId, kind: t.kind, status: t.status, money: t.money.toJSON(),
    failureCode: t.failureCode, referenceExternalTransactionId: t.referenceExternalTransactionId,
  };
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext) { return new WagerTransactionProcessed({ ...base(t.walletId, ctx), data: txData(t) }); }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext) { return new WagerTransactionRejected({ ...base(t.walletId, ctx), data: txData(t) }); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext) { return new WagerTransactionPendingReference({ ...base(t.walletId, ctx), data: txData(t) }); }
}
