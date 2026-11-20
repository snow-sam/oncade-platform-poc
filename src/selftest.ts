// Sends signed + tampered fake deliveries to the local receiver, to prove verification works
// without depending on Oncade (the docs describe no "send test event" for platform webhooks).
import { loadConfig } from './config.ts';
import { sign } from './webhooks.ts';

const cfg = loadConfig({ api: false, webhooks: true });
const url = `http://localhost:${cfg.webhookPort}/webhooks/oncade`;
const body = JSON.stringify({ event: 'Selftest.Ping', data: { at: Date.now() }, timestamp: new Date().toISOString() });

async function post(label: string, signature: string | undefined) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-oncade-event': 'Selftest.Ping' };
  if (signature) headers['x-oncade-signature'] = signature;
  const res = await fetch(url, { method: 'POST', headers, body });
  console.log(`${label.padEnd(22)} -> ${res.status} ${await res.text()}`);
}

await post('valid signature', sign(body, cfg.webhookSecret));
await post('replayed (duplicate)', sign(body, cfg.webhookSecret));
await post('wrong secret', sign(body, 'not-the-secret'));
await post('missing signature', undefined);
