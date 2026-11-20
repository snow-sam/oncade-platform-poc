import { resolve } from 'node:path';

/** Local state shared by the receiver and the flow (event log, saved business id). */
export const DATA_DIR = resolve('.data');
/** The Webhook inbox file: the receiver appends to it, the flow polls it. */
export const EVENTS_FILE = resolve(DATA_DIR, 'events.jsonl');
/** The flow's saved state (the business it created), reused by later runs and by idempotency-check. */
export const STATE_FILE = resolve(DATA_DIR, 'state.json');

/** Path the receiver serves webhooks on. The full URL goes in dev.oncade.xyz → Platform → Settings. */
export const WEBHOOK_PATH = '/webhooks/oncade';
/** Path of the receiver's liveness check; it answers with RECEIVER_ID. */
export const HEALTH_PATH = '/health';
/** Body of the receiver's HEALTH_PATH. The flow checks it, so another app on the same port isn't mistaken for it. */
export const RECEIVER_ID = 'oncade-platform-poc/webhooks';

export interface Config {
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
  businessOwnerEmail: string;
  invoiceReceiverEmail: string;
  sendInvoiceEmail: boolean;
  payoutWallet: string;
  businessId?: string;
  webhookPort: number;
  debug: boolean;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
}

export function loadConfig(required: { api?: boolean; webhooks?: boolean } = { api: true }): Config {
  const apiKey = required.api ? readEnv('ONCADE_API_KEY') : readEnv('ONCADE_API_KEY', '');
  // The live-key guard lives in OncadeClient's constructor, so every caller gets it.
  return {
    apiKey,
    webhookSecret: required.webhooks ? readEnv('ONCADE_WEBHOOK_SECRET') : readEnv('ONCADE_WEBHOOK_SECRET', ''),
    baseUrl: readEnv('ONCADE_BASE_URL', 'https://www.oncade.gg/api').replace(/\/+$/, ''),
    businessOwnerEmail: readEnv('BUSINESS_OWNER_EMAIL', ''),
    invoiceReceiverEmail: readEnv('INVOICE_RECEIVER_EMAIL', 'test-receiver@example.com'),
    sendInvoiceEmail: readEnv('SEND_INVOICE_EMAIL', 'false') === 'true',
    payoutWallet: readEnv('PAYOUT_WALLET', '0x000000000000000000000000000000000000dEaD'),
    businessId: readEnv('ONCADE_BUSINESS_ID', '') || undefined,
    webhookPort: Number(readEnv('WEBHOOK_PORT', '3001')),
    debug: readEnv('ONCADE_DEBUG', 'false') === 'true',
  };
}
