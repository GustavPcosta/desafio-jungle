import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  DomainError, IdempotencyConflictError, InvalidMoneyError, NotFoundError, TransientInfrastructureError, ValidationError,
  WalletAlreadyExistsError, WalletNotFoundError,
} from '../../application/domain/erros.js';

/**
 * Consistent HTTP contract for every endpoint:
 *  400 invalid payload | 404 not found | 409 conflict (idempotency / duplicate wallet)
 *  422 business rejection (body = transaction result with failureCode) | 202 accepted, pending reference
 *  503 transient infrastructure failure (retry with the SAME idempotency key) | 500 unexpected
 */
export function mapError(e: unknown): { status: number; body: { error: Record<string, unknown> }; retryAfter?: number } {
  const err = (code: string, message: string, retryable: boolean, details?: unknown) => ({ error: { code, message, retryable, ...(details ? { details } : {}) } });
  if (e instanceof ZodError) return { status: 400, body: err('VALIDATION_ERROR', 'Invalid request', false, e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))) };
  if (e instanceof InvalidMoneyError || e instanceof ValidationError) return { status: 400, body: err(e.code, e.message, false, (e as ValidationError).details) };
  if (e instanceof NotFoundError || e instanceof WalletNotFoundError) return { status: 404, body: err(e.code, e.message, false) };
  if (e instanceof IdempotencyConflictError || e instanceof WalletAlreadyExistsError) return { status: 409, body: err(e.code, e.message, false) };
  if (e instanceof TransientInfrastructureError) return { status: 503, body: err('SERVICE_UNAVAILABLE', 'Temporary failure, retry with the same Idempotency-Key', true), retryAfter: 1 };
  if (e instanceof DomainError) return { status: 422, body: err(e.code, e.message, false) };
  if (e instanceof HttpException) return { status: e.getStatus(), body: err('HTTP_ERROR', e.message, e.getStatus() >= 500) };
  return { status: 500, body: err('INTERNAL_ERROR', 'Unexpected error', true) };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const { status, body, retryAfter } = mapError(exception);
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json(body);
  }
}
