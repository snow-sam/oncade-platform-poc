// Sends signed + tampered fake deliveries to the local receiver, to prove verification works
// without depending on Oncade (the docs describe no "send test event" for platform webhooks).
import { WEBHOOK_PATH, loadConfig } from './config.ts';
import { SIGNATURE_HEADER, computeSignature } from './webhooks.ts';

const SELFTEST_EVENT = 'Selftest.Ping';
const LABEL_WIDTH = 22; // longest label below, so results line up

const config = loadConfig({ api: false, webhooks: true });
const url = `http://localhost:${config.webhookPort}${WEBHOOK_PATH}`;
const body = JSON.stringify({ event: SELFTEST_EVENT, data: { at: Date.now() }, timestamp: new Date().toISOString() });

async function postDelivery(label: string, signature: string | undefined) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-oncade-event': SELFTEST_EVENT };
  if (signature) headers[SIGNATURE_HEADER] = signature;
  const response = await fetch(url, { method: 'POST', headers, body });
  console.log(`${label.padEnd(LABEL_WIDTH)} -> ${response.status} ${await response.text()}`);
}

await postDelivery('valid signature', computeSignature(body, config.webhookSecret));
await postDelivery('replayed (duplicate)', computeSignature(body, config.webhookSecret));
await postDelivery('wrong secret', computeSignature(body, 'not-the-secret'));
await postDelivery('missing signature', undefined);
