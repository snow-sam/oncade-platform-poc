import { OncadeClient } from './client.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const client = new OncadeClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, debug: cfg.debug });
console.log(JSON.stringify(await client.me(), null, 2));
