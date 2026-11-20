import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

type EventMatcher = (event: WebhookEvent) => boolean;

const deliveryKeyOf = (rawBody: Buffer) => createHash('sha256').update(rawBody).digest('hex');

/** The first stored event that matches and was received at or after `since`. */
const findReceivedSince = (stored: StoredEvent[], match: EventMatcher, since: Date) =>
  stored.find(event => new Date(event.receivedAt) >= since && match(event));

export class InMemoryInbox implements WebhookInbox {
  private stored: StoredEvent[] = [];
  private seen = new Set<string>();
  private waiters = new Set<() => void>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async record(rawBody: Buffer, event: WebhookEvent): Promise<RecordResult> {
    const deliveryKey = deliveryKeyOf(rawBody);
    if (this.seen.has(deliveryKey)) return 'duplicate';
    this.stored.push({ ...event, receivedAt: this.now().toISOString(), deliveryKey });
    this.seen.add(deliveryKey); // only after storing
    for (const wake of this.waiters) wake();
    return 'new';
  }

  waitFor(match: EventMatcher, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    return new Promise<WebhookEvent | undefined>(resolve => {
      const finish = (result: WebhookEvent | undefined) => { clearTimeout(timer); this.waiters.delete(check); resolve(result); };
      const check = () => { const found = findReceivedSince(this.stored, match, since); if (found) finish(found); };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

const DEFAULT_POLL_MS = 500;

/**
 * Append-only JSONL file. The receiver process writes it, and other processes (the flow) read it by polling.
 * Single-writer by design (one receiver process), so no locking. The caller picks the file, so this module never
 * touches env or cwd.
 */
export class FileInbox implements WebhookInbox {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly seen: Set<string>;

  constructor(options: { file: string; now?: () => Date; pollMs?: number }) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.seen = new Set(this.readAll().map(event => event.deliveryKey));
  }

  async record(rawBody: Buffer, event: WebhookEvent): Promise<RecordResult> {
    const deliveryKey = deliveryKeyOf(rawBody);
    if (this.seen.has(deliveryKey)) return 'duplicate';
    const line: StoredEvent = { ...event, receivedAt: this.now().toISOString(), deliveryKey };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(line) + '\n'); // throws -> not marked seen
    this.seen.add(deliveryKey);
    return 'new';
  }

  async waitFor(match: EventMatcher, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = findReceivedSince(this.readAll(), match, since);
      if (found) return found;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return undefined;
      await new Promise(wake => setTimeout(wake, Math.min(this.pollMs, remainingMs)));
    }
  }

  /** Every stored delivery. A missing or unreadable file reads as empty; unparsable lines are skipped. */
  private readAll(): StoredEvent[] {
    if (!existsSync(this.file)) return [];
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as StoredEvent]; } catch { return []; }
    });
  }
}
