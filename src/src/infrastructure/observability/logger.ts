import { AppLogger } from '../../application/ports.js';

/** Structured JSON logs. Only an allow-list of identifier fields is emitted — never payloads or amounts-in-bulk. */
const ALLOWED = new Set(['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId', 'eventId', 'attempts', 'code',
  'error', 'difference', 'checkedEntries', 'receiveCount', 'reason', 'queue', 'component', 'count', 'status', 'port']);

export class JsonLogger implements AppLogger {
  constructor(private readonly base: Record<string, unknown> = {}, private readonly out: (line: string) => void = (l) => process.stdout.write(l + '\n')) {}
  private log(level: string, msg: string, fields: Record<string, unknown> = {}) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k)) safe[k] = v;
    this.out(JSON.stringify({ level, time: new Date().toISOString(), msg, ...this.base, ...safe }));
  }
  info(m: string, f?: Record<string, unknown>) { this.log('info', m, f); }
  warn(m: string, f?: Record<string, unknown>) { this.log('warn', m, f); }
  error(m: string, f?: Record<string, unknown>) { this.log('error', m, f); }
}
export class NullLogger implements AppLogger { info() {} warn() {} error() {} }
