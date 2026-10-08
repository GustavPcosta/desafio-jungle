import { Money } from './money.js';
import { InvariantViolationError } from './erros.js';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection;
  money: Money; balanceBefore: Money; balanceAfter: Money; createdAt: Date;
}

/** Immutable by construction: no setters, no transition methods, all fields readonly. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const e = new WalletLedgerEntry(props.id, props.walletId, props.transactionId, props.direction,
      props.money, props.balanceBefore, props.balanceAfter, props.createdAt);
    if (!e.money.isPositive()) throw new InvariantViolationError('ledger entry amount must be positive');
    if (e.balanceAfter.isNegative()) throw new InvariantViolationError('ledger entry cannot produce a negative balance');
    if (!e.isBalanced()) throw new InvariantViolationError('ledger entry arithmetic does not balance');
    return e;
  }

  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s.id, s.walletId, s.transactionId, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}