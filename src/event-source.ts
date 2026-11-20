import type { WebhookEvent } from './types.ts';

/**
 * Event source (see GLOSSARY.md): where the Invoice lifecycle reads verified webhook deliveries from.
 *
 * Contract: resolves with the first event matching `match` that was received at or after `since`, including
 * events that arrived *before* the call. Resolves `undefined` after `timeoutMs`. Never rejects for a timeout.
 *
 * Implemented by the Webhook inbox adapters (src/webhook-inbox.ts): FileInbox and InMemoryInbox.
 */
export interface EventSource {
  waitFor(match: (e: WebhookEvent) => boolean, opts: { since: Date; timeoutMs: number }): Promise<WebhookEvent | undefined>;
}
