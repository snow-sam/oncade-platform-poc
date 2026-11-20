// Sends signed + tampered fake deliveries to the local receiver, to prove verification works
// without depending on Oncade (the docs describe no "send test event" for platform webhooks).
import { WEBHOOK_PATH, loadConfig } from './config.ts';
import { computeSignature } from './webhooks.ts';

const config = loadConfig({ api: false, webhooks: true });
const url = `http://localhost:${config.webhookPort}${WEBHOOK_PATH}`;
const body = JSON.stringify({ event: 'Selftest.Ping', data: { at: Date.now() }, timestamp: new Date().toISOString() });

async function postDelivery(label: string, signature: string | undefined) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-oncade-event': 'Selftest.Ping' };
  if (signature) headers['x-oncade-signature'] = signature;
  const response = await fetch(url, { method: 'POST', headers, body });
  console.log(`${label.padEnd(22)} -> ${response.status} ${await response.text()}`);
}

await postDelivery('valid signature', computeSignature(body, config.webhookSecret));
await postDelivery('replayed (duplicate)', computeSignature(body, config.webhookSecret));
await postDelivery('wrong secret', computeSignature(body, 'not-the-secret'));
await postDelivery('missing signature', undefined);
