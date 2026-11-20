import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OncadeClient } from '../src/client.ts';

const TEST_KEY = 'oncade_platform_test_abc';

function clientReturning(body: unknown) {
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  return new OncadeClient({ apiKey: TEST_KEY, baseUrl: 'https://h/api', fetchImpl });
}

// Real response shape observed on the test API (2026-11-19), which differs from the docs.
const REAL_ME = {
  platformId: 'plat-1',
  name: 'Plat',
  status: 'pending',
  approvedScopes: ['platform:read', 'invoice:create', 'invoice:send'],
  pendingScopes: [],
  keyInfo: { keyId: 'key_1', environment: 'test', activeScopes: ['platform:read', 'invoice:create', 'campaign:create'] },
};

describe('Platform identity', () => {
  it('normalizes the real /me shape', async () => {
    const p = await clientReturning(REAL_ME).platform();
    assert.equal(p.platformId, 'plat-1');
    assert.equal(p.environment, 'test');
    assert.equal(p.status, 'pending');
  });

  it('effective scopes = approved ∩ key scopes', async () => {
    const p = await clientReturning(REAL_ME).platform();
    assert.deepEqual([...p.scopes].sort(), ['invoice:create', 'platform:read']);
    assert.ok(p.can('invoice:create'));
    assert.ok(!p.can('invoice:send'), 'approved but not on the key');
    assert.ok(!p.can('campaign:create'), 'on the key but not approved');
  });

  it('falls back to the documented top-level activeScopes', async () => {
    const p = await clientReturning({ platformId: 'x', keyInfo: { environment: 'test' }, activeScopes: ['platform:read'] }).platform();
    assert.ok(p.can('platform:read'));
  });

  it('refuses a live environment even with a test-prefixed key', async () => {
    await assert.rejects(clientReturning({ ...REAL_ME, keyInfo: { ...REAL_ME.keyInfo, environment: 'live' } }).platform(), /live/);
  });
});

describe('live-key guard', () => {
  it('refuses to construct a client with a non-test key', () => {
    assert.throws(() => new OncadeClient({ apiKey: 'oncade_platform_live_abc', baseUrl: 'https://h/api' }), /test key/);
  });

  it('accepts a test key', () => {
    assert.doesNotThrow(() => new OncadeClient({ apiKey: TEST_KEY, baseUrl: 'https://h/api' }));
  });
});
