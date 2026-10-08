import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, ReceiveMessageCommand, SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppLogger, MetricsPort } from '../../application/ports.js';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.js';
import {
  IdempotencyConflictError, InvalidMoneyError, PermanentMessageError, TransientInfrastructureError, ValidationError, WalletNotFoundError,
} from '../../application/domain/erros.js';
import { canonicalJson } from '../../application/domain/wager-transaction.js';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const moneySchema = z.object({ amount: z.string(), currency: z.string() }).strict();
export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: z.object({
    providerId: z.string().min(1), externalTransactionId: z.string().min(1), idempotencyKey: z.string().min(1).max(255),
    playerId: z.string().uuid(), walletId: z.string().uuid(), roundId: z.string().min(1), gameId: z.string().min(1),
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']), // OPENING is internal: rejected by schema
    money: moneySchema, referenceExternalTransactionId: z.string().min(1).optional(),
  }).strict(),
});

type Decision = { kind: 'ack' } | { kind: 'dlq'; reason: string } | { kind: 'retry' };

export class WagerConsumer {
  private stopping = false;
  private abort = new AbortController();
  private loop?: Promise<void>;
  private inFlight = 0;

  constructor(
    private readonly sqs: SQSClient, private readonly queueUrl: string, private readonly dlqUrl: string,
    private readonly useCase: ProcessWagerTransactionUseCase, private readonly metrics: MetricsPort, private readonly logger: AppLogger,
    private readonly opts: { maxReceiveCount: number; waitTimeSeconds: number } = { maxReceiveCount: 5, waitTimeSeconds: 5 },
  ) {}

  start(): void { this.loop = this.run(); }

  /** SIGTERM: stop polling, let in-flight messages finish (commit + ack), hand unstarted ones back. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[] = [];
      try {
        const res = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: this.opts.waitTimeSeconds,
          AttributeNames: ['All'], VisibilityTimeout: 60,
        }), { abortSignal: this.abort.signal });
        messages = res.Messages ?? [];
      } catch (e) {
        if (this.stopping) break;
        this.logger.warn('sqs receive failed', { error: (e as Error).message });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await this.handleBatch(messages);
    }
  }

  /** FIFO: messages of one group are processed sequentially, different groups in parallel. */
  async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const g = m.Attributes?.MessageGroupId ?? 'default';
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    await Promise.all([...groups.values()].map((g) => this.handleGroup(g)));
  }

  private async handleGroup(group: Message[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      if (this.stopping) { await this.releaseAll(group.slice(i)); return; }
      this.inFlight++;
      let decision: Decision;
      try { decision = await this.processOne(group[i]); } finally { this.inFlight--; }
      try {
        await this.settle(group[i], decision);
      } catch (e) {
        this.logger.error('failed to settle sqs message', { error: (e as Error).message });
        decision = { kind: 'retry' };
      }
      if (decision.kind === 'retry') { await this.releaseAll(group.slice(i + 1)); return; } // keep per-group order
    }
  }

  private async processOne(m: Message): Promise<Decision> {
    let parsed: z.infer<typeof wagerMessageSchema>;
    try { parsed = wagerMessageSchema.parse(JSON.parse(m.Body ?? '')); }
    catch (e) { this.logger.warn('malformed sqs message', { messageId: m.MessageId, reason: 'SCHEMA' }); return { kind: 'dlq', reason: 'MALFORMED_MESSAGE' }; }

    const d = parsed.data;
    const payloadHash = createHash('sha256').update(canonicalJson(d)).digest('hex');
    try {
      const r = await this.useCase.execute(
        { idempotencyKey: d.idempotencyKey, providerId: d.providerId, externalTransactionId: d.externalTransactionId, playerId: d.playerId,
          walletId: d.walletId, roundId: d.roundId, gameId: d.gameId, kind: d.kind as any, money: d.money,
          referenceExternalTransactionId: d.referenceExternalTransactionId },
        { correlationId: parsed.messageId, source: 'sqs', causationId: parsed.messageId, inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash } });
      this.logger.info('sqs message processed', { messageId: parsed.messageId, transactionId: r.transactionId, walletId: d.walletId, providerId: d.providerId, status: r.status });
      return { kind: 'ack' }; // PROCESSED, PENDING_REFERENCE and REJECTED (business outcome, persisted) are all terminal for the queue
    } catch (e) {
      if (e instanceof PermanentMessageError) return { kind: 'dlq', reason: e.code };
      if (e instanceof InvalidMoneyError || e instanceof ValidationError) return { kind: 'dlq', reason: 'INVALID_PAYLOAD' };
      if (e instanceof IdempotencyConflictError) return { kind: 'dlq', reason: 'IDEMPOTENCY_CONFLICT' };
      if (e instanceof WalletNotFoundError) return { kind: 'dlq', reason: 'WALLET_NOT_FOUND' }; // nothing persisted: keep for investigation
      const receives = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
      this.logger.warn('sqs message failed (transient)', { messageId: parsed.messageId, receiveCount: receives, error: (e as Error).message });
      if (!(e instanceof TransientInfrastructureError)) this.logger.error('unexpected error while processing', { messageId: parsed.messageId, error: (e as Error).message });
      if (receives >= this.opts.maxReceiveCount) return { kind: 'dlq', reason: 'MAX_RECEIVE_COUNT_EXCEEDED' };
      this.metrics.retry('sqs');
      await this.backoff(m, receives);
      return { kind: 'retry' };
    }
  }

  private async settle(m: Message, d: Decision): Promise<void> {
    if (d.kind === 'retry') return;
    if (d.kind === 'dlq') {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.dlqUrl, MessageBody: m.Body ?? '', MessageGroupId: m.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: `${m.MessageId}:${m.Attributes?.ApproximateReceiveCount ?? '1'}`,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: d.reason } },
      }));
      this.metrics.dlqMessage(d.reason);
      this.logger.error('message moved to DLQ', { messageId: m.MessageId, reason: d.reason });
    }
    // ack only after the DB commit (processOne returned) — and, for DLQ, after the DLQ accepted the copy
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle! }));
  }

  private async backoff(m: Message, receives: number): Promise<void> {
    const seconds = Math.min(2 ** (receives - 1) * 2, 300);
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: seconds })).catch(() => undefined);
  }

  private async releaseAll(ms: Message[]): Promise<void> {
    await Promise.all(ms.map((m) => this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 })).catch(() => undefined)));
  }
}