import { OncadeClient } from './client.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const client = new OncadeClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, debug: cfg.debug });
const p = await client.platform();
console.log(JSON.stringify({ ...p, scopes: [...p.scopes].sort() }, null, 2));
