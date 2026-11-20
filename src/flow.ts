/**
 * End-to-end demo against the Oncade test environment. Presentation only: the Invoice lifecycle module
 * (src/invoice-lifecycle.ts) does the confirming.
 *
 *   1. Platform identity      GET  /v1/platform/me
 *   2. Business               POST /v1/platform/business (or reuse one from .data/state.json)
 *   3. Readiness              GET  /v1/platform/business/readiness
 *   4. issue()                POST /v1/platform/invoices            -> Platform.Invoice.Created
 *   5. send()                 POST /v1/platform/invoices/:id/send   -> Platform.Invoice.Sent
 *   6. cancel() (or --keep)   POST /v1/platform/invoices/:id/cancel -> Platform.Invoice.Cancelled
 *
 * Webhooks are received by `npm run webhooks` (separate process). If it isn't running, webhook waits are skipped.
 *
 * Usage: npm run flow [-- --keep] [-- --new-business]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OncadeClient } from './client.ts';
import { DATA_DIR, EVENTS_FILE, loadConfig } from './config.ts';
import { type Confirmation, InvoiceLifecycle, InvoiceLifecycleError } from './invoice-lifecycle.ts';
import { FileInbox } from './webhook-inbox.ts';

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

function report({ invoice, webhook }: Confirmation, eventName: string) {
  ok(`API confirms ${invoice._id} status=${invoice.status}`);
  if (webhook.status === 'received') ok(`webhook ${eventName} received`, webhook.event.data);
  else if (webhook.status === 'timeout') warn(`no ${eventName} webhook in time - is the tunnel URL set in dev.oncade.xyz Platform > Settings?`);
  else warn(`webhook wait skipped (receiver not running)`);
}

function loadState(): { businessId?: string } {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
}
function saveState(s: { businessId?: string }) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function main() {
  step(1, 'Platform identity (GET /v1/platform/me)');
  const identity = await platform.platform();
  ok(`platform ${identity.platformId} (${identity.status}) env=${identity.environment}`, { effectiveScopes: [...identity.scopes] });
  if (identity.unapprovedKeyScopes.length) warn(`key has scopes the platform hasn't approved: ${identity.unapprovedKeyScopes.join(', ')}`);
  const missing = WANTED_SCOPES.filter(s => !identity.can(s));
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
      grantScopes: WANTED_SCOPES.filter(s => identity.can(s)),
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

  // Whether the receiver runs is about how this demo is wired, not about the lifecycle: decide here.
  // Check the body, not just 200: another local app on the same port once passed a status-only check.
  const receiverUp = await fetch(`http://localhost:${cfg.webhookPort}/health`)
    .then(async r => r.ok && (await r.text()) === 'oncade-platform-poc/webhooks', () => false);
  if (!receiverUp) warn('webhook receiver not running (npm run webhooks) - confirming via API only');
  const lifecycle = new InvoiceLifecycle(biz, { events: receiverUp ? new FileInbox({ file: EVENTS_FILE }) : undefined });

  step(4, 'issue() - draft invoice');
  const today = new Date();
  const issued = await lifecycle.issue({
    receiverName: 'PoC Customer',
    receiverEmail: cfg.invoiceReceiverEmail,
    date: today.toISOString(),
    dueDate: new Date(today.getTime() + 30 * 86_400_000).toISOString(),
    payToTarget: 'BUSINESS',
    items: [
      { description: 'Integration consulting (hours)', quantity: 2, rate: 25, amount: 50 },
      { description: 'Webhook setup', quantity: 1, rate: 10, amount: 10 },
    ],
    total: 60,
    note: 'Created by oncade-platform-poc',
    externalMetadata: { source: 'oncade-platform-poc', runId: randomUUID() },
  });
  const id = issued.invoice._id;
  ok(`invoice ${issued.invoice.invoiceNumber}`, { paymentSummary: issued.invoice.paymentSummary, link: issued.invoice.links?.invoice });
  report(issued, 'Platform.Invoice.Created');

  step(5, `send() - sendEmail=${cfg.sendInvoiceEmail}`);
  report(await lifecycle.send(id, { sendEmail: cfg.sendInvoiceEmail }), 'Platform.Invoice.Sent');

  if (KEEP) {
    console.log(`\n--keep: leaving invoice "sent". Pay it at ${issued.invoice.links?.invoice ?? '(no link)'} and watch for Platform.Invoice.Paid in the webhook terminal.`);
    return;
  }

  step(6, 'cancel()');
  report(await lifecycle.cancel(id), 'Platform.Invoice.Cancelled');

  console.log('\nDone: draft -> sent -> cancelled, each confirmed by the API.');
}

main().catch(err => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  const status = (err instanceof InvoiceLifecycleError ? (err.cause as { status?: number } | undefined) : (err as { status?: number }))?.status;
  if (status === 401) console.error('  Check ONCADE_API_KEY.');
  if (status === 403) console.error('  Missing scope or grant - check the key scopes in dev.oncade.xyz.');
  process.exit(1);
});
