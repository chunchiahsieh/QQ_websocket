import { readFile, writeFile } from 'node:fs/promises';

// Render provides secrets to the build process, while Wrangler's local
// Worker runtime reads bindings from the generated config. Copy only the
// allow-listed values into that ephemeral build artifact; never commit them.
const configPath = 'dist/server/wrangler.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const vars = { ...(config.vars ?? {}) };

for (const key of [
  'DEMO_LOGIN_USERNAME',
  'DEMO_LOGIN_PASSWORD',
  'ALLOW_DEMO_LOGIN',
  'MONITOR_SESSION_SECRET',
  'ACCOUNT_ADMIN_URL',
  'ACCOUNT_ADMIN_INTERNAL_KEY',
  'DG_RELAY_URL',
  'DG_RELAY_PUBLIC_URL',
  'DG_RELAY_API_KEY',
]) {
  const value = process.env[key];
  if (value) vars[key] = value;
}

config.vars = vars;
await writeFile(configPath, `${JSON.stringify(config)}\n`, 'utf8');
