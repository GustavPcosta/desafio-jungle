const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));

export interface AppConfig {
  port: number; databaseUrl: string; dbPoolMax: number; lockTimeoutMs: number;
  sqs: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string;
         wagerQueue: string; wagerDlq: string; eventsQueue: string; maxReceiveCount: number; waitTimeSeconds: number; };
  workers: { consumer: boolean; outboxPublisher: boolean; referenceRetry: boolean; outboxIntervalMs: number; retryIntervalMs: number; };
  retryPolicy: { maxAttempts: number; ttlMs: number; baseDelayMs: number; maxDelayMs: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    dbPoolMax: int(env.DB_POOL_MAX, 20),
    lockTimeoutMs: int(env.DB_LOCK_TIMEOUT_MS, 5000),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566', region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      wagerQueue: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo', wagerDlq: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      eventsQueue: env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo', maxReceiveCount: int(env.SQS_MAX_RECEIVE_COUNT, 5),
      waitTimeSeconds: int(env.SQS_WAIT_TIME_SECONDS, 5),
    },
    workers: {
      consumer: bool(env.WORKER_SQS_CONSUMER, true), outboxPublisher: bool(env.WORKER_OUTBOX_PUBLISHER, true),
      referenceRetry: bool(env.WORKER_REFERENCE_RETRY, true), outboxIntervalMs: int(env.OUTBOX_INTERVAL_MS, 500),
      retryIntervalMs: int(env.REFERENCE_RETRY_INTERVAL_MS, 2000),
    },
    retryPolicy: {
      maxAttempts: int(env.PENDING_REF_MAX_ATTEMPTS, 10), ttlMs: int(env.PENDING_REF_TTL_MS, 3_600_000),
      baseDelayMs: int(env.PENDING_REF_BASE_DELAY_MS, 2000), maxDelayMs: int(env.PENDING_REF_MAX_DELAY_MS, 300_000),
    },
  };
}
