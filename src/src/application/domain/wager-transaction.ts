import { createHash } from 'node:crypto';
import { Money, MoneyProps } from './money.js';
import { FailureCode } from './failure-code.js';
import { InvalidTransactionStateError, ValidationError } from './erros.js';
import { LedgerDirection } from './ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}

/**
 * Valid transitions:
 *   PENDING            -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE  -> PROCESSED | PENDING_REFERENCE (re-scheduled) | REJECTED | FAILED
 *   PROCESSED/REJECTED/FAILED -> (terminal: any transition is a programming error)
 */
export interface CreateWagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: Money; referenceExternalTransactionId?: string; now?: Date;
}
export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'now'> {
  payloadHash: string; createdAt: Date; status: WagerTransactionStatus;
  referenceTransactionId?: string; failureCode?: FailureCode; processedAt?: Date;
  observedBalance?: Money; pendingAttempts: number; nextAttemptAt?: Date;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256(canonicalJson(business fields)). Headers / transport metadata are excluded. Amounts are normalised to scale 2. */
export function computePayloadHash(p: {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string; roundId: string; gameId: string;
  kind: string; money: MoneyProps; referenceExternalTransactionId?: string;
}): string {
  const m = Money.from(p.money).toJSON();
  return createHash('sha256').update(canonicalJson({
    providerId: p.providerId, externalTransactionId: p.externalTransactionId, playerId: p.playerId, walletId: p.walletId,
    roundId: p.roundId, gameId: p.gameId, kind: p.kind, money: m,
    referenceExternalTransactionId: p.referenceExternalTransactionId ?? null,
  })).digest('hex');
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _pendingAttempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresRef = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresRef && !props.referenceExternalTransactionId) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new ValidationError('money.amount must be positive');
    }
    const payloadHash = computePayloadHash({ ...props, money: props.money.toJSON() });
    return new WagerTransaction(props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind, props.money,
      props.referenceExternalTransactionId, props.now ?? new Date(), WagerTransactionStatus.Pending);
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId,
      s.playerId, s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt, s.observedBalance, s.pendingAttempts, s.nextAttemptAt);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  /** Wallet balance observed when the transaction reached its latest outcome (returned on replays). */
  get observedBalance(): Money | undefined { return this._observedBalance; }
  get pendingAttempts(): number { return this._pendingAttempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }

  // ---- transitions
  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }
  /** Enters (or stays in) PENDING_REFERENCE; `nextAttemptAt` schedules the next retry. */
  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
    this._observedBalance = observedBalance;
  }
  recordPendingAttempt(): void { this.assertNotTerminal('recordPendingAttempt'); this._pendingAttempts += 1; }
  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code; this._processedAt = at; this._observedBalance = observedBalance; this._nextAttemptAt = undefined;
  }
  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code; this._processedAt = at; this._nextAttemptAt = undefined;
  }

  // ---- domain queries
  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this._status);
  }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  /** Direction of the ledger entry this transaction produces (given its resolved reference when needed). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError('ROLLBACK needs its reference to determine direction');
        // inverse of the referenced movement
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default:
        throw new InvalidTransactionStateError(`${this.kind} does not produce a ledger entry`);
    }
  }

  private assertNotTerminal(op: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`Cannot ${op}: transaction ${this.id} is already ${this._status}`);
  }
}
