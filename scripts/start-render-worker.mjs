import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Render exposes service variables to the Node process, while Wrangler's
// Worker runtime needs them as bindings. Bridge the two at process start.
const configPath = 'dist/server/wrangler.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const vars = { ...(config.vars ?? {}) };
for (const key of ['DEMO_LOGIN_USERNAME', 'DEMO_LOGIN_PASSWORD', 'MONITOR_SESSION_SECRET']) {
  const value = process.env[key];
  if (value) vars[key] = value;
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
