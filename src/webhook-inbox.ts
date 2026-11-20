import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DATA_DIR } from './config.ts';
import type { EventSource } from './event-source.ts';
import type { WebhookEvent } from './types.ts';

export type RecordResult = 'new' | 'duplicate';

/**
 * Webhook inbox (see GLOSSARY.md): stores verified deliveries exactly once, and serves them back as an Event source.
 *
 * - `record()` resolves 'new' once the delivery is stored, or 'duplicate' if it was stored before. It rejects if storing
 *   fails, and in that case the delivery is NOT marked seen, so Oncade's retry gets processed.
 * - Dedupe key: SHA-256 of the raw body. Oncade sends no delivery id; observed retries are byte-identical.
 * - `waitFor()` follows the Event source contract (events at/after `since`, including ones stored before the call).
 */
export interface WebhookInbox extends EventSource {
  record(rawBody: Buffer, event: WebhookEvent): Promise<RecordResult>;
}

export interface StoredEvent extends WebhookEvent {
  receivedAt: string;
  deliveryKey: string;
}

const keyOf = (rawBody: Buffer) => createHash('sha256').update(rawBody).digest('hex');

export class InMemoryInbox implements WebhookInbox {
  private stored: StoredEvent[] = [];
  private seen = new Set<string>();
  private waiters = new Set<() => void>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async record(rawBody: Buffer, event: WebhookEvent): Promise<RecordResult> {
    const deliveryKey = keyOf(rawBody);
    if (this.seen.has(deliveryKey)) return 'duplicate';
    this.stored.push({ ...event, receivedAt: this.now().toISOString(), deliveryKey });
    this.seen.add(deliveryKey); // only after storing
    for (const wake of this.waiters) wake();
    return 'new';
  }

  waitFor(match: (e: WebhookEvent) => boolean, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    const find = () => this.stored.find(e => new Date(e.receivedAt) >= since && match(e));
    return new Promise<WebhookEvent | undefined>(resolve => {
      const done = (hit: WebhookEvent | undefined) => { clearTimeout(timer); this.waiters.delete(check); resolve(hit); };
      const check = () => { const hit = find(); if (hit) done(hit); };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

export const EVENTS_FILE = resolve(DATA_DIR, 'events.jsonl');

/**
 * Append-only JSONL file. The receiver process writes it, and other processes (the flow) read it by polling.
 * Single-writer by design (one receiver process), so no locking.
 */
export class FileInbox implements WebhookInbox {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly seen: Set<string>;

  constructor(opts: { file?: string; now?: () => Date; pollMs?: number } = {}) {
    this.file = opts.file ?? EVENTS_FILE;
    this.now = opts.now ?? (() => new Date());
    this.pollMs = opts.pollMs ?? 500;
    this.seen = new Set(this.read().map(e => e.deliveryKey));
  }

  async record(rawBody: Buffer, event: WebhookEvent): Promise<RecordResult> {
    const deliveryKey = keyOf(rawBody);
    if (this.seen.has(deliveryKey)) return 'duplicate';
    const line: StoredEvent = { ...event, receivedAt: this.now().toISOString(), deliveryKey };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(line) + '\n'); // throws -> not marked seen
    this.seen.add(deliveryKey);
    return 'new';
  }

  async waitFor(match: (e: WebhookEvent) => boolean, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.read().find(e => new Date(e.receivedAt) >= since && match(e));
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise(r => setTimeout(r, Math.min(this.pollMs, left)));
    }
  }

  private read(): StoredEvent[] {
    if (!existsSync(this.file)) return [];
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(l => {
      try { return [JSON.parse(l) as StoredEvent]; } catch { return []; }
    });
  }
}
