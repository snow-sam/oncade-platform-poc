import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebhookEvent } from './types.ts';

/**
 * Verify `x-oncade-signature`: hex HMAC-SHA256 of the *raw* request body, keyed with the platform webhook secret.
 * Must run on the exact bytes received - re-serialising parsed JSON changes the bytes and breaks the match.
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

export function sign(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export interface DedupeStore {
  /** Returns true if the key was newly added, false if it was seen before. */
  add(key: string): boolean;
}

export class MemoryDedupeStore implements DedupeStore {
  private seen = new Set<string>();
  add(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export interface WebhookHandlerOptions {
  secret: string;
  onEvent: (event: WebhookEvent, meta: { platformId?: string; deliveryKey: string }) => void | Promise<void>;
  dedupe?: DedupeStore;
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * Node http handler for Oncade webhooks.
 * - 401 on missing/invalid signature
 * - 400 on malformed JSON
 * - 200 on duplicates (the docs say deliveries are retried with no event id, so we dedupe on a body hash)
 * - 500 if the handler throws, so Oncade retries
 */
export function createWebhookHandler(opts: WebhookHandlerOptions) {
  const dedupe = opts.dedupe ?? new MemoryDedupeStore();
  const log = opts.log ?? (() => {});
  const max = opts.maxBodyBytes ?? 1_000_000;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });

    let raw: Buffer;
    try { raw = await readRaw(req, max); } catch { return reply(res, 413, { error: 'payload too large' }); }

    const signature = req.headers['x-oncade-signature'];
    if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature, opts.secret)) {
      log(`rejected delivery: bad signature (header ${signature ? 'present' : 'missing'})`);
      return reply(res, 401, { error: 'invalid signature' });
    }

    let event: WebhookEvent;
    try {
      event = JSON.parse(raw.toString('utf8'));
      if (typeof event?.event !== 'string') throw new Error('no event field');
    } catch {
      return reply(res, 400, { error: 'malformed payload' });
    }

    const headerEvent = req.headers['x-oncade-event'];
    if (headerEvent && headerEvent !== event.event) log(`warning: x-oncade-event (${headerEvent}) != body.event (${event.event})`);

    const deliveryKey = createHash('sha256').update(raw).digest('hex');
    if (!dedupe.add(deliveryKey)) {
      log(`duplicate delivery ignored: ${event.event}`);
      return reply(res, 200, { ok: true, duplicate: true });
    }

    try {
      const platformId = req.headers['x-oncade-platform-id'];
      await opts.onEvent(event, { platformId: Array.isArray(platformId) ? platformId[0] : platformId, deliveryKey });
    } catch (err) {
      log(`handler failed for ${event.event}: ${(err as Error).message}`);
      return reply(res, 500, { error: 'handler failed' });
    }
    return reply(res, 200, { ok: true });
  };
}
