import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Services } from '../../infrastructure/services.js';
import { ValidationError } from '../../application/domain/erros.js';
import { SERVICES, HEALTH } from './tokens.js';
import { WagerTransactionKind } from '../../application/domain/wager-transaction.js';

const uuid = z.string().uuid();
const money = z.object({ amount: z.string(), currency: z.string() });
const createWalletSchema = z.object({ playerId: uuid, initialBalance: money });
const submitSchema = z.object({
  providerId: z.string().min(1).max(128), externalTransactionId: z.string().min(1).max(128), playerId: uuid, walletId: uuid,
  roundId: z.string().min(1), gameId: z.string().min(1),
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']), // OPENING cannot be submitted through the API
  money, referenceExternalTransactionId: z.string().min(1).max(128).optional(),
});

const STATUS_HTTP: Record<string, number> = { PROCESSED: 200, PENDING_REFERENCE: 202, PENDING: 202, REJECTED: 422, FAILED: 500 };

@Controller()
export class WalletController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Post('wallets') @HttpCode(201)
  create(@Body() body: unknown, @Headers('x-correlation-id') cid?: string) {
    const input = createWalletSchema.parse(body);
    return this.s.createWallet.execute(input, cid ?? randomUUID());
  }
  @Get('wallets/:walletId')
  get(@Param('walletId') id: string) { return this.s.queries.getWallet(uuid.parse(id)); }

  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.s.queries.getLedger(uuid.parse(id), cursor, limit === undefined ? 50 : Number(limit));
  }
  @Post('wallets/:walletId/reconciliation') @HttpCode(200)
  reconcile(@Param('walletId') id: string) { return this.s.queries.reconcile(uuid.parse(id)); }
}

@Controller()
export class WageringController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
               @Headers('x-correlation-id') cid: string | undefined, @Res({ passthrough: true }) res: any) {
    if (!key || key.trim() === '' || key.length > 255) throw new ValidationError('Idempotency-Key header is required (1..255 chars)');
    const p = submitSchema.parse(body);
    const correlationId = cid ?? randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    const result = await this.s.process.execute({ ...p, idempotencyKey: key, kind: p.kind as WagerTransactionKind },
      { correlationId, source: 'http' });
    res.status(STATUS_HTTP[result.status] ?? 200);
    return result;
  }
  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') id: string) { return this.s.queries.getTransaction(uuid.parse(id)); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(@Param('providerId') p: string, @Param('externalTransactionId') e: string) { return this.s.queries.getTransactionByExternal(p, e); }
}

@Controller()
export class HealthController {
  constructor(@Inject(SERVICES) private readonly s: Services, @Inject(HEALTH) private readonly readiness: () => Promise<void>) {}
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: any) {
    try { await this.readiness(); return { status: 'ok', checks: { postgres: 'up', sqs: 'up' } }; }
    catch (e) { res.status(503); return { status: 'unavailable', error: (e as Error).message }; }
  }
  @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() { return this.s.metrics.registry.metrics(); }
}
