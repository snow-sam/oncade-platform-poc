import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebhookEvent } from './types.ts';
import type { WebhookInbox } from './webhook-inbox.ts';

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** `x-oncade-signature`: hex HMAC-SHA256 of the *raw* request body, keyed with the platform webhook secret. */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Checks `x-oncade-signature` with a constant-time compare. Must run on the exact bytes received: re-serialising
 * parsed JSON changes the bytes and breaks the match.
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const received = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  const expected = Buffer.from(computeSignature(rawBody, secret), 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
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
  log?: (message: string) => void;
}

/**
 * Node http handler for Oncade webhooks. Store first, react later:
 * - 401 on missing/invalid signature, 400 on malformed JSON (nothing stored)
 * - 200 `{ok}` once a new delivery is stored, 200 `{ok, duplicate}` for a delivery stored before
 * - 500 only if storing fails, so Oncade retries (and the inbox hasn't marked it seen)
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  const log = options.log ?? (() => {});
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });

    let rawBody: Buffer;
    try { rawBody = await readRawBody(req, maxBodyBytes); } catch { return reply(res, 413, { error: 'payload too large' }); }

    const signature = firstHeader(req, 'x-oncade-signature');
    if (!verifySignature(rawBody, signature, options.secret)) {
      log(`rejected delivery: bad signature (header ${signature ? 'present' : 'missing'})`);
      return reply(res, 401, { error: 'invalid signature' });
    }

    const event = parseEvent(rawBody);
    if (!event) return reply(res, 400, { error: 'malformed payload' });

    const headerEvent = firstHeader(req, 'x-oncade-event');
    if (headerEvent && headerEvent !== event.event) log(`warning: x-oncade-event (${headerEvent}) != body.event (${event.event})`);

    let result;
    try {
      result = await options.inbox.record(rawBody, event);
    } catch (err) {
      log(`could not store ${event.event}: ${(err as Error).message} - answering 500 so Oncade retries`);
      return reply(res, 500, { error: 'could not store delivery' });
    }
    if (result === 'duplicate') {
      log(`duplicate delivery ignored: ${event.event}`);
      return reply(res, 200, { ok: true, duplicate: true });
    }
    reply(res, 200, { ok: true });

    if (!options.afterRecord) return;
    try {
      await options.afterRecord(event, { platformId: firstHeader(req, 'x-oncade-platform-id') });
    } catch (err) {
      log(`reaction failed for ${event.event}: ${(err as Error).message} (event is stored)`);
    }
  };
}

function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The parsed delivery, or undefined if the body isn't JSON or has no `event` name. */
function parseEvent(rawBody: Buffer): WebhookEvent | undefined {
  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    return typeof event?.event === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

/** Node gives a repeated header as an array; Oncade sends each once, so take the first. */
function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}
