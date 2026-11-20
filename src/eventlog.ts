import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { EventSource } from './event-source.ts';
import type { WebhookEvent } from './types.ts';
import type { DedupeStore } from './webhooks.ts';

/**
 * Tiny file-backed event log shared between the webhook server and the flow script
 * (they run as separate processes). A real integration would use a database/queue.
 */
export const DATA_DIR = resolve('.data');
export const EVENTS_FILE = resolve(DATA_DIR, 'events.jsonl');

export interface LoggedEvent extends WebhookEvent {
  receivedAt: string;
  deliveryKey: string;
}

export function appendEvent(e: LoggedEvent, file = EVENTS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + '\n');
}

export function readEvents(file = EVENTS_FILE): LoggedEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l) as LoggedEvent]; } catch { return []; }
  });
}

/** Dedupe that survives restarts by reading delivery keys already in the log. */
export class FileDedupeStore implements DedupeStore {
  private seen = new Set(readEvents().map(e => e.deliveryKey));
  add(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/**
 * Event source adapter over the receiver's log file. The receiver is a separate process, so this polls the file.
 * Events already in the log count if they were received at or after `since` (the Event source contract).
 */
export class FileEventSource implements EventSource {
  constructor(private readonly file = EVENTS_FILE, private readonly pollMs = 500) {}

  async waitFor(match: (e: WebhookEvent) => boolean, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = readEvents(this.file).find(e => new Date(e.receivedAt) >= since && match(e));
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise(r => setTimeout(r, Math.min(this.pollMs, left)));
    }
  }
}
