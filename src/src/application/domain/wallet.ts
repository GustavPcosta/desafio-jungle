import { Money } from './money.js';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from './erros.js';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry.js';

export interface WalletState {
  id: string; playerId: string; currency: string; balance: Money; version: number; createdAt: Date; updatedAt: Date;
}
export interface MovementContext { entryId: string; transactionId: string; at: Date; }

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvariantViolationError('initial balance cannot be negative');
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  /** Ledger entry that documents the opening balance (OPENING). Does not change balance/version. */
  openingEntry(ctx: MovementContext): WalletLedgerEntry | undefined {
    if (!this._balance.isPositive()) return undefined;
    return WalletLedgerEntry.create({
      id: ctx.entryId, walletId: this.id, transactionId: ctx.transactionId, direction: LedgerDirection.Credit,
      money: this._balance, balanceBefore: Money.zero(this.currency), balanceAfter: this._balance, createdAt: ctx.at,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Applies a debit and returns the matching ledger entry (balance + ledger change together). */
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!this.canDebit(money)) throw new InsufficientFundsError();
    return this.move(LedgerDirection.Debit, money, this._balance.subtract(money), ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.move(LedgerDirection.Credit, money, this._balance.add(money), ctx);
  }

  private move(direction: LedgerDirection, money: Money, after: Money, ctx: MovementContext): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId, walletId: this.id, transactionId: ctx.transactionId, direction, money,
      balanceBefore: this._balance, balanceAfter: after, createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1; // only incremented when the balance changes
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
