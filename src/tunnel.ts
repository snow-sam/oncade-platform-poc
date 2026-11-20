// Starts a cloudflared quick tunnel to the webhook receiver's port (WEBHOOK_PORT) and prints the URL to paste in the portal.
import { spawn } from 'node:child_process';
import { WEBHOOK_PATH, loadConfig } from './config.ts';

const { webhookPort } = loadConfig({ api: false });
const cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${webhookPort}`], { stdio: ['ignore', 'inherit', 'pipe'] });

let urlShown = false;
cloudflared.stderr.on('data', (chunk: Buffer) => {
  const output = chunk.toString();
  process.stderr.write(output);
  const tunnelUrl = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (tunnelUrl && !urlShown) {
    urlShown = true;
    console.log(`\n>>> Webhook URL for dev.oncade.xyz Platform > Settings:\n>>> ${tunnelUrl}${WEBHOOK_PATH}\n`);
  }
});
cloudflared.on('error', err => { console.error(`Could not start cloudflared: ${err.message}`); process.exit(1); });
cloudflared.on('exit', code => process.exit(code ?? 0));
