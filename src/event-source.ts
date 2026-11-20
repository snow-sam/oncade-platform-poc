import type { WebhookEvent } from './types.ts';

/**
 * Event source (see GLOSSARY.md): where the Invoice lifecycle reads verified webhook deliveries from.
 *
 * Contract: resolves with the first event matching `match` that was received at or after `since`, including
 * events that arrived *before* the call. Resolves `undefined` after `timeoutMs`. Never rejects for a timeout.
 *
 * Adapters: FileEventSource (src/eventlog.ts, fed by the webhook receiver process) and InMemoryEventSource (tests).
 */
export interface EventSource {
  waitFor(match: (e: WebhookEvent) => boolean, opts: { since: Date; timeoutMs: number }): Promise<WebhookEvent | undefined>;
}

export class InMemoryEventSource implements EventSource {
  private events: { event: WebhookEvent; at: Date }[] = [];
  private waiters = new Set<() => void>();

  push(event: WebhookEvent, at = new Date()) {
    this.events.push({ event, at });
    for (const wake of this.waiters) wake();
  }

  waitFor(match: (e: WebhookEvent) => boolean, { since, timeoutMs }: { since: Date; timeoutMs: number }) {
    const find = () => this.events.find(e => e.at >= since && match(e.event))?.event;
    return new Promise<WebhookEvent | undefined>(resolve => {
      const done = (hit: WebhookEvent | undefined) => { clearTimeout(timer); this.waiters.delete(check); resolve(hit); };
      const check = () => { const hit = find(); if (hit) done(hit); };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}
