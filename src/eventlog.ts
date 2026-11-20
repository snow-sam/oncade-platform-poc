import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { WebhookEvent } from './types.ts';
import type { DedupeStore } from './webhooks.ts';

/**
 * Tiny file-backed event log shared between the webhook server and the flow script
 * (they run as separate processes). A real integration would use a database/queue.
 */
export const DATA_DIR = resolve('.data');
const EVENTS = resolve(DATA_DIR, 'events.jsonl');

export interface LoggedEvent extends WebhookEvent {
  receivedAt: string;
  deliveryKey: string;
}

export function appendEvent(e: LoggedEvent) {
  mkdirSync(dirname(EVENTS), { recursive: true });
  appendFileSync(EVENTS, JSON.stringify(e) + '\n');
}

export function readEvents(): LoggedEvent[] {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).flatMap(l => {
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

export async function waitForEvent(
  match: (e: LoggedEvent) => boolean,
  { timeoutMs = 60_000, since = new Date(0) }: { timeoutMs?: number; since?: Date } = {},
): Promise<LoggedEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readEvents().find(e => new Date(e.receivedAt) >= since && match(e));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 1000));
  }
  return undefined;
}
