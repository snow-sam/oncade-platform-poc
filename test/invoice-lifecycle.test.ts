import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OncadeApiError, OncadeClient } from '../src/client.ts';
import { InMemoryEventSource } from '../src/event-source.ts';
import { InvoiceLifecycle, InvoiceLifecycleError, type InvoiceDraft } from '../src/invoice-lifecycle.ts';
import type { Invoice, InvoiceStatus } from '../src/types.ts';

/**
 * A tiny fake of the Oncade invoice endpoints, behind the client's fetch seam.
 * `webhooks` controls whether/when it emits deliveries into the in-memory Event source.
 */
function fakeOncade(opts: {
  events?: InMemoryEventSource;
  webhooks?: 'before-response' | 'after-response' | 'none' | 'wrong-invoice';
  sendLeavesStatus?: InvoiceStatus;
  failWith?: { path: RegExp; status: number; body: unknown };
} = {}) {
  const invoices = new Map<string, Invoice>();
  const requests: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  let seq = 0;

  const emit = (event: string, inv: Invoice) => {
    const deliver = () => opts.events?.push({
      event,
      data: { invoiceId: opts.webhooks === 'wrong-invoice' ? 'someone-else' : inv._id, status: inv.status },
      timestamp: new Date().toISOString(),
    });
    if (opts.webhooks === 'none') return;
    if (opts.webhooks === 'after-response') setTimeout(deliver, 20);
    else deliver();
  };

  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const path = url.pathname.replace('/api/v1/platform', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, headers: init.headers as Record<string, string>, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });

    if (opts.failWith?.path.test(path)) return json(opts.failWith.status, opts.failWith.body);

    if (method === 'POST' && path === '/invoices') {
      const inv: Invoice = { _id: `inv_${++seq}`, status: body.status, total: body.total };
      invoices.set(inv._id, inv);
      emit('Platform.Invoice.Created', inv);
      return json(201, inv);
    }
    const m = path.match(/^\/invoices\/([^/]+)(?:\/(send|cancel))?$/);
    const inv = m && invoices.get(m[1]!);
    if (!inv) return json(404, { error: 'not found' });
    if (method === 'GET') return json(200, inv);
    if (m![2] === 'send') {
      inv.status = opts.sendLeavesStatus ?? 'sent';
      emit('Platform.Invoice.Sent', inv);
      return json(200, { ...inv, emailSuppressed: !body?.sendEmail });
    }
    if (m![2] === 'cancel') {
      inv.status = 'cancelled';
      emit('Platform.Invoice.Cancelled', inv);
      return json(200, inv);
    }
    return json(400, { error: 'unexpected' });
  }) as unknown as typeof fetch;

  const client = new OncadeClient({ apiKey: 'oncade_platform_test_x', baseUrl: 'https://h/api', fetchImpl }).forBusiness('biz_1');
  return { client, requests, invoices };
}

const DRAFT: InvoiceDraft = {
  receiverName: 'C', receiverEmail: 'c@example.com', date: '2026-11-19T00:00:00.000Z', payToTarget: 'BUSINESS',
  items: [{ description: 'x', quantity: 1, rate: 10, amount: 10 }], total: 10,
};
const FAST = { webhookTimeoutMs: 100 };

describe('InvoiceLifecycle', () => {
  it('issue → send → cancel, each confirmed by API read-back and webhook', async () => {
    const events = new InMemoryEventSource();
    const { client } = fakeOncade({ events, webhooks: 'after-response' });
    const lifecycle = new InvoiceLifecycle(client, { events, ...FAST });

    const issued = await lifecycle.issue(DRAFT);
    assert.equal(issued.invoice.status, 'draft');
    assert.equal(issued.webhook.status, 'received');

    const sent = await lifecycle.send(issued.invoice._id);
    assert.equal(sent.invoice.status, 'sent');
    assert.equal(sent.webhook.status === 'received' && sent.webhook.event.event, 'Platform.Invoice.Sent');

    const cancelled = await lifecycle.cancel(issued.invoice._id);
    assert.equal(cancelled.invoice.status, 'cancelled');
    assert.equal(cancelled.webhook.status, 'received');
  });

  it('counts a webhook that arrives before the wait starts', async () => {
    const events = new InMemoryEventSource();
    const { client } = fakeOncade({ events, webhooks: 'before-response' });
    const issued = await new InvoiceLifecycle(client, { events, ...FAST }).issue(DRAFT);
    assert.equal(issued.webhook.status, 'received');
  });

  it('reports a missing webhook as timeout, without failing', async () => {
    const events = new InMemoryEventSource();
    const { client } = fakeOncade({ events, webhooks: 'none' });
    const issued = await new InvoiceLifecycle(client, { events, ...FAST }).issue(DRAFT);
    assert.equal(issued.invoice.status, 'draft');
    assert.equal(issued.webhook.status, 'timeout');
  });

  it('ignores webhooks for other invoices', async () => {
    const events = new InMemoryEventSource();
    const { client } = fakeOncade({ events, webhooks: 'wrong-invoice' });
    const issued = await new InvoiceLifecycle(client, { events, ...FAST }).issue(DRAFT);
    assert.equal(issued.webhook.status, 'timeout');
  });

  it('skips the webhook wait when there is no Event source', async () => {
    const { client } = fakeOncade();
    const started = Date.now();
    const issued = await new InvoiceLifecycle(client).issue(DRAFT);
    assert.equal(issued.webhook.status, 'skipped');
    assert.ok(Date.now() - started < 1000, 'must not wait for the default timeout');
  });

  it('per-call timeout overrides the default', async () => {
    const events = new InMemoryEventSource();
    const { client } = fakeOncade({ events, webhooks: 'none' });
    const lifecycle = new InvoiceLifecycle(client, { events, webhookTimeoutMs: 60_000 });
    const started = Date.now();
    const issued = await lifecycle.issue(DRAFT, { webhookTimeoutMs: 50 });
    assert.equal(issued.webhook.status, 'timeout');
    assert.ok(Date.now() - started < 1000);
  });

  it('throws on a state mismatch after read-back', async () => {
    const { client } = fakeOncade({ sendLeavesStatus: 'draft' });
    const lifecycle = new InvoiceLifecycle(client);
    const { invoice } = await lifecycle.issue(DRAFT);
    await assert.rejects(lifecycle.send(invoice._id), (e: unknown) =>
      e instanceof InvoiceLifecycleError && e.expected === 'sent' && e.actual === 'draft');
  });

  it('wraps API errors (e.g. a 403 from a missing grant scope)', async () => {
    const { client } = fakeOncade({ failWith: { path: /^\/invoices$/, status: 403, body: { error: 'missing scope invoice:create' } } });
    await assert.rejects(new InvoiceLifecycle(client).issue(DRAFT), (e: unknown) =>
      e instanceof InvoiceLifecycleError && e.cause instanceof OncadeApiError && e.cause.status === 403);
  });

  it('issue always creates a draft with a UUID Idempotency-Key', async () => {
    const { client, requests } = fakeOncade();
    await new InvoiceLifecycle(client).issue({ ...DRAFT, status: 'sent' } as InvoiceDraft);
    const create = requests.find(r => r.method === 'POST' && r.path === '/invoices')!;
    assert.equal(create.body.status, 'draft');
    assert.match(create.headers['Idempotency-Key']!, /^[0-9a-f-]{36}$/);
  });

  it('send passes sendEmail through (default false)', async () => {
    const { client, requests } = fakeOncade();
    const lifecycle = new InvoiceLifecycle(client);
    const { invoice } = await lifecycle.issue(DRAFT);
    await lifecycle.send(invoice._id);
    await lifecycle.send(invoice._id, { sendEmail: true }).catch(() => {});
    const sends = requests.filter(r => r.path.endsWith('/send'));
    assert.equal(sends[0]!.body.sendEmail, false);
    assert.equal(sends[1]!.body.sendEmail, true);
  });
});

describe('InMemoryEventSource', () => {
  it('only returns events at or after `since`', async () => {
    const events = new InMemoryEventSource();
    events.push({ event: 'A', data: {} }, new Date(Date.now() - 10_000));
    const hit = await events.waitFor(e => e.event === 'A', { since: new Date(Date.now() - 1000), timeoutMs: 30 });
    assert.equal(hit, undefined);
  });
});

describe('FileEventSource', () => {
  it('honours the Event source contract over the receiver log', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { appendEvent, FileEventSource } = await import('../src/eventlog.ts');
    const file = join(mkdtempSync(join(tmpdir(), 'oncade-')), 'events.jsonl');
    const source = new FileEventSource(file, 10);
    const since = new Date();

    appendEvent({ event: 'Old', data: {}, receivedAt: new Date(since.getTime() - 5000).toISOString(), deliveryKey: 'a' }, file);
    appendEvent({ event: 'Early', data: { invoiceId: 'i1' }, receivedAt: new Date().toISOString(), deliveryKey: 'b' }, file);
    setTimeout(() => appendEvent({ event: 'Late', data: {}, receivedAt: new Date().toISOString(), deliveryKey: 'c' }, file), 30);

    assert.equal((await source.waitFor(e => e.event === 'Early', { since, timeoutMs: 100 }))?.data.invoiceId, 'i1');
    assert.ok(await source.waitFor(e => e.event === 'Late', { since, timeoutMs: 500 }));
    assert.equal(await source.waitFor(e => e.event === 'Old', { since, timeoutMs: 50 }), undefined);
  });
});
