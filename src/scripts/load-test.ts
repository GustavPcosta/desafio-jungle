/**
 * Load test against the use case with real PostgreSQL (in-process, N concurrent "clients").
 *   bun run test:load            (env: LOAD_WALLETS, LOAD_HOT_SHARE, LOAD_TOTAL, LOAD_CONCURRENCY)
 * Reports throughput, p50/p95/p99, error rate, wallet-lock contention and outbox lag, and re-checks the ledger invariant.
 */


import { randomUUID } from 'node:crypto';

import {loadConfig} from "../src/infrastructure/config/config.js"
import { createServices } from '../src/infrastructure/services.js';
import { NullLogger } from '../src/infrastructure/observability/logger.js';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/infrastructure/persistence/orm-config.js';
import os from 'node:os';

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const WALLETS = env('LOAD_WALLETS', 200), TOTAL = env('LOAD_TOTAL', 20000), CONC = env('LOAD_CONCURRENCY', 64), HOT = env('LOAD_HOT_SHARE', 0.2);
const cfg = loadConfig({ ...process.env, DB_POOL_MAX: String(Math.max(CONC, 20)) });

const mig = await MikroORM.init(buildOrmConfig(cfg.databaseUrl)); await mig.getMigrator().up(); await mig.close();
const s = await createServices(cfg, { logger: new NullLogger() });
const wallets = await Promise.all(Array.from({ length: WALLETS }, () => s.createWallet.execute({ playerId: randomUUID(), initialBalance: { amount: '1000000.00', currency: 'BRL' } }, 'load')));
const pick = () => (Math.random() < HOT ? wallets[0] : wallets[Math.floor(Math.random() * wallets.length)]); // HOT share hits ONE wallet
const lat: number[] = []; let ok = 0, rejected = 0, errors = 0, next = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next++ < TOTAL) {
    const w = pick(); const ext = randomUUID(); const kind = ['BET', 'BET', 'WIN', 'LOSS'][Math.floor(Math.random() * 4)];
    const t = performance.now();
    try {
      const r = await s.process.execute({ idempotencyKey: `load:${ext}`, providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
        roundId: 'r', gameId: 'g', kind: kind as any, money: { amount: '1.00', currency: 'BRL' } }, { correlationId: ext, source: 'http' });
      r.status === 'PROCESSED' ? ok++ : rejected++;
    } catch { errors++; }
    lat.push(performance.now() - t);
  }
}));
const secs = (performance.now() - t0) / 1000; lat.sort((a, b) => a - b);
const q = (p: number) => +lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(2);
const rows = await s.orm.em.fork().execute(`SELECT COUNT(*) AS bad FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id),0)`);
const lag = await s.runner.run((u) => u.outbox.stats());
const metrics = await s.metrics.registry.getMetricsAsJSON();
const contention = (metrics.find((m) => m.name === 'wager_wallet_lock_contention_total')as any)?.values[0]?.value ?? 0;
const report = {
  environment: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), runtime: `bun ${Bun.version}`, db: 'PostgreSQL (see README: same host, in-process clients)' },
  methodology: { wallets: WALLETS, total: TOTAL, concurrency: CONC, hotWalletShare: HOT, mix: '50% BET / 25% WIN / 25% LOSS, 1.00 BRL, unique idempotency keys' },
  throughputPerSec: +(TOTAL / secs).toFixed(1), latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) },
  processed: ok, rejected, errorRate: +(errors / TOTAL).toFixed(4), walletLockContention: contention, outboxLagSeconds: +lag.oldestAgeSeconds.toFixed(1), outboxPending: lag.pending,
  invariantViolations: Number(rows[0].bad),
};
console.log(JSON.stringify(report, null, 2));
await Bun.write('load-test-report.json', JSON.stringify(report, null, 2));
await s.orm.close();
process.exit(report.invariantViolations === 0 ? 0 : 1);
