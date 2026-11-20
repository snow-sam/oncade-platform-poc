import { OncadeClient } from './client.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const client = new OncadeClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, debug: config.debug });
const identity = await client.getPlatformIdentity();
console.log(JSON.stringify({ ...identity, effectiveScopes: [...identity.effectiveScopes].sort() }, null, 2));
