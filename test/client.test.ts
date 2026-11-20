import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OncadeApiError, OncadeClient } from '../src/client.ts';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('OncadeClient', () => {
  it('sends auth, version, business and idempotency headers', async () => {
    const f = fakeFetch(201, { _id: 'inv_1', status: 'draft' });
    const c = new OncadeClient({ apiKey: 'oncade_platform_test_x', baseUrl: 'https://h/api', fetchImpl: f.impl })
      .forBusiness('biz_1');
    await c.createInvoice({ date: '2026-01-01', payToTarget: 'BUSINESS', items: [] }, '11111111-1111-4111-8111-111111111111');

    const call = f.calls[0]!;
    const h = call.init.headers as Record<string, string>;
    assert.equal(call.url, 'https://h/api/v1/platform/invoices');
    assert.equal(h.Authorization, 'Bearer oncade_platform_test_x');
    assert.equal(h['X-Oncade-API-Version'], 'v1');
    assert.equal(h['X-Target-Business-Id'], 'biz_1');
    assert.equal(h['Idempotency-Key'], '11111111-1111-4111-8111-111111111111');
  });

  it('generates an idempotency key for mutating calls only', async () => {
    const f = fakeFetch(200, {});
    const c = new OncadeClient({ apiKey: 'k', baseUrl: 'https://h/api', fetchImpl: f.impl });
    await c.me();
    await c.cancelInvoice('inv_1');
    assert.equal((f.calls[0]!.init.headers as Record<string, string>)['Idempotency-Key'], undefined);
    assert.match((f.calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']!, /^[0-9a-f-]{36}$/);
  });

  it('rejects non-UUID idempotency keys before calling the API', async () => {
    const f = fakeFetch(201, {});
    const c = new OncadeClient({ apiKey: 'k', baseUrl: 'https://h/api', fetchImpl: f.impl });
    await assert.rejects(c.createInvoice({ date: 'd', payToTarget: 'BUSINESS', items: [] }, 'invoice-123'), TypeError);
    assert.equal(f.calls.length, 0);
  });

  it('throws OncadeApiError with the response body', async () => {
    const f = fakeFetch(400, { error: 'metadata not allowed' });
    const c = new OncadeClient({ apiKey: 'k', baseUrl: 'https://h/api', fetchImpl: f.impl });
    await assert.rejects(c.getInvoice('x'), (e: unknown) =>
      e instanceof OncadeApiError && e.status === 400 && (e.body as { error: string }).error === 'metadata not allowed');
  });
});
