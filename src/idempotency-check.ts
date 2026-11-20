// Probes undocumented Idempotency-Key behaviour: same key twice (same body / different body), then cleans up.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { OncadeApiError, OncadeClient } from './client.ts';
import { STATE_FILE, loadConfig } from './config.ts';
import type { CreateInvoiceInput } from './types.ts';

const config = loadConfig();
const savedBusinessId = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')).businessId : undefined;
const businessId = config.businessId ?? savedBusinessId;
if (!businessId) throw new Error('Run `npm run flow` first (or set ONCADE_BUSINESS_ID)');
const businessClient = new OncadeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, debug: config.debug }).forBusiness(businessId);

const invoiceFor = (amount: number): CreateInvoiceInput => ({
  receiverName: 'Idempotency Probe', receiverEmail: config.invoiceReceiverEmail, date: new Date().toISOString(),
  payToTarget: 'BUSINESS', items: [{ description: 'probe', quantity: 1, rate: amount, amount }], total: amount,
  externalMetadata: { source: 'idempotency-check' },
});

const LABEL_WIDTH = 28; // longest label below, so results line up
const idempotencyKey = randomUUID();
const createdIds = new Set<string>();

async function createWithSameKey(label: string, input: CreateInvoiceInput) {
  try {
    const invoice = await businessClient.createInvoice(input, idempotencyKey);
    createdIds.add(invoice._id);
    console.log(`${label.padEnd(LABEL_WIDTH)} -> ${invoice._id} total=${invoice.total}`);
  } catch (err) {
    console.log(`${label.padEnd(LABEL_WIDTH)} -> ${err instanceof OncadeApiError ? `HTTP ${err.status} ${JSON.stringify(err.body)}` : err}`);
  }
}

await createWithSameKey('1st call', invoiceFor(5));
await createWithSameKey('same key, same body', invoiceFor(5));
await createWithSameKey('same key, different body', invoiceFor(7));
console.log(createdIds.size === 1 ? 'Result: deduplicated (one invoice)' : `Result: ${createdIds.size} invoices created with one key`);
for (const invoiceId of createdIds) await businessClient.cancelInvoice(invoiceId).catch(() => {});
