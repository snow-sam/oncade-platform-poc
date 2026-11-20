import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { appendEvent, FileDedupeStore } from './eventlog.ts';
import { createWebhookHandler } from './webhooks.ts';
import type { WebhookEvent } from './types.ts';

const cfg = loadConfig({ webhooks: true });

/** Business reactions to events. Kept deliberately small - logging + the shared event log. */
function handle(event: WebhookEvent) {
  const d = event.data ?? {};
  switch (event.event) {
    case 'Platform.Invoice.Created':
    case 'Platform.Invoice.Updated':
    case 'Platform.Invoice.Sent':
    case 'Platform.Invoice.Cancelled':
      console.log(`  invoice event ${event.event}`, d);
      break;
    case 'Platform.Invoice.Paid':
      // Where a real integration would mark the order paid / release goods (idempotently!).
      console.log('  💰 invoice paid', d);
      break;
    case 'Platform.Link.Completed':
      console.log('  business granted access', d);
      break;
    case 'Platform.Verification.Completed':
      console.log('  verification completed', d);
      break;
    default:
      console.log(`  unhandled event ${event.event}`, d);
  }
}

const handler = createWebhookHandler({
  secret: cfg.webhookSecret,
  dedupe: new FileDedupeStore(),
  log: m => console.warn(`[webhooks] ${m}`),
  onEvent: (event, meta) => {
    console.log(`[webhooks] ${new Date().toISOString()} ${event.event} (platform ${meta.platformId ?? '?'})`);
    appendEvent({ ...event, receivedAt: new Date().toISOString(), deliveryKey: meta.deliveryKey });
    handle(event);
  },
});

createServer((req, res) => {
  if (req.url === '/health') return void res.writeHead(200).end('ok');
  if (req.url?.split('?')[0] === '/webhooks/oncade') return void handler(req, res);
  res.writeHead(404).end();
}).listen(cfg.webhookPort, () => {
  console.log(`Webhook receiver on http://localhost:${cfg.webhookPort}/webhooks/oncade`);
  console.log('Expose it with: npm run tunnel   (prints the URL to paste in dev.oncade.xyz Platform > Settings)');
});
