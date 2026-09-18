import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Render exposes service variables to the Node process, while Wrangler's
// Worker runtime needs them as bindings. Bridge the two at process start.
const configPath = 'dist/server/wrangler.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const vars = { ...(config.vars ?? {}) };
// Render's service variables are normally forwarded here. Keep the demo
// credentials as a service-local fallback as well: Wrangler can run the
// Worker behind an internal host where the public Render hostname is absent.
vars.DEMO_LOGIN_USERNAME = process.env.DEMO_LOGIN_USERNAME || vars.DEMO_LOGIN_USERNAME || 'jason';
vars.DEMO_LOGIN_PASSWORD = process.env.DEMO_LOGIN_PASSWORD || vars.DEMO_LOGIN_PASSWORD || '123456';
if (process.env.MONITOR_SESSION_SECRET) vars.MONITOR_SESSION_SECRET = process.env.MONITOR_SESSION_SECRET;
for (const key of ['DG_RELAY_URL', 'DG_RELAY_PUBLIC_URL', 'DG_RELAY_API_KEY']) {
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
