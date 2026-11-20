// Starts a cloudflared quick tunnel to the webhook receiver's port (WEBHOOK_PORT) and prints the URL to paste in the portal.
import { spawn } from 'node:child_process';

const port = process.env.WEBHOOK_PORT?.trim() || '3001';
const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'inherit', 'pipe'] });

let shown = false;
child.stderr.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  process.stderr.write(text);
  const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !shown) {
    shown = true;
    console.log(`\n>>> Webhook URL for dev.oncade.xyz Platform > Settings:\n>>> ${url}/webhooks/oncade\n`);
  }
});
child.on('error', e => { console.error(`Could not start cloudflared: ${e.message}`); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));
