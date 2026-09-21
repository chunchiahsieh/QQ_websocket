import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Render exposes service variables to the Node process, while Wrangler's
// Worker runtime needs them as bindings. Bridge the two at process start.
const configPath = 'dist/server/wrangler.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const vars = { ...(config.vars ?? {}) };
// Demo credentials are opt-in. Never manufacture a fallback account in a
// deployed Worker: AccountAdmin is the production authority for system users.
for (const key of ['ALLOW_DEMO_LOGIN', 'DEMO_LOGIN_USERNAME', 'DEMO_LOGIN_PASSWORD']) {
  if (process.env[key]) vars[key] = process.env[key];
}
if (process.env.MONITOR_SESSION_SECRET) vars.MONITOR_SESSION_SECRET = process.env.MONITOR_SESSION_SECRET;
for (const key of [
  'ACCOUNT_ADMIN_URL',
  'ACCOUNT_ADMIN_INTERNAL_KEY',
  'DG_RELAY_URL',
  'DG_RELAY_PUBLIC_URL',
  'DG_RELAY_API_KEY',
  'COLLECTOR_BOOTSTRAP_KEY',
  // Desktop collectors authenticate snapshots with a separate machine key.
  // Wrangler dev receives only values explicitly copied into `config.vars`.
  'COLLECTOR_INGEST_KEY',
]) {
  if (process.env[key]) vars[key] = process.env[key];
}
config.vars = vars;
await writeFile(configPath, `${JSON.stringify(config)}\n`, 'utf8');

const port = process.env.PORT || '8787';
const child = spawn('npx', ['wrangler', 'dev', '--config', configPath, '--ip', '0.0.0.0', '--port', port], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
