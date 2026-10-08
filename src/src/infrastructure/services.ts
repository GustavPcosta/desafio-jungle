import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from './config/config.js';
import { buildOrmConfig } from './persistence/orm-config.js';
import { PgUnitOfWorkRunner } from './persistence/pg-runner.js';
import { SystemClock, UuidV7Generator } from './ids.js';
import { PromMetrics } from './observability/metrics.js';
import { JsonLogger } from './observability/logger.js';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.js';
import { CreateWalletUseCase } from '../application/create-wallet.js';
import { QueryService } from '../application/queries.js';
import { ReferenceRetryService } from '../application/reference-retry.js';
import { OutboxPublisherService } from '../application/outbox-publisher.js';
import { AppLogger, Clock, EventPublisher, IdGenerator, MetricsPort, UnitOfWorkRunner } from '../application/ports.js';

export interface Services {
  orm: MikroORM; runner: UnitOfWorkRunner; clock: Clock; ids: IdGenerator; metrics: PromMetrics; logger: AppLogger;
  process: ProcessWagerTransactionUseCase; createWallet: CreateWalletUseCase; queries: QueryService;
  referenceRetry: ReferenceRetryService; outboxService: (publisher: EventPublisher) => OutboxPublisherService;
}

/** Composition root shared by the Nest app, the integration tests and the multi-process test workers. */
export async function createServices(cfg: AppConfig, overrides: { metrics?: PromMetrics; logger?: AppLogger } = {}): Promise<Services> {
  const orm = await MikroORM.init(buildOrmConfig(cfg.databaseUrl));
  const runner = new PgUnitOfWorkRunner(orm, cfg.lockTimeoutMs);
  const clock = new SystemClock(); const ids = new UuidV7Generator();
  const metrics = overrides.metrics ?? new PromMetrics();
  const logger = overrides.logger ?? new JsonLogger();
  const process = new ProcessWagerTransactionUseCase(runner, clock, ids, metrics, logger, cfg.retryPolicy);
  return {
    orm, runner, clock, ids, metrics, logger, process,
    createWallet: new CreateWalletUseCase(runner, clock, ids),
    queries: new QueryService(runner, metrics, logger),
    referenceRetry: new ReferenceRetryService(runner, process, clock, ids, logger),
    outboxService: (publisher) => new OutboxPublisherService(runner, publisher, clock, metrics, logger),
  };
}
