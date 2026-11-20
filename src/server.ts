import { createServer } from 'node:http';
import { EVENTS_FILE, HEALTH_PATH, RECEIVER_ID, WEBHOOK_PATH, loadConfig } from './config.ts';
import { INVOICE_EVENTS } from './invoice-lifecycle.ts';
import { FileInbox } from './webhook-inbox.ts';
import { createWebhookHandler } from './webhooks.ts';
import type { WebhookEvent } from './types.ts';

const config = loadConfig({ webhooks: true });

/** Reactions to stored events (store first, react later). Kept deliberately small: logging only. */
function reactTo(event: WebhookEvent) {
  const data = event.data ?? {};
  switch (event.event) {
    case INVOICE_EVENTS.created:
    case INVOICE_EVENTS.updated:
    case INVOICE_EVENTS.sent:
    case INVOICE_EVENTS.cancelled:
      console.log(`  invoice event ${event.event}`, data);
      break;
    case INVOICE_EVENTS.paid:
      // Where a real integration would mark the order paid / release goods (idempotently!).
      console.log('  💰 invoice paid', data);
      break;
    case 'Platform.Link.Completed':
      console.log('  business granted access', data);
      break;
    case 'Platform.Verification.Completed':
      console.log('  verification completed', data);
      break;
    default:
      console.log(`  unhandled event ${event.event}`, data);
  }
}

const handleWebhook = createWebhookHandler({
  secret: config.webhookSecret,
  inbox: new FileInbox({ file: EVENTS_FILE }),
  log: message => console.warn(`[webhooks] ${message}`),
  // Runs after the delivery is stored and acknowledged; a failure here can't lose the event.
  afterRecord: (event, meta) => {
    console.log(`[webhooks] ${new Date().toISOString()} ${event.event} (platform ${meta.platformId ?? '?'})`);
    reactTo(event);
  },
});

createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (path === HEALTH_PATH) return void res.writeHead(200).end(RECEIVER_ID);
  if (path === WEBHOOK_PATH) return void handleWebhook(req, res);
  res.writeHead(404).end();
}).listen(config.webhookPort, () => {
  console.log(`Webhook receiver on http://localhost:${config.webhookPort}${WEBHOOK_PATH}`);
  console.log('Expose it with: npm run tunnel   (prints the URL to paste in dev.oncade.xyz Platform > Settings)');
});
