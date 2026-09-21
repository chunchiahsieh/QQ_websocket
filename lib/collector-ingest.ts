import { runtimeEnv } from '@/lib/runtime-env';

// The desktop collector is a machine role, not a browser viewer.  It uses a
// separate secret so it never needs to replay a browser session cookie.
export const isCollectorIngestAuthorized = (request: Request) => {
  const expected = runtimeEnv('COLLECTOR_INGEST_KEY');
  const supplied = request.headers.get('X-Collector-Ingest-Key');
  if (!expected || expected.length < 32 || !supplied || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
};
