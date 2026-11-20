import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createWebhookHandler, payloadMentions, sign, verifySignature } from '../src/webhooks.ts';
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

describe('payloadMentions', () => {
  it('finds nested ids', () => assert.ok(payloadMentions({ a: { b: ['x', { id: 'inv_9' }] } }, 'inv_9')));
  it('ignores partial matches', () => assert.ok(!payloadMentions({ id: 'inv_99' }, 'inv_9')));
});

describe('webhook handler', () => {
  const received: WebhookEvent[] = [];
  let server: Server;
  let url: string;
  let failNext = false;

  before(async () => {
    const handler = createWebhookHandler({
      secret: SECRET,
      onEvent: e => {
        if (failNext) { failNext = false; throw new Error('boom'); }
        received.push(e);
      },
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => server.close());

  const post = (body: string, sig?: string) =>
    fetch(url, { method: 'POST', body, headers: sig ? { 'x-oncade-signature': sig } : {} });

  it('processes a signed event', async () => {
    const body = JSON.stringify({ event: 'Platform.Invoice.Created', data: { invoiceId: 'a' }, timestamp: 't' });
    assert.equal((await post(body, sign(body, SECRET))).status, 200);
    assert.equal(received.at(-1)?.event, 'Platform.Invoice.Created');
  });

  it('acks duplicates without reprocessing', async () => {
    const body = JSON.stringify({ event: 'Platform.Invoice.Sent', data: { invoiceId: 'dup' } });
    const before = received.length;
    await post(body, sign(body, SECRET));
    const res = await post(body, sign(body, SECRET));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, duplicate: true });
    assert.equal(received.length, before + 1);
  });

  it('401s on bad signature', async () => {
    assert.equal((await post('{"event":"x","data":{}}', 'deadbeef')).status, 401);
  });

  it('400s on signed garbage', async () => {
    assert.equal((await post('not json', sign('not json', SECRET))).status, 400);
  });

  it('500s when the handler throws so Oncade retries', async () => {
    failNext = true;
    const body = JSON.stringify({ event: 'Platform.Invoice.Paid', data: { invoiceId: 'retry' } });
    assert.equal((await post(body, sign(body, SECRET))).status, 500);
  });
});
