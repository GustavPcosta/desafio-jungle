import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/domain/erros.js';
import { UnitOfWork, UnitOfWorkRunner } from '../../application/ports.js';
import { PgUnitOfWork } from './pg-repositories.js';

// 08xxx connection, 57P01/57P03 shutdown, 53300 too many conns, 40001 serialization, 40P01 deadlock, 55P03 lock_timeout, 25006 read-only
const TRANSIENT_SQLSTATE = new Set(['57P01', '57P02', '57P03', '53300', '53400', '40001', '40P01', '55P03', '25006', '08000', '08001', '08003', '08004', '08006', '08007']);
const TRANSIENT_NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN']);

export function classifyDbError(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  const msg = String(err?.message ?? '');
  if ((err?.code && (TRANSIENT_SQLSTATE.has(err.code) || TRANSIENT_NET.has(err.code))) ||
      /Connection terminated|timeout exceeded when trying to connect|Connection lost|connect ECONN|the database system is (starting up|shutting down)/i.test(msg)) {
    return new TransientInfrastructureError(`database unavailable or contended: ${err?.code ?? msg}`, e);
  }
  return e;
}

export class PgUnitOfWorkRunner implements UnitOfWorkRunner {
  constructor(private readonly orm: MikroORM, private readonly lockTimeoutMs = 5_000) {}

  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    try {
      // A fresh fork per transaction: no shared identity map between concurrent requests.
      return await (this.orm.em.fork() as EntityManager).transactional(async (tem) => {
        await tem.execute(`SET LOCAL lock_timeout = '${Math.floor(this.lockTimeoutMs)}ms'`);
        return fn(new PgUnitOfWork(tem as EntityManager));
      });
    } catch (e) {
      throw classifyDbError(e);
    }
  }

  async ping(): Promise<void> {
    try { await (this.orm.em.fork() as EntityManager).execute('SELECT 1'); } catch (e) { throw classifyDbError(e); }
  }
}
