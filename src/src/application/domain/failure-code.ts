/**
 * Stable, machine-readable failure taxonomy. `action` tells the provider what to do:
 *  - GIVE_UP:      business outcome is final for this operation (do not resend)
 *  - FIX_PAYLOAD:  the operation is inconsistent with the referenced data; correct it and send a NEW idempotency key
 *  - RESUBMIT_LATER: precondition missing; resend (new idempotency key) after the precondition exists
 *  - RETRY_SAME_KEY: transient; resend with the SAME key
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  WalletMismatch = 'WALLET_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
}

export type ProviderAction = 'GIVE_UP' | 'FIX_PAYLOAD' | 'RESUBMIT_LATER' | 'RETRY_SAME_KEY';

export const FAILURE_ACTION: Record<FailureCode, ProviderAction> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalInsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReferenceNotFound]: 'RESUBMIT_LATER',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceKindNotAllowed]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.WalletMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InternalPermanentError]: 'GIVE_UP',
};
