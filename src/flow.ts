/**
 * End-to-end invoice flow against the Oncade test environment:
 *
 *   1. GET  /v1/platform/me                       verify key, read approved scopes
 *   2. POST /v1/platform/business                 create a business + auto-grant our platform (or reuse one)
 *   3. GET  /v1/platform/business/readiness       payout wallet / address / KYB status
 *   4. POST /v1/platform/invoices                 create a draft invoice      -> Platform.Invoice.Created
 *   5. POST /v1/platform/invoices/:id/send        send it                     -> Platform.Invoice.Sent
 *   6. GET  /v1/platform/invoices/:id             confirm state from the API (source of truth)
 *   7. POST /v1/platform/invoices/:id/cancel      clean up (skip with --keep) -> Platform.Invoice.Cancelled
 *
 * Webhooks are received by `npm run webhooks` (separate process) and read back here from .data/events.jsonl.
 *
 * Usage: npm run flow [-- --keep] [-- --new-business]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OncadeApiError, OncadeClient } from './client.ts';
import { loadConfig } from './config.ts';
import { DATA_DIR, readEvents, waitForEvent } from './eventlog.ts';
import { payloadMentions } from './webhooks.ts';

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const NEW_BUSINESS = args.has('--new-business');
const STATE = resolve(DATA_DIR, 'state.json');

const cfg = loadConfig();
const platform = new OncadeClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, debug: cfg.debug });

const WANTED_SCOPES = [
  'business:read', 'business:update',
  'invoice:create', 'invoice:read', 'invoice:update', 'invoice:send', 'invoice:cancel',
];

function step(n: number, msg: string) { console.log(`\n[${n}] ${msg}`); }
function ok(msg: string, extra?: unknown) { console.log(`    ✓ ${msg}`, extra ?? ''); }
function warn(msg: string) { console.log(`    ! ${msg}`); }

function loadState(): { businessId?: string } {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
}
function saveState(s: { businessId?: string }) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function expectWebhook(name: string, invoiceId: string, since: Date, fallback: () => Promise<boolean>) {
  const webhookServerUp = await fetch(`http://localhost:${cfg.webhookPort}/health`).then(r => r.ok, () => false);
  if (!webhookServerUp) {
    warn(`webhook receiver not running (npm run webhooks) - checking state via API instead of ${name}`);
    if (await fallback()) ok(`API confirms state for ${name}`);
    return;
  }
  // Invoice webhook payloads aren't documented, so match on the event name + our invoice id anywhere in data.
  const hit = await waitForEvent(e => e.event === name && payloadMentions(e.data, invoiceId), { since, timeoutMs: 60_000 });
  if (hit) return ok(`webhook ${name} received`, hit.data);
  const sameName = readEvents().filter(e => e.event === name && new Date(e.receivedAt) >= since);
  if (sameName.length) warn(`got ${name} but couldn't find invoice id ${invoiceId} in its data: ${JSON.stringify(sameName.at(-1)?.data)}`);
  else warn(`no ${name} webhook within 60s - is the tunnel URL set in dev.oncade.xyz Platform > Settings?`);
}

async function main() {
  step(1, 'Verify API key (GET /v1/platform/me)');
  const me = await platform.me();
  const active = me.activeScopes ?? [];
  ok(`platform ${me.platformId} env=${me.keyInfo?.environment}`, { activeScopes: active, pendingScopes: me.pendingScopes });
  if (me.keyInfo?.environment && me.keyInfo.environment !== 'test') throw new Error('Not a test key');
  const missing = WANTED_SCOPES.filter(s => !active.includes(s));
  if (missing.length) warn(`key lacks scopes: ${missing.join(', ')} - some steps may 403`);

  step(2, 'Business');
  let businessId = NEW_BUSINESS ? undefined : (cfg.businessId ?? loadState().businessId);
  if (businessId) {
    ok(`reusing business ${businessId}`);
  } else {
    if (!cfg.businessOwnerEmail) throw new Error('Set BUSINESS_OWNER_EMAIL in .env to create a business');
    const created = await platform.createBusiness({
      name: `PoC Business ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      members: [{ email: cfg.businessOwnerEmail, roles: ['admin'], isOwner: true }],
      payoutWallet: cfg.payoutWallet, // invoices 400 without one
      address: { line1: '1 Test Street', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      grantScopes: WANTED_SCOPES.filter(s => active.includes(s)),
    });
    businessId = created.business._id;
    saveState({ businessId });
    ok(`created business ${businessId}`, { grant: created.grant, links: created.links });
  }
  const biz = platform.forBusiness(businessId);

  step(3, 'Readiness (GET /v1/platform/business/readiness)');
  try {
    const r = await biz.readiness();
    ok(`ready=${r.ready}`, r.steps);
    if (!r.ready) warn('business not fully ready (KYB etc.) - continuing, test invoices may still work');
  } catch (e) {
    warn(`readiness failed: ${(e as Error).message}`);
  }

  step(4, 'Create draft invoice (POST /v1/platform/invoices)');
  const runId = randomUUID();
  const today = new Date();
  const due = new Date(today.getTime() + 30 * 86_400_000);
  const t0 = new Date(Date.now() - 2000);
  const invoice = await biz.createInvoice({
    receiverName: 'PoC Customer',
    receiverEmail: cfg.invoiceReceiverEmail,
    date: today.toISOString(),
    dueDate: due.toISOString(),
    payToTarget: 'BUSINESS',
    items: [
      { description: 'Integration consulting (hours)', quantity: 2, rate: 25, amount: 50 },
      { description: 'Webhook setup', quantity: 1, rate: 10, amount: 10 },
    ],
    total: 60,
    note: 'Created by oncade-platform-poc',
    externalMetadata: { source: 'oncade-platform-poc', runId },
    status: 'draft',
  }, `invoice-${runId}`);
  ok(`invoice ${invoice._id} status=${invoice.status}`, {
    invoiceNumber: invoice.invoiceNumber, paymentSummary: invoice.paymentSummary, link: invoice.links?.invoice,
  });
  await expectWebhook('Platform.Invoice.Created', invoice._id, t0,
    async () => (await biz.getInvoice(invoice._id)).status === 'draft');

  step(5, `Send invoice (POST /v1/platform/invoices/:id/send, sendEmail=${cfg.sendInvoiceEmail})`);
  const t1 = new Date(Date.now() - 2000);
  const sent = await biz.sendInvoice(invoice._id, { sendEmail: cfg.sendInvoiceEmail });
  ok(`status=${sent.status} emailSuppressed=${sent.emailSuppressed}`);
  await expectWebhook('Platform.Invoice.Sent', invoice._id, t1,
    async () => (await biz.getInvoice(invoice._id)).status === 'sent');

  step(6, 'Read back (GET /v1/platform/invoices/:id)');
  const fresh = await biz.getInvoice(invoice._id);
  ok(`status=${fresh.status}`, { externalMetadata: fresh.externalMetadata, link: fresh.links?.invoice });

  if (KEEP) {
    console.log(`\n--keep: leaving invoice in "${fresh.status}". Pay it at ${fresh.links?.invoice ?? '(no link)'} and watch for Platform.Invoice.Paid in the webhook terminal.`);
    return;
  }

  step(7, 'Cancel (POST /v1/platform/invoices/:id/cancel)');
  const t2 = new Date(Date.now() - 2000);
  const cancelled = await biz.cancelInvoice(invoice._id);
  ok(`status=${cancelled.status}`);
  await expectWebhook('Platform.Invoice.Cancelled', invoice._id, t2,
    async () => (await biz.getInvoice(invoice._id)).status === 'cancelled');

  console.log('\nDone: draft -> sent -> cancelled, with webhooks.');
}

main().catch(err => {
  if (err instanceof OncadeApiError) {
    console.error(`\n✗ API error: ${err.message}`);
    if (err.status === 401) console.error('  Check ONCADE_API_KEY.');
    if (err.status === 403) console.error('  Missing scope or grant - check the key scopes in dev.oncade.xyz.');
  } else {
    console.error('\n✗', err);
  }
  process.exit(1);
});
