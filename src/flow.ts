/**
 * End-to-end demo against the Oncade test environment. Presentation only: the Invoice lifecycle module
 * (src/invoice-lifecycle.ts) does the confirming.
 *
 *   1. Platform identity      GET  /v1/platform/me
 *   2. Business               POST /v1/platform/business (or reuse the one saved in .data/state.json)
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
import { dirname } from 'node:path';
import { OncadeClient } from './client.ts';
import { EVENTS_FILE, HEALTH_PATH, RECEIVER_ID, STATE_FILE, loadConfig } from './config.ts';
import { type Confirmation, INVOICE_EVENTS, type InvoiceDraft, InvoiceLifecycle, InvoiceLifecycleError } from './invoice-lifecycle.ts';
import type { PlatformIdentity } from './types.ts';
import { FileInbox } from './webhook-inbox.ts';

const args = new Set(process.argv.slice(2));
const KEEP_INVOICE = args.has('--keep');
const NEW_BUSINESS = args.has('--new-business');

/** Scopes the flow needs. The key is checked for them, and a new business grants the ones the key holds. */
const FLOW_SCOPES = [
  'business:read', 'business:update',
  'invoice:create', 'invoice:read', 'invoice:update', 'invoice:send', 'invoice:cancel',
];
const DAY_MS = 86_400_000;
const INVOICE_DUE_IN_DAYS = 30;

const config = loadConfig();
const client = new OncadeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, debug: config.debug });

// --- Output -----------------------------------------------------------------
let stepNumber = 0;
function step(message: string) { console.log(`\n[${++stepNumber}] ${message}`); }
function ok(message: string, details?: unknown) { console.log(`    ✓ ${message}`, details ?? ''); }
function warn(message: string) { console.log(`    ! ${message}`); }

function report({ invoice, webhook }: Confirmation, eventName: string) {
  ok(`API confirms ${invoice._id} status=${invoice.status}`);
  if (webhook.status === 'received') ok(`webhook ${eventName} received`, webhook.event.data);
  else if (webhook.status === 'timeout') warn(`no ${eventName} webhook in time - is the tunnel URL set in dev.oncade.xyz Platform > Settings?`);
  else warn(`webhook wait skipped (receiver not running)`);
}

/** `2026-11-19 21:45:12`: an ISO timestamp without milliseconds or zone, readable in the portal. */
function timestampLabel(date: Date): string {
  return date.toISOString().slice(0, 'YYYY-MM-DDTHH:mm:ss'.length).replace('T', ' ');
}

// --- Saved state ------------------------------------------------------------
interface SavedState { businessId?: string }

function loadState(): SavedState {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
function saveState(state: SavedState) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Steps ------------------------------------------------------------------
async function checkPlatformIdentity(): Promise<PlatformIdentity> {
  step('Platform identity (GET /v1/platform/me)');
  const identity = await client.getPlatformIdentity();
  ok(`platform ${identity.platformId} (${identity.status}) env=${identity.environment}`, { effectiveScopes: [...identity.effectiveScopes] });
  if (identity.unapprovedKeyScopes.length) warn(`key has scopes the platform hasn't approved: ${identity.unapprovedKeyScopes.join(', ')}`);
  const missingScopes = FLOW_SCOPES.filter(scope => !identity.can(scope));
  if (missingScopes.length) warn(`key lacks scopes: ${missingScopes.join(', ')} - some steps may 403`);
  return identity;
}

/** Reuses the configured or saved business, or creates one (saving its id for the next run). */
async function ensureBusiness(identity: PlatformIdentity): Promise<string> {
  step('Business');
  const existingId = NEW_BUSINESS ? undefined : (config.businessId ?? loadState().businessId);
  if (existingId) {
    ok(`reusing business ${existingId}`);
    return existingId;
  }
  if (!config.businessOwnerEmail) throw new Error('Set BUSINESS_OWNER_EMAIL in .env to create a business');
  const created = await client.createBusiness({
    name: `PoC Business ${timestampLabel(new Date())}`,
    members: [{ email: config.businessOwnerEmail, roles: ['admin'], isOwner: true }],
    payoutWallet: config.payoutWallet, // invoices 400 without one
    address: { line1: '1 Test Street', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    grantScopes: FLOW_SCOPES.filter(scope => identity.can(scope)),
  });
  const businessId = created.business._id;
  saveState({ businessId });
  ok(`created business ${businessId}`, { grant: created.grant, links: created.links });
  return businessId;
}

/** Informational only: a business that isn't fully ready can still create test invoices. */
async function checkReadiness(businessClient: OncadeClient) {
  step('Readiness (GET /v1/platform/business/readiness)');
  try {
    const readiness = await businessClient.getReadiness();
    ok(`ready=${readiness.ready}`, readiness.steps);
    if (!readiness.ready) warn('business not fully ready (KYB etc.) - continuing, test invoices may still work');
  } catch (err) {
    warn(`readiness failed: ${(err as Error).message}`);
  }
}

/**
 * Whether the webhook receiver is running. It's a question about how this demo is wired, not about the lifecycle,
 * so it's answered here. The body is checked, not just the 200: another local app on the same port once passed a
 * status-only check.
 */
async function isReceiverUp(): Promise<boolean> {
  return fetch(`http://localhost:${config.webhookPort}${HEALTH_PATH}`)
    .then(async response => response.ok && (await response.text()) === RECEIVER_ID, () => false);
}

/** A $60 two-line invoice to the configured receiver, due in INVOICE_DUE_IN_DAYS, tagged with a run id. */
function sampleInvoiceDraft(): InvoiceDraft {
  const today = new Date();
  return {
    receiverName: 'PoC Customer',
    receiverEmail: config.invoiceReceiverEmail,
    date: today.toISOString(),
    dueDate: new Date(today.getTime() + INVOICE_DUE_IN_DAYS * DAY_MS).toISOString(),
    payToTarget: 'BUSINESS',
    items: [
      { description: 'Integration consulting (hours)', quantity: 2, rate: 25, amount: 50 },
      { description: 'Webhook setup', quantity: 1, rate: 10, amount: 10 },
    ],
    total: 60,
    note: 'Created by oncade-platform-poc',
    externalMetadata: { source: 'oncade-platform-poc', runId: randomUUID() },
  };
}

function httpStatusOf(err: unknown): number | undefined {
  const source = err instanceof InvoiceLifecycleError ? err.cause : err;
  return (source as { status?: number } | undefined)?.status;
}

// --- Flow -------------------------------------------------------------------
async function main() {
  const identity = await checkPlatformIdentity();
  const businessClient = client.forBusiness(await ensureBusiness(identity));
  await checkReadiness(businessClient);

  const receiverUp = await isReceiverUp();
  if (!receiverUp) warn('webhook receiver not running (npm run webhooks) - confirming via API only');
  const lifecycle = new InvoiceLifecycle(businessClient, { events: receiverUp ? new FileInbox({ file: EVENTS_FILE }) : undefined });

  step('issue() - draft invoice');
  const issued = await lifecycle.issue(sampleInvoiceDraft());
  const invoiceId = issued.invoice._id;
  ok(`invoice ${issued.invoice.invoiceNumber}`, { paymentSummary: issued.invoice.paymentSummary, link: issued.invoice.links?.invoice });
  report(issued, INVOICE_EVENTS.created);

  step(`send() - sendEmail=${config.sendInvoiceEmail}`);
  report(await lifecycle.send(invoiceId, { sendEmail: config.sendInvoiceEmail }), INVOICE_EVENTS.sent);

  if (KEEP_INVOICE) {
    console.log(`\n--keep: leaving invoice "sent". Pay it at ${issued.invoice.links?.invoice ?? '(no link)'} and watch for ${INVOICE_EVENTS.paid} in the webhook terminal.`);
    return;
  }

  step('cancel()');
  report(await lifecycle.cancel(invoiceId), INVOICE_EVENTS.cancelled);

  console.log('\nDone: draft -> sent -> cancelled, each confirmed by the API.');
}

main().catch(err => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  const status = httpStatusOf(err);
  if (status === 401) console.error('  Check ONCADE_API_KEY.');
  if (status === 403) console.error('  Missing scope or grant - check the key scopes in dev.oncade.xyz.');
  process.exit(1);
});
