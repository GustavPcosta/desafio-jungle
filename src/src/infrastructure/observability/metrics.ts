import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { MetricsPort } from '../../application/ports.js';

export class PromMetrics implements MetricsPort {
  readonly registry = new Registry();
  private readonly tx = new Counter({ name: 'wager_transactions_total', help: 'Transactions by kind and resulting status', labelNames: ['kind', 'status'], registers: [this.registry] });
  private readonly dup = new Counter({ name: 'wager_duplicates_detected_total', help: 'Duplicate submissions detected', labelNames: ['source'], registers: [this.registry] });
  private readonly conflicts = new Counter({ name: 'wager_idempotency_conflicts_total', help: 'Same key with different payload', registers: [this.registry] });
  private readonly retries = new Counter({ name: 'wager_retries_total', help: 'Retries by component', labelNames: ['component'], registers: [this.registry] });
  private readonly dlq = new Counter({ name: 'wager_dlq_messages_total', help: 'Messages sent to DLQ', labelNames: ['reason'], registers: [this.registry] });
  private readonly lockWaitH = new Histogram({ name: 'wager_wallet_lock_wait_seconds', help: 'Time waiting for the wallet row lock', buckets: [0.001, 0.005, 0.025, 0.1, 0.5, 1, 5], registers: [this.registry] });
  private readonly lockC = new Counter({ name: 'wager_wallet_lock_contention_total', help: 'Wallet lock acquisitions that had to wait (>25ms)', registers: [this.registry] });
  private readonly dur = new Histogram({ name: 'wager_processing_duration_seconds', help: 'End-to-end processing latency', labelNames: ['source'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [this.registry] });
  private readonly lag = new Gauge({ name: 'wager_outbox_lag_seconds', help: 'Age of the oldest unpublished outbox message', registers: [this.registry] });
  private readonly pending = new Gauge({ name: 'wager_outbox_pending', help: 'Unpublished outbox messages', registers: [this.registry] });
  private readonly pub = new Counter({ name: 'wager_outbox_published_total', help: 'Outbox messages published', registers: [this.registry] });
  private readonly recon = new Counter({ name: 'wager_reconciliation_divergences_total', help: 'Wallets whose stored balance differs from the ledger', registers: [this.registry] });
  constructor(defaults = true) { if (defaults) collectDefaultMetrics({ register: this.registry }); }
  transactionResult(kind: string, status: string) { this.tx.inc({ kind, status }); }
  duplicateDetected(source: 'http' | 'sqs' | 'inbox') { this.dup.inc({ source }); }
  idempotencyConflict() { this.conflicts.inc(); }
  retry(component: 'reference' | 'outbox' | 'sqs') { this.retries.inc({ component }); }
  dlqMessage(reason: string) { this.dlq.inc({ reason }); }
  lockWait(s: number) { this.lockWaitH.observe(s); }
  lockContention() { this.lockC.inc(); }
  processingDuration(source: string, s: number) { this.dur.observe({ source }, s); }
  outboxLag(s: number, pending: number) { this.lag.set(s); this.pending.set(pending); }
  outboxPublished() { this.pub.inc(); }
  reconciliationDivergence() { this.recon.inc(); }
}

export class NoopMetrics implements MetricsPort {
  transactionResult() {} duplicateDetected() {} idempotencyConflict() {} retry() {} dlqMessage() {} lockWait() {} lockContention() {}
  processingDuration() {} outboxLag() {} outboxPublished() {} reconciliationDivergence() {}
}
