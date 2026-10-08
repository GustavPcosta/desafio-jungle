import { randomBytes } from 'node:crypto';
import { Clock, IdGenerator } from '../application/ports.js';

export class SystemClock implements Clock { now(): Date { return new Date(); } }

/** UUID v7 (time-ordered): 48-bit unix ms + random. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    const b = randomBytes(16);
    let ms = BigInt(Date.now());
    for (let i = 5; i >= 0; i--) { b[i] = Number(ms & 0xffn); ms >>= 8n; }
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
