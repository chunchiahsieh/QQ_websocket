import { runtimeEnv } from '@/lib/runtime-env';

// Encrypted HttpOnly sessions; development sessions expire on server restart.
// Keep the random fallback lazy. Cloudflare Workers disallow calls that use
// randomness at module/global scope, which otherwise makes every API route
// fail before its handler runs (including login).
let localSecret: string | undefined;
const getLocalSecret = () => {
  if (!localSecret) localSecret = crypto.randomUUID();
  return localSecret;
};
const cookieName = 'monitor_session';
export type MonitorSession = {
  expires: number;
  dgDirectLogin?: boolean;
  dgToken?: string;
  dgGameUrl?: string;
  dgError?: string;
  accountId?: string;
  accountUsername?: string;
  accountStamp?: string;
};
async function key() {
  const secret = runtimeEnv('MONITOR_SESSION_SECRET') || (process.env.NODE_ENV !== 'production' ? getLocalSecret() : '');
  if (!secret) throw new Error('Missing session secret');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => new Uint8Array(value.match(/../g)!.map(v => parseInt(v, 16)));
export async function sessionCookie(request: Request, platform: Omit<MonitorSession, 'expires'> = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ ...platform, expires: Date.now() + 3600000 }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), payload);
  const value = `${hex(iv.buffer)}.${hex(encrypted)}`;
  if (value.length > 3800) throw new Error('Session too large');
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function readSession(request: Request): Promise<MonitorSession | null> {
  try {
    const value = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!value || value.length > 3800) return null;
    const [iv, encrypted, extra] = value.split('.');
    if (extra || !/^[a-f0-9]{24}$/.test(iv) || !/^(?:[a-f0-9]{2}){16,}$/.test(encrypted)) return null;
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv) }, await key(), unhex(encrypted));
    const session = JSON.parse(new TextDecoder().decode(bytes)) as MonitorSession;
    return Number.isFinite(session.expires) && session.expires > Date.now() ? session : null;
  } catch { return null; }
}
export async function hasSession(request: Request) { return !!await readSession(request); }
