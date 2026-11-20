import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FileInbox, InMemoryInbox, type WebhookInbox } from '../src/webhook-inbox.ts';
import type { WebhookEvent } from '../src/types.ts';

const delivery = (event: string, data: Record<string, unknown> = {}) => {
  const e: WebhookEvent = { event, data, timestamp: '2026-11-19T00:00:00.000Z' };
  return [Buffer.from(JSON.stringify(e)), e] as const;
};

/** A controllable clock, so the contract can place events before `since`. */
function clock(start = Date.parse('2026-11-19T12:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'oncade-inbox-')), 'events.jsonl');

const ADAPTERS: [string, (now: () => Date) => WebhookInbox][] = [
  ['InMemoryInbox', now => new InMemoryInbox({ now })],
  ['FileInbox', now => new FileInbox({ file: tmpFile(), now, pollMs: 5 })],
];

for (const [name, make] of ADAPTERS) {
  describe(`Webhook inbox contract: ${name}`, () => {
    it('records a new delivery once; byte-identical retries are duplicates', async () => {
      const inbox = make(() => new Date());
      const [raw, e] = delivery('Platform.Invoice.Sent', { invoiceId: 'i1' });
      assert.equal(await inbox.record(raw, e), 'new');
      assert.equal(await inbox.record(raw, e), 'duplicate');
      const [raw2, e2] = delivery('Platform.Invoice.Sent', { invoiceId: 'i2' });
      assert.equal(await inbox.record(raw2, e2), 'new');
    });

    it('waitFor returns events already recorded at/after since', async () => {
      const inbox = make(() => new Date());
      const since = new Date();
      await inbox.record(...delivery('Early', { n: 1 }));
      const hit = await inbox.waitFor(e => e.event === 'Early', { since, timeoutMs: 100 });
      assert.equal(hit?.data.n, 1);
    });

    it('waitFor resolves when a matching event arrives later', async () => {
      const inbox = make(() => new Date());
      setTimeout(() => void inbox.record(...delivery('Late')), 20);
      assert.ok(await inbox.waitFor(e => e.event === 'Late', { since: new Date(), timeoutMs: 1000 }));
    });

    it('waitFor ignores events before since and times out with undefined', async () => {
      const c = clock();
      const inbox = make(c.now);
      await inbox.record(...delivery('Old'));
      c.advance(10_000);
      const hit = await inbox.waitFor(e => e.event === 'Old', { since: c.now(), timeoutMs: 40 });
      assert.equal(hit, undefined);
    });
  });
}

describe('FileInbox', () => {
  it('remembers deliveries across restarts (a new instance on the same file)', async () => {
    const file = tmpFile();
    const [raw, e] = delivery('Platform.Invoice.Paid', { invoiceId: 'i9' });
    assert.equal(await new FileInbox({ file }).record(raw, e), 'new');
    const restarted = new FileInbox({ file });
    assert.equal(await restarted.record(raw, e), 'duplicate');
    assert.ok(await restarted.waitFor(x => x.event === 'Platform.Invoice.Paid', { since: new Date(0), timeoutMs: 50 }));
  });

  it('does not mark a delivery seen when the write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oncade-inbox-'));
    const inbox = new FileInbox({ file: dir }); // a directory: appending to it throws
    const [raw, e] = delivery('X');
    await assert.rejects(inbox.record(raw, e));
    await assert.rejects(inbox.record(raw, e), 'still not seen, so it tries (and fails) again rather than saying duplicate');
  });
});
