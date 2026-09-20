import { runtimeEnv } from '@/lib/runtime-env';

export type CollectorCredentials = { username: string; password: string };

// These credentials are only ever returned to a browser that already holds a
// collector-specific encrypted session. Normal viewer sessions cannot read
// them. The browser uses them solely for its direct official-platform login.
export const configuredCollectorCredentials = (): CollectorCredentials | null => {
  const username = (runtimeEnv('SYSTEM_LOGIN_USERNAME')
    || runtimeEnv('DEMO_LOGIN_USERNAME')
    || runtimeEnv('NEXT_PUBLIC_TZ_USERNAME'))?.trim();
  const password = runtimeEnv('SYSTEM_LOGIN_PASSWORD')
    || runtimeEnv('DEMO_LOGIN_PASSWORD')
    || runtimeEnv('NEXT_PUBLIC_TZ_PASSWORD');
  return username && password ? { username, password } : null;
};

export const isConfiguredCollectorAccount = (username: string, password: string) => {
  const configured = configuredCollectorCredentials();
  return Boolean(configured && username === configured.username && password === configured.password);
};

export const hasCollectorBootstrapKey = (candidate: string | null) => {
  const configured = runtimeEnv('COLLECTOR_BOOTSTRAP_KEY');
  if (!configured || !candidate || configured.length < 32 || candidate.length !== configured.length) return false;
  let difference = 0;
  for (let index = 0; index < configured.length; index += 1) difference |= configured.charCodeAt(index) ^ candidate.charCodeAt(index);
  return difference === 0;
};
