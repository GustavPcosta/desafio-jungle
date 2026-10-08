import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './erros.js';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
// Strict decimal grammar: optional '-', digits, optional 1..2 fraction digits. No exponent, NaN, Infinity, spaces.
const AMOUNT_RE = /^-?\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string; // decimal string, always 2 fraction digits when serialized
  currency: string; // ISO-4217
}

/** Immutable monetary value. Exact decimal arithmetic, fixed scale of 2. Never uses JS number. */
export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    if (typeof props.currency !== 'string' || !CURRENCY_RE.test(props.currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
    if (!AMOUNT_RE.test(props.amount)) {
      throw new InvalidMoneyError(`invalid amount "${props.amount}": expected decimal with at most 2 fraction digits`);
    }
    return new Money(new D(props.amount).toDecimalPlaces(2), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }
  negate(): Money { return new Money(this.value.negated(), this.currency); }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan(0); }
  isNegative(): boolean { return this.value.lessThan(0); }
  isLessThan(other: Money): boolean { this.assertSameCurrency(other); return this.value.lessThan(other.value); }
  equals(other: Money): boolean { return this.currency === other.currency && this.value.equals(other.value); }

  toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  toString(): string { return `${this.value.toFixed(2)} ${this.currency}`; }
  /** Plain decimal string with scale 2 (used for persistence in NUMERIC(20,2)). */
  get amount(): string { return this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
