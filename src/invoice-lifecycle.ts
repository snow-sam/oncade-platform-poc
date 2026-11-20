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
  sendInvoice(invoiceId: string, options: { sendEmail?: boolean }): Promise<Invoice>;
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
  constructor(message: string, details: { expected?: InvoiceStatus; actual?: InvoiceStatus; cause?: unknown } = {}) {
    super(message, { cause: details.cause });
    this.name = 'InvoiceLifecycleError';
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

interface ConfirmOptions {
  /** Overrides the default webhook wait for this call. */
  webhookTimeoutMs?: number;
}

/** Oncade's invoice webhook event names. The single source for this module, the flow and the receiver. */
export const INVOICE_EVENTS = {
  created: 'Platform.Invoice.Created',
  updated: 'Platform.Invoice.Updated',
  sent: 'Platform.Invoice.Sent',
  paid: 'Platform.Invoice.Paid',
  cancelled: 'Platform.Invoice.Cancelled',
} as const;

/** What confirming one transition means: the state the API must report, and the webhook to expect. */
interface Transition {
  expectedStatus: InvoiceStatus;
  webhookEvent: string;
}

const TRANSITIONS = {
  issue: { expectedStatus: 'draft', webhookEvent: INVOICE_EVENTS.created },
  send: { expectedStatus: 'sent', webhookEvent: INVOICE_EVENTS.sent },
  cancel: { expectedStatus: 'cancelled', webhookEvent: INVOICE_EVENTS.cancelled },
} satisfies Record<string, Transition>;

type Operation = keyof typeof TRANSITIONS;

const DEFAULT_WEBHOOK_TIMEOUT_MS = 60_000;

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

  constructor(private readonly api: InvoiceApi, options: { events?: EventSource; webhookTimeoutMs?: number } = {}) {
    this.events = options.events;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  }

  issue(draft: InvoiceDraft, options: ConfirmOptions = {}): Promise<Confirmation> {
    // Drop any status the caller passed anyway: issuing always produces a draft.
    const { status: _ignored, ...fields } = draft as CreateInvoiceInput;
    return this.confirm('issue', options,
      () => this.api.createInvoice({ ...fields, status: 'draft' }, randomUUID()));
  }

  send(invoiceId: string, options: ConfirmOptions & { sendEmail?: boolean } = {}): Promise<Confirmation> {
    return this.confirm('send', options,
      () => this.api.sendInvoice(invoiceId, { sendEmail: options.sendEmail ?? false }));
  }

  cancel(invoiceId: string, options: ConfirmOptions = {}): Promise<Confirmation> {
    return this.confirm('cancel', options, () => this.api.cancelInvoice(invoiceId));
  }

  /** Performs the action, reads the invoice back, checks its state, then waits for the matching webhook. */
  private async confirm(operation: Operation, options: ConfirmOptions, performAction: () => Promise<Invoice>): Promise<Confirmation> {
    const { expectedStatus, webhookEvent }: Transition = TRANSITIONS[operation];
    // Captured before the HTTP call: a delivery can land before the response does.
    const since = new Date();

    let invoice: Invoice;
    try {
      const actedOn = await performAction();
      invoice = await this.api.getInvoice(actedOn._id);
    } catch (err) {
      throw new InvoiceLifecycleError(`${operation} failed: ${(err as Error).message}`, { expected: expectedStatus, cause: err });
    }
    if (invoice.status !== expectedStatus) {
      throw new InvoiceLifecycleError(
        `${operation}: expected invoice ${invoice._id} to be "${expectedStatus}", API says "${invoice.status}"`,
        { expected: expectedStatus, actual: invoice.status });
    }

    if (!this.events) return { invoice, webhook: { status: 'skipped' } };
    const event = await this.events.waitFor(
      e => e.event === webhookEvent && e.data?.invoiceId === invoice._id,
      { since, timeoutMs: options.webhookTimeoutMs ?? this.webhookTimeoutMs },
    );
    return { invoice, webhook: event ? { status: 'received', event } : { status: 'timeout' } };
  }
}
