import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebhookEvent } from './types.ts';
import type { WebhookInbox } from './webhook-inbox.ts';

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

export interface WebhookHandlerOptions {
  secret: string;
  /** Where verified deliveries are stored (exactly once). */
  inbox: WebhookInbox;
  /**
   * Reaction to a *new* delivery. It runs after the response is sent, so it can't cause a retry. Its errors are logged.
   * Anything that must not be lost should read from the inbox instead.
   */
  afterRecord?: (event: WebhookEvent, meta: { platformId?: string }) => void | Promise<void>;
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
 * Node http handler for Oncade webhooks. Store first, react later:
 * - 401 on missing/invalid signature, 400 on malformed JSON (nothing stored)
 * - 200 `{ok}` once a new delivery is stored, 200 `{ok, duplicate}` for a delivery stored before
 * - 500 only if storing fails, so Oncade retries (and the inbox hasn't marked it seen)
 */
export function createWebhookHandler(opts: WebhookHandlerOptions) {
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

    let result;
    try {
      result = await opts.inbox.record(raw, event);
    } catch (err) {
      log(`could not store ${event.event}: ${(err as Error).message} - answering 500 so Oncade retries`);
      return reply(res, 500, { error: 'could not store delivery' });
    }
    if (result === 'duplicate') {
      log(`duplicate delivery ignored: ${event.event}`);
      return reply(res, 200, { ok: true, duplicate: true });
    }
    reply(res, 200, { ok: true });

    if (opts.afterRecord) {
      const platformId = req.headers['x-oncade-platform-id'];
      try {
        await opts.afterRecord(event, { platformId: Array.isArray(platformId) ? platformId[0] : platformId });
      } catch (err) {
        log(`reaction failed for ${event.event}: ${(err as Error).message} (event is stored)`);
      }
    }
  };
}
