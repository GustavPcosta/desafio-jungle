import { AppLogger, Clock, EventPublisher, MetricsPort, UnitOfWorkRunner } from './ports.js';

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of concurrent
 * publishers split the work without blocking each other. Delivery is at-least-once: if the process dies after
 * the broker accepted a message but before the commit, another publisher re-sends it (consumers dedupe by eventId).
 */
export class OutboxPublisherService {
  constructor(
    private readonly runner: UnitOfWorkRunner, private readonly publisher: EventPublisher, private readonly clock: Clock,
    private readonly metrics: MetricsPort, private readonly logger: AppLogger,
  ) {}

  async runOnce(batchSize = 50): Promise<number> {
    const published = await this.runner.run(async (uow) => {
      const batch = await uow.outbox.lockDue(this.clock.now(), batchSize);
      let ok = 0;
      for (const msg of batch) {
        try {
          await this.publisher.publish(msg);
          msg.markPublished(this.clock.now());
          this.metrics.outboxPublished();
          ok++;
        } catch (e) {
          msg.scheduleRetry(this.clock.now());
          this.metrics.retry('outbox');
          this.logger.warn('outbox publish failed; retry scheduled', { eventId: msg.id, attempts: msg.attempts, error: (e as Error).message });
        }
        await uow.outbox.save(msg);
      }
      return ok;
    });
    return published;
  }

  async refreshLagMetric(): Promise<void> {
    const s = await this.runner.run((uow) => uow.outbox.stats());
    this.metrics.outboxLag(s.oldestAgeSeconds, s.pending);
  }
}
