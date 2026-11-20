import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createWebhookHandler, sign, verifySignature } from '../src/webhooks.ts';
import { InMemoryInbox } from '../src/webhook-inbox.ts';
import type { WebhookEvent } from '../src/types.ts';

const SECRET = 'whsec_test_123';

describe('verifySignature', () => {
  const body = Buffer.from('{"event":"Platform.Invoice.Sent","data":{"invoiceId":"inv_1"}}');

  it('accepts a correct signature', () => assert.ok(verifySignature(body, sign(body, SECRET), SECRET)));
  it('accepts uppercase hex', () => assert.ok(verifySignature(body, sign(body, SECRET).toUpperCase(), SECRET)));
  it('rejects wrong secret', () => assert.ok(!verifySignature(body, sign(body, 'other'), SECRET)));
  it('rejects missing signature', () => assert.ok(!verifySignature(body, undefined, SECRET)));
  it('rejects truncated signature', () => assert.ok(!verifySignature(body, sign(body, SECRET).slice(0, 10), SECRET)));
  it('rejects re-serialised body (whitespace change)', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    assert.ok(!verifySignature(reformatted, sign(body, SECRET), SECRET));
  });
});

/** Wraps an inbox so the next N record() calls fail, like a full disk. */
class FlakyInbox extends InMemoryInbox {
  failures = 0;
  override async record(raw: Buffer, event: WebhookEvent) {
    if (this.failures > 0) { this.failures--; throw new Error('disk full'); }
    return super.record(raw, event);
  }
}

const eventually = async (check: () => boolean, ms = 500) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('condition not met in time'); await new Promise(r => setTimeout(r, 5)); }
};

describe('webhook handler', () => {
  const reacted: WebhookEvent[] = [];
  const inbox = new FlakyInbox();
  const logs: string[] = [];
  let server: Server;
  let url: string;
  let reactionFails = false;

  before(async () => {
    const handler = createWebhookHandler({
      secret: SECRET,
      inbox,
      log: m => logs.push(m),
      afterRecord: e => {
        if (reactionFails) { reactionFails = false; throw new Error('reaction boom'); }
        reacted.push(e);
      },
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => server.close());

  const post = (body: string, sig?: string) =>
    fetch(url, { method: 'POST', body, headers: sig ? { 'x-oncade-signature': sig } : {} });
  const signed = (body: string) => post(body, sign(body, SECRET));

  it('stores a signed event, answers 200, then runs the reaction', async () => {
    const body = JSON.stringify({ event: 'Platform.Invoice.Created', data: { invoiceId: 'a' }, timestamp: 't' });
    assert.equal((await signed(body)).status, 200);
    await eventually(() => reacted.some(e => e.data.invoiceId === 'a'));
    assert.ok(await inbox.waitFor(e => e.data.invoiceId === 'a', { since: new Date(0), timeoutMs: 10 }));
  });

  it('acks duplicates without reacting again', async () => {
    const body = JSON.stringify({ event: 'Platform.Invoice.Sent', data: { invoiceId: 'dup' } });
    await signed(body);
    const res = await signed(body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, duplicate: true });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(reacted.filter(e => e.data.invoiceId === 'dup').length, 1);
  });

  it('regression: a delivery whose storage failed is processed on retry (not lost as a duplicate)', async () => {
    const body = JSON.stringify({ event: 'Platform.Invoice.Paid', data: { invoiceId: 'retry-me' } });
    inbox.failures = 1;
    assert.equal((await signed(body)).status, 500, 'storage failed -> 500 so Oncade retries');
    const retry = await signed(body);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true });
    await eventually(() => reacted.some(e => e.data.invoiceId === 'retry-me'));
  });

  it('a failing reaction does not change the response and is logged', async () => {
    reactionFails = true;
    const body = JSON.stringify({ event: 'Platform.Invoice.Cancelled', data: { invoiceId: 'r' } });
    assert.equal((await signed(body)).status, 200);
    await eventually(() => logs.some(l => l.includes('reaction boom')));
    assert.ok(await inbox.waitFor(e => e.data.invoiceId === 'r', { since: new Date(0), timeoutMs: 10 }), 'still stored');
  });

  it('401s on bad signature, without storing', async () => {
    assert.equal((await post('{"event":"bad","data":{}}', 'deadbeef')).status, 401);
    assert.equal(await inbox.waitFor(e => e.event === 'bad', { since: new Date(0), timeoutMs: 10 }), undefined);
  });

  it('400s on signed garbage', async () => {
    assert.equal((await signed('not json')).status, 400);
  });
});
