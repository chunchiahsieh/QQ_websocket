import { runtimeEnv } from '@/lib/runtime-env';

// Render's `fromService: hostport` value intentionally omits a scheme, while
// URL() requires one. Normalise it in one place so local and private-network
// deployments cannot accidentally fall back to localhost.
export const accountAdminBaseUrl = () => {
  const configured = runtimeEnv('ACCOUNT_ADMIN_URL')?.trim();
  if (!configured) return 'http://127.0.0.1:5092';
  return /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
};
