// Probes undocumented Idempotency-Key behaviour: same key twice (same body / different body), then cleans up.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { OncadeApiError, OncadeClient } from './client.ts';
import { loadConfig } from './config.ts';
import type { CreateInvoiceInput } from './types.ts';

const cfg = loadConfig();
const businessId = cfg.businessId ?? (existsSync('.data/state.json') ? JSON.parse(readFileSync('.data/state.json', 'utf8')).businessId : undefined);
if (!businessId) throw new Error('Run `npm run flow` first (or set ONCADE_BUSINESS_ID)');
const biz = new OncadeClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, debug: cfg.debug }).forBusiness(businessId);

const body = (amount: number): CreateInvoiceInput => ({
  receiverName: 'Idempotency Probe', receiverEmail: cfg.invoiceReceiverEmail, date: new Date().toISOString(),
  payToTarget: 'BUSINESS', items: [{ description: 'probe', quantity: 1, rate: amount, amount }], total: amount,
  externalMetadata: { source: 'idempotency-check' },
});

const key = randomUUID();
const created = new Set<string>();
const attempt = async (label: string, b: CreateInvoiceInput) => {
  try {
    const inv = await biz.createInvoice(b, key);
    created.add(inv._id);
    console.log(`${label.padEnd(28)} -> ${inv._id} total=${inv.total}`);
  } catch (e) {
    console.log(`${label.padEnd(28)} -> ${e instanceof OncadeApiError ? `HTTP ${e.status} ${JSON.stringify(e.body)}` : e}`);
  }
};

await attempt('1st call', body(5));
await attempt('same key, same body', body(5));
await attempt('same key, different body', body(7));
console.log(created.size === 1 ? 'Result: deduplicated (one invoice)' : `Result: ${created.size} invoices created with one key`);
for (const id of created) await biz.cancelInvoice(id).catch(() => {});
