import { Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from './infrastructure/config/config.js';
import type {AppConfig} from './infrastructure/config/config.js';
import { createServices, type Services } from './infrastructure/services.js';
import { createSqsClient, resolveQueueUrl } from './infrastructure/sqs/sqs-client.js';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher.js';
import { WagerConsumer } from './infrastructure/sqs/wager-consumer.js';
import { WalletController, WageringController, HealthController } from './interfaces/http/controllers.js';
import { AllExceptionsFilter } from './interfaces/http/http-errors.js';
import { NoopAuthGuard } from './interfaces/http/auth.js';
import { SERVICES, HEALTH } from './interfaces/http/tokens.js';

const CONFIG = Symbol('CONFIG');
const SQS = Symbol('SQS');

/** Starts/stops background workers: SQS consumer, outbox publisher, PENDING_REFERENCE retry, outbox lag metric. */
@Injectable()
class WorkersLifecycle implements OnModuleInit, OnApplicationShutdown {
  private timers: Array<{ stop: () => Promise<void> }> = [];
  private consumer?: WagerConsumer;
  constructor(@Inject(SERVICES) private readonly s: Services, @Inject(CONFIG) private readonly cfg: AppConfig,
              @Inject(SQS) private readonly sqs: Awaited<ReturnType<typeof buildSqs>>) {}

  async onModuleInit() {
    const { workers } = this.cfg;
    if (workers.outboxPublisher) {
      const svc = this.s.outboxService(new SqsEventPublisher(this.sqs.client, this.sqs.eventsUrl));
      this.timers.push(this.loop('outbox-publisher', workers.outboxIntervalMs, async () => {
        let n; do { n = await svc.runOnce(); } while (n > 0); // drain, then sleep
        await svc.refreshLagMetric();
      }));
    }
    if (workers.referenceRetry) {
      this.timers.push(this.loop('reference-retry', workers.retryIntervalMs, async () => { await this.s.referenceRetry.runOnce(); }));
    }
    if (workers.consumer) {
      this.consumer = new WagerConsumer(this.sqs.client, this.sqs.wagerUrl, this.sqs.dlqUrl, this.s.process, this.s.metrics, this.s.logger,
        { maxReceiveCount: this.cfg.sqs.maxReceiveCount, waitTimeSeconds: this.cfg.sqs.waitTimeSeconds });
      this.consumer.start();
    }
  }

  private loop(name: string, intervalMs: number, fn: () => Promise<void>) {
    let stopped = false;
    const done = (async () => {
      while (!stopped) {
        try { await fn(); } catch (e) { this.s.logger.error(`${name} iteration failed`, { component: name, error: (e as Error).message }); }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    })();
    return { stop: async () => { stopped = true; await done; } };
  }

  /** Graceful shutdown on SIGTERM/SIGINT (enableShutdownHooks): finish in-flight work, release the rest, close the pool. */
  async onApplicationShutdown() {
    await this.consumer?.stop();
    await Promise.all(this.timers.map((t) => t.stop()));
    await this.s.orm.close();
  }
}

async function buildSqs(cfg: AppConfig) {
  const client = createSqsClient(cfg.sqs);
  const [wagerUrl, dlqUrl, eventsUrl] = await Promise.all([
    resolveQueueUrl(client, cfg.sqs.wagerQueue), resolveQueueUrl(client, cfg.sqs.wagerDlq), resolveQueueUrl(client, cfg.sqs.eventsQueue),
  ]);
  return { client, wagerUrl, dlqUrl, eventsUrl };
}

@Module({
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: SERVICES, inject: [CONFIG], useFactory: (cfg: AppConfig) => createServices(cfg) },
    { provide: SQS, inject: [CONFIG], useFactory: (cfg: AppConfig) => buildSqs(cfg) },
    {
      provide: HEALTH, inject: [SERVICES, SQS],
      useFactory: (s: Services, sqs: Awaited<ReturnType<typeof buildSqs>>) => async () => {
        await s.runner.ping();
        await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: sqs.wagerUrl, AttributeNames: ['QueueArn'] }));
      },
    },
    WorkersLifecycle,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
  ],
})
export class AppModule {}
