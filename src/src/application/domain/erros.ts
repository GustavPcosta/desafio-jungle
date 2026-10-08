export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class InvalidMoneyError extends DomainError {
  constructor(message: string) { super('INVALID_MONEY', message); }
}
export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) { super('CURRENCY_MISMATCH', `Currency mismatch: ${a} vs ${b}`); }
}
export class InsufficientFundsError extends DomainError {
  constructor() { super('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient'); }
}
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) { super('INVALID_TRANSACTION_STATE', message); }
}
export class InvariantViolationError extends DomainError {
  constructor(message: string) { super('INVARIANT_VIOLATION', message); }
}
/** Same idempotency key (or provider+externalId) with a different payload. */
export class IdempotencyConflictError extends DomainError {
  constructor(key: string) { super('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" was already used with a different payload`); }
}
export class WalletNotFoundError extends DomainError {
  constructor(id: string) { super('WALLET_NOT_FOUND', `Wallet ${id} not found`); }
}
export class WalletAlreadyExistsError extends DomainError {
  constructor() { super('WALLET_ALREADY_EXISTS', 'A wallet for this player and currency already exists'); }
}
export class NotFoundError extends DomainError {
  constructor(what: string) { super('NOT_FOUND', `${what} not found`); }
}
export class ValidationError extends DomainError {
  constructor(message: string, public readonly details?: unknown) { super('VALIDATION_ERROR', message); }
}
/** Retryable infrastructure failure (db/sqs unavailable, lock timeout, deadlock...). */
export class TransientInfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); this.name = 'TransientInfrastructureError'; }
}
/** Message can never succeed (malformed, payload mismatch for same messageId...). */
export class PermanentMessageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PermanentMessageError'; }
}
