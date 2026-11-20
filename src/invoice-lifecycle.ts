import { randomUUID } from 'node:crypto';
import type { EventSource } from './event-source.ts';
import type { CreateInvoiceInput, Invoice, InvoiceStatus, WebhookEvent } from './types.ts';

/**
 * The part of the Oncade API the Invoice lifecycle needs, declared here so this module depends on what it uses rather
 * than on the whole client. A business-scoped `OncadeClient` (`client.forBusiness(id)`) satisfies it as is.
 */
export interface InvoiceApi {
  createInvoice(input: CreateInvoiceInput, idempotencyKey?: string): Promise<Invoice>;
  getInvoice(invoiceId: string): Promise<Invoice>;
  sendInvoice(invoiceId: string, opts: { sendEmail?: boolean }): Promise<Invoice>;
  cancelInvoice(invoiceId: string): Promise<Invoice>;
}

/** What the caller supplies to issue an invoice. Status is always draft; use send() to move it on. */
export type InvoiceDraft = Omit<CreateInvoiceInput, 'status'>;

export type WebhookObservation =
  | { status: 'received'; event: WebhookEvent }
  | { status: 'timeout' }
  | { status: 'skipped' };

/** Confirmation (see GLOSSARY.md): API state is the truth; the webhook is an observation, never a failure. */
export interface Confirmation {
  invoice: Invoice;
  webhook: WebhookObservation;
}

export class InvoiceLifecycleError extends Error {
  readonly expected?: InvoiceStatus;
  readonly actual?: InvoiceStatus;
  constructor(message: string, opts: { expected?: InvoiceStatus; actual?: InvoiceStatus; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'InvoiceLifecycleError';
    this.expected = opts.expected;
    this.actual = opts.actual;
  }
}

interface CallOptions {
  /** Overrides the default webhook wait for this call. */
  webhookTimeoutMs?: number;
}

/**
 * Invoice lifecycle (see GLOSSARY.md): drives draft → sent → cancelled and confirms each transition.
 *
 * Each operation returns only after the invoice has been read back from the API in the expected state, and after the
 * matching webhook arrived, the wait timed out, or was skipped because no Event source was given.
 * Throws InvoiceLifecycleError on API errors (403 for a missing grant scope included) or a state mismatch.
 *
 * Expects a business-scoped client (`client.forBusiness(id)`).
 */
export class InvoiceLifecycle {
  private readonly events?: EventSource;
  private readonly webhookTimeoutMs: number;

  constructor(private readonly api: InvoiceApi, opts: { events?: EventSource; webhookTimeoutMs?: number } = {}) {
    this.events = opts.events;
    this.webhookTimeoutMs = opts.webhookTimeoutMs ?? 60_000;
  }

  issue(draft: InvoiceDraft, opts: CallOptions = {}): Promise<Confirmation> {
    // Strip any status the caller smuggled in: issuing always produces a draft.
    const { status: _ignored, ...rest } = draft as CreateInvoiceInput;
    return this.transition('issue', 'draft', 'Platform.Invoice.Created', opts,
      () => this.api.createInvoice({ ...rest, status: 'draft' }, randomUUID()));
  }

  send(invoiceId: string, opts: CallOptions & { sendEmail?: boolean } = {}): Promise<Confirmation> {
    return this.transition('send', 'sent', 'Platform.Invoice.Sent', opts,
      () => this.api.sendInvoice(invoiceId, { sendEmail: opts.sendEmail ?? false }));
  }

  cancel(invoiceId: string, opts: CallOptions = {}): Promise<Confirmation> {
    return this.transition('cancel', 'cancelled', 'Platform.Invoice.Cancelled', opts,
      () => this.api.cancelInvoice(invoiceId));
  }

  private async transition(
    name: string, expected: InvoiceStatus, eventName: string, opts: CallOptions, act: () => Promise<Invoice>,
  ): Promise<Confirmation> {
    // Captured before the HTTP call: a delivery can land before the response does.
    const since = new Date();

    let invoice: Invoice;
    try {
      const acted = await act();
      invoice = await this.api.getInvoice(acted._id);
    } catch (err) {
      throw new InvoiceLifecycleError(`${name} failed: ${(err as Error).message}`, { expected, cause: err });
    }
    if (invoice.status !== expected) {
      throw new InvoiceLifecycleError(`${name}: expected invoice ${invoice._id} to be "${expected}", API says "${invoice.status}"`,
        { expected, actual: invoice.status });
    }

    if (!this.events) return { invoice, webhook: { status: 'skipped' } };
    const event = await this.events.waitFor(
      e => e.event === eventName && e.data?.invoiceId === invoice._id,
      { since, timeoutMs: opts.webhookTimeoutMs ?? this.webhookTimeoutMs },
    );
    return { invoice, webhook: event ? { status: 'received', event } : { status: 'timeout' } };
  }
}
