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

function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
}

export function loadConfig(need: { api?: boolean; webhooks?: boolean } = { api: true }): Config {
  const apiKey = need.api ? env('ONCADE_API_KEY') : env('ONCADE_API_KEY', '');
  if (apiKey && !apiKey.startsWith('oncade_platform_test_')) {
    // This PoC must never run against live money.
    throw new Error('ONCADE_API_KEY is not a test key (expected prefix oncade_platform_test_). Refusing to run.');
  }
  return {
    apiKey,
    webhookSecret: need.webhooks ? env('ONCADE_WEBHOOK_SECRET') : env('ONCADE_WEBHOOK_SECRET', ''),
    baseUrl: env('ONCADE_BASE_URL', 'https://www.oncade.gg/api').replace(/\/+$/, ''),
    businessOwnerEmail: env('BUSINESS_OWNER_EMAIL', ''),
    invoiceReceiverEmail: env('INVOICE_RECEIVER_EMAIL', 'test-receiver@example.com'),
    sendInvoiceEmail: env('SEND_INVOICE_EMAIL', 'false') === 'true',
    payoutWallet: env('PAYOUT_WALLET', '0x000000000000000000000000000000000000dEaD'),
    businessId: env('ONCADE_BUSINESS_ID', '') || undefined,
    webhookPort: Number(env('WEBHOOK_PORT', '3000')),
    debug: env('ONCADE_DEBUG', 'false') === 'true',
  };
}
